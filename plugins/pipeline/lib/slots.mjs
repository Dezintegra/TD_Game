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
 * Пул по умолчанию: один исполнитель на всё.
 *
 * Слотов было четыре — два рабочих, ревью и одиночка для замеров
 * и выкладки, — и половина машинерии существовала только ради того, чтобы
 * они не мешали друг другу: классы этапов, две квоты в настройке, правило
 * «исключительный этап ждёт тишины во всём пуле».
 *
 * Всё это снято сознательно. Один исполнитель делает тишину на машине
 * свойством устройства, а не правилом, которое надо соблюдать: замер кадров
 * не может оказаться рядом с чужой сборкой, потому что рядом нет никого.
 *
 * Плата названа честно: прогоны арены теперь идут по очереди, а не по два.
 * Шесть минут на прогон, десяток прогонов — час вместо получаса. Это дешевле
 * той беды, которую параллельность приносила: сканер брал в работу больше
 * задач, чем есть исполнителей, лишние вставали в этапе без сессии и через
 * полчаса объявлялись мёртвыми. 27–28.08.2026 так сгорело семнадцать задач
 * за ночь — парами, в одну и ту же секунду.
 */
export const DEFAULT_SLOTS = [
  { name: 'worker', accepts: ['resource', 'waiting', 'review', 'exclusive'] },
];

/** Свободен ли слот: назначения нет либо оно уже отработано. */
const isFree = (slot, occupancy) => !occupancy[slot.name];

/**
 * Найти запертые слоты.
 *
 * Слот считается запертым, если назначение висит в нём дольше нескольких
 * циклов, а сессия исполнителя числится идущей и молчит. Так выглядит
 * неотвеченный запрос подтверждения: сессия жива, но ничего не делает
 * и не завершится никогда, а её задача планировщика при этом не запустится
 * снова — незавершённый прогон не даёт начать следующий.
 *
 * Прекратить такую сессию конвейер не может: это вправе только человек.
 * Поэтому запертый слот не получает работы и называется вслух.
 */
export function lockedSlots({ occupancy = {}, sessions = [], now, config, sessionsKnown = true }) {
  if (!sessionsKnown) return [];

  const stuckAfter = config.cycleMinutes * 3;
  const locked = [];

  for (const [name, assignment] of Object.entries(occupancy)) {
    if (!assignment) continue;
    const waiting = (Date.parse(now) - Date.parse(assignment.assignedAt)) / 60000;
    if (Number.isNaN(waiting) || waiting < stuckAfter) continue;

    const session = sessions.find((item) => item.title === assignment.sessionTitle);
    if (!session?.isRunning) continue;

    const silent = (Date.parse(now) - Date.parse(session.lastActivityAt)) / 60000;
    if (Number.isNaN(silent) || silent < config.deadAfterMinutes) continue;

    locked.push({
      slot: name,
      taskId: assignment.taskId,
      why:
        `назначение висит ${Math.round(waiting)} мин, сессия числится идущей и молчит ` +
        `${Math.round(silent)} мин. Похоже на неотвеченный запрос подтверждения: ` +
        'прекратить сессию может только человек',
    });
  }

  return locked;
}

/**
 * Найти назначения, которых никто не берёт.
 *
 * Исполнитель отмечает взятие полем `startedAt` на ближайшем пробуждении,
 * а ходит он по тому же расписанию, что и оркестратор. Значит назначение,
 * пролежавшее нетронутым несколько циклов подряд, означает одно из двух:
 * задача планировщика этого исполнителя выключена либо не запускается.
 *
 * Починить это конвейер не может — задачами планировщика он не управляет
 * намеренно. Но и молчать нельзя: 27.08.2026 задача 0008 пролежала так
 * восемьдесят минут в слоте выключенного исполнителя, сожгла на пустых
 * продолжениях обе попытки и была остановлена «за исчерпанием». Со стороны
 * это выглядело как занятый слот, то есть как честная очередь.
 */
export function unclaimedSlots({ occupancy = {}, now, config }) {
  const staleAfter = config.cycleMinutes * 3;

  return Object.entries(occupancy)
    .filter(([, assignment]) => assignment && !assignment.startedAt)
    .map(([name, assignment]) => ({
      slot: name,
      taskId: assignment.taskId,
      waiting: (Date.parse(now) - Date.parse(assignment.assignedAt)) / 60000,
    }))
    .filter((item) => !Number.isNaN(item.waiting) && item.waiting >= staleAfter)
    .map((item) => ({
      ...item,
      why:
        `назначение лежит ${Math.round(item.waiting)} мин и не взято. ` +
        'Исполнитель ходит раз в ' +
        `${config.cycleMinutes} мин — похоже, его задача планировщика выключена ` +
        'или не запускается. Проверьте перечень задач планировщика',
    }));
}

/**
 * Найти назначения, разошедшиеся с бэклогом.
 *
 * Слот освобождает тот, кто перенёс отчёт, — и только он. Дорог к выходу
 * из этапа, однако, больше: задачу закрывает опрос внешнего состояния,
 * возвращает в работу ответ владельца продукта, закрывает уборка, а
 * перенос отчёта может и вовсе оборваться посреди дела. Ни один из этих
 * путей слота не трогал, и назначение оставалось висеть на задаче, которой
 * давно нет дела до этого этапа.
 *
 * Стоило это дорого: слот `worker-1` завис на закрытой задаче `0001`, и
 * конвейер три часа отвечал «свободного слота нет» при пустом пуле. Отсюда
 * сверка не по одному пути, а по признаку: назначение годно, пока задача
 * стоит ровно в том состоянии, на которое оно выдано.
 *
 * Запертые слоты не трогаются намеренно. Там сессия числится идущей: снять
 * назначение значило бы выдать слот второй сессии, которая всё равно
 * не запустится — незавершённый прогон не даёт начать следующий.
 */
export function staleAssignments({ occupancy = {}, tasks = {}, locked = [] }) {
  const lockedNames = new Set(locked.map((item) => item.slot));
  const stale = [];

  for (const [name, assignment] of Object.entries(occupancy)) {
    if (!assignment || lockedNames.has(name)) continue;

    const task = tasks[assignment.taskId];
    if (!task) {
      stale.push({
        slot: name,
        taskId: assignment.taskId,
        why: 'задачи нет в бэклоге',
      });
      continue;
    }
    if (task.status !== assignment.stage) {
      stale.push({
        slot: name,
        taskId: assignment.taskId,
        why: `назначение на этап «${assignment.stage}», а задача уже в «${task.status}»`,
      });
    }
  }

  return stale;
}

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
 * @param {object[]} params.locked    запертые слоты: заняты, пока не вмешается человек
 * @param {object[]} params.stale     назначения, разошедшиеся с бэклогом
 * @returns {{ writes: object[], waiting: object[], notes: string[] }}
 */
export function planAssignments({
  actions,
  tasks,
  occupancy = {},
  slots = DEFAULT_SLOTS,
  now,
  locked = [],
  stale = [],
}) {
  const writes = [];
  const waiting = [];
  const notes = [];
  const taken = { ...occupancy };

  // Разошедшееся назначение считается снятым уже здесь, а не со следующего
  // цикла: иначе освобождённый слот простоял бы пять минут впустую.
  for (const item of stale) {
    delete taken[item.slot];
    notes.push(`слот ${item.slot} освобождён от ${item.taskId}: ${item.why}`);
  }

  // Запертый слот занят навсегда, пока человек не вмешается. Считаем его
  // занятым и называем вслух — иначе конвейер будет молча недоумевать,
  // почему работа не двигается.
  for (const item of locked) {
    taken[item.slot] = taken[item.slot] ?? { taskId: item.taskId };
    notes.push(`слот ${item.slot} заперт: ${item.why}`);
  }

  const needsSession = actions.filter((action) =>
    ['start-stage', 'continue-stage'].includes(action.kind),
  );

  for (const action of needsSession) {
    const task = tasks[action.taskId];
    if (!task) {
      notes.push(`назначение по задаче ${action.taskId}, которой нет в бэклоге`);
      continue;
    }

    const kind = stateClass({ ...task, status: action.stage });

    // Правила «исключительный этап ждёт тишины во всём пуле» больше нет:
    // исполнитель один, и тишина при нём — свойство устройства, а не правило.

    // Задача, уже занимающая слот, возвращается в НЕГО ЖЕ, а не ищет
    // свободный. Иначе продолжатель за умершей сессией не находил слота
    // никогда: единственный подходящий занят самой этой задачей, и она
    // ждала бы освобождения от самой себя. Так и заклинило 0002 —
    // назначение помечено взятым, сессии давно нет, подхватить нечем.
    //
    // Перезапись назначения и есть починка: у нового нет отметки о взятии,
    // и ближайшее пробуждение исполнителя возьмёт его как новое.
    const own = slots.find((item) => taken[item.name]?.taskId === task.id);

    // Невзятое назначение вторым не перебивают. Исполнитель отмечает взятие
    // полем `startedAt`; пока его нет, работа просто ещё не дошла до своего
    // пробуждения. Выдать поверх неё второе назначение значит сжечь попытку
    // продолжения впустую — а их две, и после второй задача встаёт.
    //
    // Так и сгорели 0005 и 0006: два продолжения выданы подряд, ни одно
    // не взято ни одной сессией, задача остановлена «за исчерпанием
    // продолжений», которых на деле не было ни одного.
    if (own && !taken[own.name].startedAt && action.kind === 'continue-stage') {
      waiting.push({ ...action, reason: 'прежнее назначение ещё не взято исполнителем' });
      continue;
    }

    const slot = own ?? slots.find((item) => item.accepts.includes(kind) && isFree(item, taken));
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
