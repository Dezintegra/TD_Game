import { CROSSCUT, canTransition } from '../config/transitions.mjs';

/**
 * Правка записи задачи.
 *
 * Отдельно от всего, что трогает диск, и намеренно: превращение задачи
 * из одного состояния в другое — самое важное, что делает конвейер, и оно
 * обязано проверяться без файлов, git и сессий.
 *
 * Запись никогда не переписывается целиком по памяти: новое состояние
 * получается из прежнего, и всё, чего правка не касается, остаётся нетронутым.
 * Иначе поле, о котором забыли, тихо исчезнет при первом же переходе.
 */

/** Сколько записей истории хранить. Дальше — уже археология, а не работа. */
const HISTORY_LIMIT = 100;

/**
 * Перевести задачу в новое состояние.
 *
 * @param {object} task    запись бэклога
 * @param {object} change  `{ status, note, now }`
 * @returns {{ task: object|null, problems: string[] }}
 */
export function applyTransition(task, { status, note, now }) {
  const verdict = canTransition(task, status);
  if (!verdict.ok) {
    return { task: null, problems: [verdict.reason] };
  }

  // Состояние возврата хранится только у сквозных состояний: из них задача
  // возвращается туда, откуда ушла. У рабочих оно всегда пусто, иначе старое
  // значение однажды уведёт задачу в давно пройденный этап.
  //
  // Сквозные при этом ходят цепочкой: `implement → postmortem → failed`.
  // Записав здесь покидаемое состояние, мы дали бы `returnTo: 'postmortem'`,
  // и человек, поднимая задачу из ошибки, вернул бы её в разбор, а не
  // в имплементацию. Поэтому из сквозного в сквозное возврат НАСЛЕДУЕТСЯ.
  const returnTo = CROSSCUT.includes(status)
    ? CROSSCUT.includes(task.status)
      ? task.returnTo
      : task.status
    : null;

  const history = [...(task.history ?? []), { at: now, from: task.status, to: status, note }].slice(
    -HISTORY_LIMIT,
  );

  // Вход в сквозное состояние обнуляет счёт попыток: там начинается новая
  // работа, и заминки прежнего этапа к ней не относятся.
  //
  // Без этого разбор не начался бы НИКОГДА. Главный путь в остановку —
  // исчерпание продолжений, и задача приходит в разбор ровно с этим счётом;
  // сессию же разбору выдаёт то самое действие, которое смотрит на счётчик.
  // Сканер объявил бы разбор провалившимся прежде первой его сессии.
  const attempts = CROSSCUT.includes(status)
    ? { continuations: 0, cycleFailures: 0, rejections: 0, spawnFailures: 0 }
    : task.attempts;

  return {
    task: { ...task, status, returnTo, attempts, statusChangedAt: now, history },
    problems: [],
  };
}

/**
 * Захватить задачу за этой машиной.
 *
 * Захват — отдельная правка и отдельный коммит: он касается только полей
 * одной задачи, и потому отказ отправки при гонке относится ровно к спорной
 * задаче, а не ко всему, что цикл успел сделать.
 */
export function claimTask(task, { machine, status, now }) {
  if (task.owner && task.owner !== machine) {
    return { task: null, problems: [`задача занята машиной ${task.owner}`] };
  }
  const moved = applyTransition(task, { status, note: `взята в работу машиной ${machine}`, now });
  if (!moved.task) return moved;
  return { task: { ...moved.task, owner: machine }, problems: [] };
}

/** Снять захват: задачу занял кто-то другой, и она больше не наша. */
export function releaseClaim(task) {
  return { ...task, owner: null };
}

/** Отметить, что этап пришлось продолжать за уснувшей сессией. */
export function countContinuation(task) {
  const attempts = task.attempts ?? { continuations: 0, cycleFailures: 0 };
  return { ...task, attempts: { ...attempts, continuations: attempts.continuations + 1 } };
}

/**
 * Отметить, что процесс этапа породить не удалось.
 *
 * Счёт ведётся отдельно от продолжений намеренно. Продолжение стоит сессии:
 * денег, времени этапа, круга работы. Несостоявшийся запуск не стоит ничего,
 * кроме строки в журнале, — и лечится он не новой сессией, а настройкой.
 * Смешав их, разбор пойдёт искать причину в сессии, которой не было: так
 * задачи 0043, 0062, 0022 и 0088 ушли в ошибку с ложной уликой.
 */
export function countSpawnFailure(task) {
  const attempts = task.attempts ?? { continuations: 0, cycleFailures: 0 };
  return { ...task, attempts: { ...attempts, spawnFailures: (attempts.spawnFailures ?? 0) + 1 } };
}

/**
 * Отметить, что проверяющий этап вернул работу.
 *
 * Счёт ведётся ПОДРЯД идущим возвратам и обнуляется, как только проверка
 * пройдена: задача, однажды поспорившая с аудитом, не должна тащить этот
 * счёт через ревью и упереться в предел там, где всё было хорошо.
 */
export function countRejection(task) {
  const attempts = task.attempts ?? { continuations: 0, cycleFailures: 0 };
  // Продолжения гасятся, как при успехе: они считают сессии НА ЭТАПЕ, а возврат
  // отправляет задачу на другой этап. Пока счёт тащился через возврат, задача
  // приходила в проработку с чужим счётом и останавливалась там, не получив
  // ни одной сессии: 02.09.2026 так легли 0022, 0080 и 0088 (карточка 0081).
  // Спор считается своим счётчиком, и мешать их нельзя.
  return {
    ...task,
    attempts: {
      continuations: 0,
      cycleFailures: 0,
      spawnFailures: 0,
      rejections: (attempts.rejections ?? 0) + 1,
    },
  };
}

/**
 * Сбросить счётчики: этап дошёл до конца, и прошлые заминки больше не в счёт.
 *
 * Без сброса задача, однажды пережившая уснувшую сессию, тащила бы этот счёт
 * через все оставшиеся этапы и упёрлась бы в предел там, где всё было хорошо.
 */
export function resetAttempts(task) {
  return {
    ...task,
    attempts: { continuations: 0, cycleFailures: 0, rejections: 0, spawnFailures: 0 },
  };
}

/** Записать ссылку на порождённый артефакт, не трогая остальных. */
export function linkArtifact(task, key, value) {
  return { ...task, links: { ...task.links, [key]: value } };
}

/** Связать задачу с другой в обе стороны — вызывающий правит обе записи. */
export function relate(task, otherId) {
  const related = task.links?.related ?? [];
  if (related.includes(otherId)) return task;
  return { ...task, links: { ...task.links, related: [...related, otherId] } };
}
