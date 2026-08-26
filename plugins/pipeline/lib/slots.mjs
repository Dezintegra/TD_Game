import { stateClass } from '../config/transitions.mjs';

/**
 * Слоты исполнителей: куда оркестратор кладёт назначение.
 *
 * Исполнители — постоянный пул задач планировщика, заведённый один раз
 * руками. Создавать задачи планировщика на ходу нельзя: этот вызов требует
 * подтверждения человека при каждом обращении и не предлагает разрешить его
 * навсегда, поэтому автономный запуск на нём встаёт насмерть. Проверено
 * и документацией, и пробой 26.08.2026.
 *
 * Отсюда и устройство: оркестратор пишет назначение в файл слота, а
 * исполнитель на ближайшем пробуждении свой слот читает. Пустой слот
 * завершает сессию немедленно — ни бэклога, ни реестра он при этом
 * не открывает.
 *
 * Побочная выгода важнее самой починки: квота перестала быть числом
 * в настройке и стала числом слотов. Считать нечего — слот либо свободен,
 * либо нет.
 */

/**
 * Пул по умолчанию.
 *
 * Два рабочих слота — это и есть предел «не больше двух ресурсных задач».
 * Ревью отведён свой, потому что замечания к чужому коду не делятся между
 * сессиями. Одиночка берёт исключительные этапы — замер кадров и выкладку, —
 * и берёт их только когда все прочие слоты пусты: цифра, снятая под
 * нагрузкой, говорит о нагрузке, а не о коде.
 */
export const DEFAULT_SLOTS = [
  { name: 'worker-1', accepts: ['resource', 'waiting'] },
  { name: 'worker-2', accepts: ['resource', 'waiting'] },
  { name: 'review', accepts: ['review'] },
  { name: 'solo', accepts: ['exclusive'] },
];

/** Слоты, чья занятость мешает начать исключительный этап. */
const BUSY_FOR_EXCLUSIVE = ['resource', 'review'];

/** Свободен ли слот: назначения нет либо оно уже отработано. */
const isFree = (slot, occupancy) => !occupancy[slot.name];

/**
 * Разложить действия сканера по слотам.
 *
 * Принимает только то, что требует сессии-исполнителя: начать этап или
 * подхватить его за уснувшей. Прочие действия оркестратор делает сам,
 * и слот им не нужен.
 *
 * @param {object} params
 * @param {object[]} params.actions   действия сканера
 * @param {object}   params.tasks     задачи по идентификатору
 * @param {object}   params.occupancy занятость слотов: `{ имяСлота: назначение }`
 * @param {object[]} params.slots     состав пула
 * @param {string}   params.now       отметка времени
 * @returns {{ writes: object[], waiting: object[], notes: string[] }}
 */
export function planAssignments({ actions, tasks, occupancy = {}, slots = DEFAULT_SLOTS, now }) {
  const writes = [];
  const waiting = [];
  const notes = [];
  const taken = { ...occupancy };

  const needsSession = actions.filter((action) =>
    ['start-stage', 'continue-stage'].includes(action.kind),
  );

  // Занятость считается по всему пулу разом: исключительный этап начинают
  // только в полной тишине, а не «когда мой слот свободен».
  const busyKinds = () =>
    slots
      .filter((slot) => taken[slot.name])
      .flatMap((slot) => slot.accepts)
      .filter((kind) => BUSY_FOR_EXCLUSIVE.includes(kind));

  for (const action of needsSession) {
    const task = tasks[action.taskId];
    if (!task) {
      notes.push(`назначение по задаче ${action.taskId}, которой нет в бэклоге`);
      continue;
    }

    const kind = stateClass({ ...task, status: action.stage });

    if (kind === 'exclusive' && busyKinds().length > 0) {
      waiting.push({ ...action, reason: 'исключительный этап ждёт тишины во всём пуле' });
      continue;
    }

    const slot = slots.find((item) => item.accepts.includes(kind) && isFree(item, taken));
    if (!slot) {
      waiting.push({ ...action, reason: `свободного слота для «${kind}» нет` });
      continue;
    }

    const assignment = {
      taskId: task.id,
      stage: action.stage,
      branch: `worktree-${task.id}`,
      assignedAt: now,
      sessionTitle: `pipeline:${task.id}:${action.stage}`,
      continuation: action.kind === 'continue-stage',
      reason: action.reason ?? null,
    };
    taken[slot.name] = assignment;
    writes.push({ slot: slot.name, assignment });
  }

  return { writes, waiting, notes };
}

/**
 * Что делать исполнителю, проснувшемуся по расписанию.
 *
 * Ответ считается по одному прочитанному файлу и намеренно ничего больше
 * не открывает: холостое пробуждение обязано стоить секунды, а их за сутки
 * набегают сотни.
 */
export function whatToDo(assignment) {
  if (!assignment) return { act: false, why: 'слот пуст' };
  if (assignment.startedAt) return { act: false, why: 'назначение уже взято в работу' };
  return { act: true, why: 'есть назначение', assignment };
}
