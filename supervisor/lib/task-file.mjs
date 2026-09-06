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
    ? { continuations: 0, cycleFailures: 0, rejections: 0, spawnFailures: 0, apiErrors: 0 }
    : task.attempts;

  // Вход в разбор стирает прошлый вердикт, но не счёт возвратов. Вердикт
  // относится к прошлому падению: задача, упавшая снова и не дождавшаяся
  // нового (разбор сам не удался и ушёл в ошибку без отчёта), вернулась бы
  // по старому. Счёт же — предохранитель на всю жизнь задачи, и обнулять
  // его вместе с попытками значило бы отменить его вовсе.
  const recovery =
    status === 'postmortem' && task.recovery
      ? { causedBy: null, fixedBy: [], returns: task.recovery.returns ?? 0 }
      : task.recovery;

  return {
    task: {
      ...task,
      status,
      returnTo,
      attempts,
      statusChangedAt: now,
      history,
      ...(recovery ? { recovery } : {}),
    },
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
 * Вернуть задаче продолжение, потраченное на заход, которого не было.
 *
 * Продолжение списывается при рождении процесса, и это правильно: требование
 * «Продолжение засчитывается за родившийся процесс» держится именно на этом.
 * Но процесс, умерший от отказа сервера модели, родился и не сделал ни одного
 * хода — списание оказалось платой за чужую беду. 03.09.2026 задачи 0153
 * и 0165 потеряли так по два продолжения из двух и ушли в разбор, где разбор
 * умер тем же 529.
 *
 * Событий два, и правила у них разные: отказ порождения не списывает вовсе,
 * отказ сервера списывает и возвращает.
 *
 * Ниже нуля счёт не уходит. Не из осторожности: задача, взятая из очереди
 * впервые, продолжений не тратила, а первый же её этап может лечь на 529, —
 * и отрицательный счёт дал бы ей лишнюю попытку в обход предела.
 */
export function refundContinuation(task) {
  const attempts = task.attempts ?? { continuations: 0, cycleFailures: 0 };
  return {
    ...task,
    attempts: { ...attempts, continuations: Math.max(0, attempts.continuations - 1) },
  };
}

/**
 * Отметить, что этап лёг на отказе сервера модели.
 *
 * Счёт свой, а не общий с продолжениями: те возвращаются, и по ним длину
 * полосы отказов не узнать. Нужен именно счёт подряд идущих отказов — по нему
 * взводится пауза сервера.
 *
 * Обнуляется он живым ответом (`resetApiErrors`). Без обнуления счёт копится
 * за сутки и однажды взводит паузу по трём отказам, разделённым часами
 * работы, — то есть по картине, которой не было.
 */
export function countApiError(task) {
  const attempts = task.attempts ?? { continuations: 0, cycleFailures: 0 };
  return { ...task, attempts: { ...attempts, apiErrors: (attempts.apiErrors ?? 0) + 1 } };
}

/** Погасить счёт отказов сервера: этап ответил, значит полоса кончилась. */
export function resetApiErrors(task) {
  const attempts = task.attempts ?? { continuations: 0, cycleFailures: 0 };
  return { ...task, attempts: { ...attempts, apiErrors: 0 } };
}

/**
 * Прибавить к израсходованному на задачу.
 *
 * Поле лежит ВНЕ `attempts`, и это главное решение всей меры. `attempts`
 * обнуляется в трёх местах: `resetAttempts` на всяком удавшемся этапе,
 * `countRejection` при возврате и вход в сквозное состояние. Предел спора
 * умер ровно поэтому — между каждой парой отказов аудита стоял удачный отчёт
 * проработки, и счётчик гасился на каждом втором шаге (задача 0216, шесть
 * кругов и $76 при пределе три).
 *
 * Положить сюда же расход значило бы повторить ту же ошибку слово в слово.
 * Расход — предохранитель на всю жизнь задачи, как `recovery.returns`, и его
 * не гасит ничто.
 *
 * Стоимость приходит из ответа приложения и бывает не названа вовсе; тогда
 * она равна нулю. Отрицательной она не бывает, и защита здесь не от жизни,
 * а от чужой ошибки: вычесть из расхода нельзя ничем.
 */
export function addSpent(task, usd) {
  const spent = Number.isFinite(task.spentUsd) ? task.spentUsd : 0;
  const add = Number.isFinite(usd) && usd > 0 ? usd : 0;
  return { ...task, spentUsd: spent + add };
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
      apiErrors: 0,
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
    attempts: { continuations: 0, cycleFailures: 0, rejections: 0, spawnFailures: 0, apiErrors: 0 },
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
