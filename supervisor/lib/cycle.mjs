import { catchUp, cycleMayFinish, handleTail } from './push-discipline.mjs';
import { lockVerdict, newLock } from './lock.mjs';
import { scan } from './scan.mjs';

/**
 * Один цикл оркестратора.
 *
 * Порядок здесь жёсткий и выбран не из вкуса, а по следам того, чем каждое
 * нарушение оборачивается:
 *
 * 1. замок — иначе два экземпляра разом пишут один бэклог;
 * 2. рубильник паузы — человек должен уметь остановить конвейер одним файлом;
 * 3. хвост главной ветки — деревья ответвляются от удалённой ветки, и заводить
 *    их поверх неотправленного значит заводить без последних коммитов;
 * 4. картина мира с диска;
 * 5. сканер — детерминированный счёт, что делать;
 * 6. исполнение;
 * 7. сторож завершения — в главной ветке не осталось неотправленного.
 *
 * Раскладки по слотам здесь больше нет. Слоты существовали потому, что
 * решал один, а работал другой: передать назначение иначе как через диск
 * они не могли. Теперь порождает тот же, кто решает, — и квота вырождается
 * в счёт живых дочерних процессов.
 *
 * Сам цикл ничего не исполняет: он решает и отдаёт список. Исполнитель
 * приходит доводом, поэтому весь порядок проверяется без единого настоящего
 * коммита, дерева и сессии.
 */

/** Чем цикл закончился. */
export const CYCLE = {
  locked: 'замок держит другой цикл',
  paused: 'взведён рубильник паузы',
  'api-paused': 'сервер модели не отвечает',
  idle: 'работы нет',
  blocked: 'записи невозможны',
  worked: 'работа выдана',
};

/**
 * Прокрутить цикл.
 *
 * @param {object} deps
 * @param {object} deps.git        набор команд git
 * @param {object} deps.state      уже прочитанная картина мира
 * @param {object} deps.config     настройка
 * @param {string} deps.now        отметка времени начала цикла
 * @param {number} deps.pid        номер процесса — для замка
 * @param {object|null} deps.lock  содержимое замка, если он есть
 * @param {(pid:number)=>boolean} [deps.isAlive] жив ли процесс, взявший замок
 * @param {string[]} deps.ourAuthors чьи коммиты конвейер считает своими
 * @param {() => number} deps.elapsed сколько секунд идёт цикл
 * @returns {{ outcome, actions, notes, lock }}
 */
export function runCycle({ git, state, config, now, pid, lock, isAlive, ourAuthors, elapsed }) {
  const notes = [];
  const nothing = (outcome) => ({ outcome, actions: [], notes, lock: null });

  // 1. Замок.
  const verdict = lockVerdict(lock, now, config.lockStaleMinutes, isAlive);
  if (!verdict.take) {
    notes.push(verdict.why);
    return nothing('locked');
  }
  if (lock) notes.push(verdict.why);
  const held = newLock(pid, now);

  // 2. Паузы. Проверяются до всего прочего, чтобы остановка была мгновенной
  //    и не зависела ни от сети, ни от состояния дерева.
  //
  //    Причина называется поимённо, и это не оформление. Одна строка
  //    на два случая была бы прямо вредна: по ней нельзя решить, надо ли
  //    что-то делать. Ждущий человека конвейер требует человека, ждущий
  //    сервер не требует никого.
  //
  //    Человек проверяется первым: его рубильник снимается только руками,
  //    значит именно он определяет, когда работа пойдёт, — даже если сервер
  //    уже ответил.
  if (state.paused) {
    notes.push('взведён рубильник паузы: ничего не порождаем');
    // Вторая причина называется тоже: снимет её автомат сам, но человек,
    // глядя в журнал, обязан видеть обе — иначе, сняв свою паузу, он ждёт
    // работы, которой не будет, пока молчит сервер.
    if (state.apiPaused) notes.push('и сервер модели не отвечает');
    return { ...nothing('paused'), lock: held };
  }
  if (state.apiPaused) {
    notes.push('сервер модели не отвечает: работы не берём, пробуем по расписанию');
    return { ...nothing('api-paused'), lock: held };
  }

  // 3. Хвост главной ветки. Область блокировки узкая: он держит записи
  //    в главную ветку и заведение деревьев, но не мешает читать и опрашивать.
  const tail = handleTail({
    git,
    branch: config.mainBranch,
    ourAuthors,
    elapsed,
    budgetSeconds: config.pushBudgetSeconds,
  });
  notes.push(...tail.notes);

  const mayWrite = ['clean', 'pushed'].includes(tail.outcome);
  if (!mayWrite) {
    notes.push(`записи в главную ветку отложены: ${tail.outcome}`);
  }

  // 3б. Отставание. Подтягивается после досылки хвоста и только в чистом
  //     дереве. Без этого шага основное дерево живёт состоянием своего
  //     последнего ручного обновления, и конвейер запускает вчерашний код —
  //     на первом же живом прогоне он не нашёл в дереве собственного плагина.
  const caught = catchUp({ git, branch: config.mainBranch, hasTail: !mayWrite });
  notes.push(...caught.notes);

  // 4–5. Что делать. Сканер работает и при запрете записей: опрос проверок,
  //      порождение продолжателей и чтение картины мира от этого не зависят.
  const decision = scan({ ...state, now, config });
  notes.push(...decision.notes);

  const actions = mayWrite
    ? decision.actions
    : decision.actions.filter((action) => !WRITES_TO_MAIN.includes(action.kind));

  if (actions.length === 0) {
    return { ...nothing(mayWrite ? 'idle' : 'blocked'), lock: held };
  }

  return { outcome: 'worked', actions, notes, lock: held };
}

/**
 * Действия, которые пишут в главную ветку. При запрете записей они
 * откладываются, а всё остальное продолжает работать.
 */
const WRITES_TO_MAIN = [
  'transfer-report',
  'answer-question',
  'return-task',
  'start-stage',
  'fail-stage',
];

/**
 * Вправе ли цикл завершиться.
 *
 * Отдельной проверкой в конце, потому что неотправленный коммит, оставленный
 * при выходе, к следующему пробуждению станет уже чужой находкой: сверка
 * увидит хвост и не сможет отличить свой недосмотр от чужого черновика.
 */
export function finishCycle(git, config) {
  return cycleMayFinish(git, config.mainBranch);
}
