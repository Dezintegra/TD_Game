import {
  NEEDS_SESSION,
  NEEDS_WORKTREE,
  canTransition,
  stateClass,
} from '../config/transitions.mjs';
import { missingForStage } from '../config/defaults.mjs';

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

/**
 * Задачи, у которых совпал номер.
 *
 * Сам конвейер повторов не делает: `nextId` берёт наибольший занятый номер
 * и прибавляет единицу. Повтор заводится людьми — двумя ветками, каждая
 * из которых честно посчитала следующий свободный номер по своей копии
 * бэклога. Так 27.08.2026 вышло по два 0022, 0023 и 0024.
 *
 * Работу это не ломает: идентификатор — вся строка целиком, и она уникальна;
 * уникальны и ветка, и дерево, и журнал. Ломает оно понимание: и люди,
 * и сессии ссылаются на задачи номером — «задача 0023 убирает свист», —
 * а такая ссылка при повторе указывает на два файла разом.
 *
 * Поэтому здесь замечание, а не отказ: в работу задачи берутся, но повтор
 * называется вслух каждый цикл, пока его не разведут.
 */
function duplicateNumbers(tasks) {
  const byNumber = new Map();
  for (const task of tasks) {
    const number = String(task.id).slice(0, 4);
    byNumber.set(number, [...(byNumber.get(number) ?? []), task.id]);
  }

  return [...byNumber.entries()]
    .filter(([, ids]) => ids.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([number, ids]) =>
        `номер ${number} занят дважды: ${ids.sort().join(', ')}. ` +
        'Ссылки по номеру теперь двусмысленны — разведите номера',
    );
}

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
function sessionLife({ entry, session, task, config, now }) {
  if (!session) {
    // Сессии может не быть просто потому, что исполнитель ещё не проснулся.
    // Он и оркестратор ходят по расписанию независимо, и порядок между ними
    // не задан: между взятием задачи и первым пробуждением исполнителя
    // проходит до целого интервала. Продолжатель, порождённый в эту щель,
    // ничего не чинит, зато тратит попытку, — а их всего две, и после второй
    // задача встаёт и ждёт человека.
    const since = entry?.lastSeenAt ?? task.statusChangedAt;
    const waitingFor = minutesBetween(now, since);
    if (waitingFor !== null && waitingFor < config.deadAfterMinutes) return 'жива';
    return 'сессии нет';
  }
  // Срок молчания один на все случаи, и завершившаяся сессия не исключение.
  //
  // Прежде признак «не идёт» убивал сессию немедленно, без всякого срока.
  // На коротком промежутке он ненадёжен: снимок ловит сессию между ходами,
  // и только что закончившая ход неотличима в нём от закончившей насовсем.
  //
  // Стоило это двух задач за вечер. Сессия по 0005 запустила арену в 19:20
  // и закончила ход; оркестратор объявил её завершившейся без отчёта
  // в 19:22:13 — за двадцать пять секунд ДО её же последней активности.
  // Прогон тем временем спокойно досчитался, а задача успела сгореть.
  const silentFor = minutesBetween(now, session.lastActivityAt ?? entry?.lastSeenAt);
  if (silentFor === null || silentFor < config.deadAfterMinutes) return 'жива';

  return session.isRunning ? 'молчит дольше отпущенного' : 'сессия завершилась без отчёта';
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

  notes.push(...duplicateNumbers(tasks));

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
    if (tasks.some((task) => NEEDS_SESSION.includes(task.status))) {
      notes.push('снимок сессий не сделан: о живости исполнителей ничего не известно');
    }
  }
  for (const task of sessionsKnown ? tasks : []) {
    // Отбор идёт по признаку «этапу нужна сессия», а не по цене этапа.
    // Раньше здесь стоял перечень классов, и прогон на чужом железе в него
    // не попадал: класс у него «ожидательный». Из-за этого умершая сессия
    // прогона не подхватывалась никогда — задача стояла в этапе, слот был
    // занят ею навсегда, и заметить это можно было только глазами.
    // Проверено 27.08.2026: 0002 простояла так почти шесть часов.
    if (!NEEDS_SESSION.includes(task.status)) continue;
    if (stuck.has(task.id) || hasReport(task.id)) continue;

    // Запись реестра требуется только там, где есть дерево. У прогона
    // и разбора его нет вовсе, и требовать запись значило бы снова
    // никогда их не подхватывать.
    const entry = entryOf(task.id);
    if (NEEDS_WORKTREE.includes(task.status) && !entry) continue;

    // Заголовок сессии складывается по правилу, а не берётся из реестра:
    // у бездревесных этапов реестра нет, а заголовок всё равно определён.
    const title = entry?.sessionTitle ?? `pipeline:${task.id}:${task.status}`;
    const session = sessions.find((item) => item.title === title);

    const life = sessionLife({ entry, session, task, config, now });
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

    // Этап, который нечем закончить, не начинают. Иначе сессия проснётся,
    // дойдёт до последнего шага и встанет, оставив задачу в состоянии,
    // из которого её будет доставать человек.
    const missing = missingForStage(config, stage, task);
    if (missing.length > 0) {
      notes.push(`задача ${task.id} не берётся: в настройке нет ${missing.join(', ')}`);
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
