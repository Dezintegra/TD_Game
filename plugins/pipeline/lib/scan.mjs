import { canTransition, stateClass } from '../config/transitions.mjs';

/**
 * Сканер: что конвейеру делать прямо сейчас.
 *
 * Это чистый счёт от состояния мира к перечню действий. Ни файлов, ни сети,
 * ни времени «сейчас» изнутри: всё приходит доводом. Причина не в чистоте
 * ради чистоты — при цикле в пять минут сканер запускается 288 раз в сутки,
 * и решение «есть ли работа» обязано стоить секунды и быть одинаковым
 * при одинаковой картине. Рассуждение модели ни того, ни другого не даёт.
 *
 * Сканер называет ДЕЙСТВИЕ, но не способ его выполнить. «Начать этап» —
 * это решение сканера; заводить ли под него дерево, порождать ли сессию
 * и каким именно способом — дело оркестратора. Так механика запуска может
 * смениться, не тронув здесь ни строки.
 */

/** Действия, которые сканер умеет назначать, от самого срочного к обычным. */
export const ACTIONS = [
  'push-tail', // дослать неотправленное — прежде всего прочего
  'transfer-report', // перенести отчёт сессии в бэклог
  'answer-question', // разобрать ответ владельца продукта
  'poll-external', // опросить проверки CI или прогон на чужом железе
  'cleanup', // убрать дерево и ветки завершённой задачи
  'continue-stage', // подхватить этап за уснувшей сессией
  'fail-stage', // сдаться: продолжения исчерпаны, нужен человек
  'start-stage', // взять задачу в работу
];

/** Разница во времени в минутах; `null`, если одной из отметок нет. */
function minutesBetween(later, earlier) {
  if (!later || !earlier) return null;
  return (Date.parse(later) - Date.parse(earlier)) / 60000;
}

/** Раньше берётся меньший приоритет, при равенстве — более ранняя задача. */
function byPriorityThenAge(a, b) {
  return a.priority !== b.priority
    ? a.priority - b.priority
    : Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/**
 * Куда задача идёт из очереди. Дальнейшие ветвления по исходу этапа
 * разбирает не сканер, а перенос отчёта: только там известно, чем этап
 * кончился.
 */
function firstStage(task) {
  return { feature: 'design', run: 'benchmark', note: 'triage' }[task.type];
}

/**
 * Жива ли сессия задачи.
 *
 * Уснувшая — та, у которой нет незавершённой работы и нет отчёта. Умершая —
 * та, что молчит дольше отпущенного. Для сканера разница невелика: и та,
 * и другая лечится продолжателем, потому что разбудить сессию планировщика
 * сообщением нельзя.
 */
function sessionLife(entry, session, config, now) {
  if (!session) return 'сессии нет';
  const silentFor = minutesBetween(now, session.lastActivityAt ?? entry.lastSeenAt);
  if (silentFor !== null && silentFor >= config.deadAfterMinutes)
    return 'молчит дольше отпущенного';
  if (!session.isRunning) return 'сессия завершилась без отчёта';
  return 'жива';
}

/**
 * Посчитать, что конвейеру делать.
 *
 * @param {object} state
 * @param {object[]} state.tasks     записи бэклога, прошедшие схему
 * @param {object[]} state.invalid   записи, схему не прошедшие: `{ id, problems }`
 * @param {object}   state.registry  местный реестр деревьев: `{ entries: [] }`
 * @param {object[]} state.reports   отчёты сессий, ожидающие переноса
 * @param {object[]} state.sessions  сессии: `title`, `isRunning`, `lastActivityAt`
 * @param {object}   state.tails     хвосты: `{ main, branches: { ветка: число } }`
 * @param {object}   state.answers   ответы владельца продукта: `{ идЗадачи: true }`
 * @param {string}   state.now       отметка времени начала цикла
 * @param {object}   state.config    настройка после слияния с умолчаниями
 * @param {boolean}  state.paused    взведён ли рубильник паузы
 * @returns {{ actions: object[], notes: string[] }}
 */
export function scan(state) {
  const {
    tasks = [],
    invalid = [],
    registry = { entries: [] },
    reports = [],
    sessions = [],
    tails = { main: 0, branches: {} },
    answers = {},
    now,
    config,
    paused = false,
    // Известна ли живость сессий. По умолчанию да — так проверки задают
    // картину явно, а живой цикл узнаёт правду из снимка.
    sessionsKnown = true,
  } = state;

  const actions = [];
  const notes = [];

  for (const bad of invalid) {
    notes.push(
      `задача ${bad.id} не прошла схему и в работу не берётся: ${bad.problems.join('; ')}`,
    );
  }

  if (paused) {
    notes.push('взведён рубильник паузы: конвейер не порождает работы');
    return { actions, notes };
  }

  const entryOf = (taskId) => registry.entries.find((item) => item.taskId === taskId);
  const sessionOf = (entry) => sessions.find((item) => item.title === entry?.sessionTitle);
  const hasReport = (taskId) => reports.some((report) => report.taskId === taskId);

  // 1. Хвосты. Досылаются прежде прочего, но область блокировки узкая: хвост
  //    главной ветки держит только записи в неё и заведение деревьев, хвост
  //    ветки задачи — только действия по этой задаче.
  const stuck = new Set();
  if (tails.main > 0) {
    actions.push({ kind: 'push-tail', scope: 'main', commits: tails.main });
  }
  for (const [branch, commits] of Object.entries(tails.branches ?? {})) {
    if (commits <= 0) continue;
    const entry = registry.entries.find((item) => item.branch === branch);
    if (sessionOf(entry)?.isRunning) {
      notes.push(`ветка ${branch} впереди удалённой, но на дереве живая сессия — не трогаем`);
      continue;
    }
    actions.push({ kind: 'push-tail', scope: 'branch', branch, taskId: entry?.taskId, commits });
    if (entry) stuck.add(entry.taskId);
  }

  const byId = new Map(tasks.map((task) => [task.id, task]));

  // 2. Отчёты сессий. Перенос — самое дешёвое, что двигает задачу вперёд.
  for (const report of reports) {
    if (!byId.has(report.taskId)) {
      notes.push(`отчёт по задаче ${report.taskId}, которой нет в бэклоге`);
      continue;
    }
    if (stuck.has(report.taskId)) continue;
    actions.push({
      kind: 'transfer-report',
      taskId: report.taskId,
      stage: report.stage,
      outcome: report.outcome,
    });
  }

  // 3. Ответ владельца продукта возвращает задачу в работу.
  for (const task of tasks) {
    if (task.status === 'awaiting-po' && answers[task.id]) {
      actions.push({ kind: 'answer-question', taskId: task.id, returnTo: task.returnTo });
    }
  }

  // 4. Ожидательные состояния опрашиваются: квоту они не занимают,
  //    и опрос ничего не стоит машине.
  for (const task of tasks) {
    if (stuck.has(task.id)) continue;
    if (task.status === 'pr') {
      actions.push({ kind: 'poll-external', taskId: task.id, what: 'ci' });
    } else if (task.status === 'benchmark' && stateClass(task) === 'waiting') {
      actions.push({ kind: 'poll-external', taskId: task.id, what: 'run' });
    }
  }

  // 5. Уборка. Дешёвая, сессии не требует, квоту не занимает.
  for (const task of tasks) {
    if (task.status === 'cleanup' && !stuck.has(task.id)) {
      actions.push({ kind: 'cleanup', taskId: task.id });
    }
  }

  // Занятость машины считается по тому, что уже идёт. Продолжатель места
  // не удваивает: задача уже стоит в своём состоянии и уже посчитана.
  const busyResource = tasks.filter((task) => stateClass(task) === 'resource');
  const busyReview = tasks.filter((task) => stateClass(task) === 'review');
  let machineBusy = tasks.some((task) => stateClass(task) === 'exclusive');

  // 6. Продолжатели за уснувшими и умершими сессиями.
  //
  // Если о сессиях ничего не известно — снимок не сделан, — продолжателей
  // не назначаем вовсе. Молчание не признак смерти: продолжатель,
  // порождённый по недоразумению, посадит на одно дерево две сессии,
  // и они перепишут работу друг друга.
  if (!sessionsKnown) {
    if (tasks.some((task) => ['resource', 'review', 'exclusive'].includes(stateClass(task)))) {
      notes.push('снимок сессий не сделан: о живости исполнителей ничего не известно');
    }
  }
  for (const task of sessionsKnown ? tasks : []) {
    if (!['resource', 'review', 'exclusive'].includes(stateClass(task))) continue;
    if (stuck.has(task.id) || hasReport(task.id)) continue;

    const entry = entryOf(task.id);
    if (!entry) continue; // задача в работе без записи — чинит сверка, не сканер

    const life = sessionLife(entry, sessionOf(entry), config, now);
    if (life === 'жива') continue;

    if ((task.attempts?.continuations ?? 0) >= config.maxContinuations) {
      notes.push(`задача ${task.id}: продолжения исчерпаны, нужен разбор человеком`);
      actions.push({ kind: 'fail-stage', taskId: task.id, stage: task.status, reason: life });
      continue;
    }
    actions.push({ kind: 'continue-stage', taskId: task.id, stage: task.status, reason: life });
  }

  // 7. Взятие новых задач. Здесь и только здесь действуют квоты и приоритеты.
  const queue = tasks.filter((task) => task.status === 'new').sort(byPriorityThenAge);

  // Прогоны приоритетнее: пока готов хоть один, проработка и имплементация ждут.
  const runWaiting = queue.some((task) => task.type === 'run');
  if (runWaiting) {
    notes.push('в очереди есть прогон: новых задач в проработку и имплементацию не берём');
  }

  for (const task of queue) {
    const stage = firstStage(task);
    const verdict = canTransition(task, stage);
    if (!verdict.ok) {
      notes.push(`задача ${task.id}: ${verdict.reason}`);
      continue;
    }

    const kind = stateClass({ ...task, status: stage });

    if (machineBusy) {
      notes.push(`задача ${task.id} ждёт: машина занята исключительным этапом`);
      continue;
    }
    if (kind === 'exclusive') {
      if (busyResource.length || busyReview.length) {
        notes.push(`задача ${task.id} ждёт тишины на машине`);
        continue;
      }
      actions.push({ kind: 'start-stage', taskId: task.id, stage });
      machineBusy = true;
      continue;
    }
    if (runWaiting && task.type !== 'run') continue;
    if (kind === 'resource') {
      if (busyResource.length >= config.maxResource) {
        notes.push(
          `задача ${task.id} ждёт: занято ${busyResource.length} из ${config.maxResource}`,
        );
        continue;
      }
      actions.push({ kind: 'start-stage', taskId: task.id, stage });
      busyResource.push(task);
      continue;
    }
    if (kind === 'review') {
      if (busyReview.length >= config.maxReview) continue;
      actions.push({ kind: 'start-stage', taskId: task.id, stage });
      busyReview.push(task);
      continue;
    }
    // Ожидательный этап квоты не занимает: прогон считает чужое железо.
    actions.push({ kind: 'start-stage', taskId: task.id, stage });
  }

  actions.sort((a, b) => ACTIONS.indexOf(a.kind) - ACTIONS.indexOf(b.kind));
  return { actions, notes };
}

/** Есть ли вообще работа. Ради этого ответа сканер и запускается 288 раз в сутки. */
export const hasWork = (result) => result.actions.length > 0;
