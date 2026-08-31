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
 * Посчитать, что конвейеру делать.
 *
 * @param {object} state
 * @param {object[]} state.tasks     записи бэклога, прошедшие схему
 * @param {object[]} state.invalid   записи, схему не прошедшие: `{ id, problems }`
 * @param {object}   state.registry  местный реестр деревьев: `{ entries: [] }`
 * @param {object[]} state.reports   отчёты этапов, ожидающие переноса
 * @param {object[]} state.running   идущие этапы: `{ taskId, stage }`
 * @param {object}   state.tails     хвосты: `{ main, branches: { ветка: число } }`
 * @param {object}   state.answers   ответы владельца продукта: `{ идЗадачи: true }`
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
    // Идущие этапы: по одной записи на живой дочерний процесс. Это и есть
    // вся картина живости — ни снимка сессий, ни отметок активности, ни
    // признака «идёт» больше нет. У процесса есть хозяин, и хозяин знает
    // про него правду, а не догадывается по следам.
    running = [],
    tails = { main: 0, branches: {} },
    answers = {},
    config,
    paused = false,
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
  const hasReport = (taskId) => reports.some((report) => report.taskId === taskId);
  const isRunning = (taskId, stage) =>
    running.some((item) => item.taskId === taskId && (stage === undefined || item.stage === stage));

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
    // Ветку дерева, где идёт этап, не трогаем: неизвестно, доделан ли
    // атомарный коммит. Прежде это выяснялось по снимку сессий, теперь —
    // прямым вопросом «есть ли живой процесс», на который есть точный ответ.
    if (entry && isRunning(entry.taskId)) {
      notes.push(`ветка ${branch} впереди удалённой, но на дереве идёт этап — не трогаем`);
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

  // Занятость машины считается по задачам, стоящим в этапах, которым нужна
  // сессия. Не по живым процессам: задача, чей этап только что кончился без
  // отчёта, машину всё ещё занимает — ей сейчас же выдадут продолжение.
  //
  // Прежде здесь считались три квоты — ресурсная, ревьюшная и «машина занята
  // исключительным этапом», — и ожидательные этапы не занимали ни одной.
  // Из-за этого сканер запускал прогоны арены пачками, а исполнитель был
  // один: лишние вставали в этапе, сессии им не доставалось, и через полчаса
  // конвейер объявлял их мёртвыми. За ночь 27–28.08.2026 так сгорело
  // семнадцать задач — парами, в одну и ту же секунду.
  //
  // Плата за простоту названа честно: прогоны арены идут по очереди.
  const engaged = tasks.filter((task) => NEEDS_SESSION.includes(task.status));
  let busy = engaged.length >= config.maxConcurrent;

  // Исключительный этап — замер кадров и выкладка — требует тишины на машине
  // целиком. При одном исполнителе это выходит само собой, но настройка
  // допускает и больше, а замер на engagedй машине измеряет загрузку, а не код:
  // проверено дважды, один раз цифра оказалась завышена вдесятеро.
  const exclusiveHeld = engaged.some((task) => stateClass(task) === 'exclusive');
  if (exclusiveHeld && !busy) {
    notes.push('идёт исключительный этап: новых задач не берём, машина должна молчать');
    busy = true;
  }

  // 6. Этапы, которым нужна сессия, а живого процесса нет.
  //
  // Сюда попадают два случая, и мерить их одной меркой правильно: этап,
  // который ещё не начинали (задача только что переехала в новое состояние),
  // и этап, чей процесс кончился, не оставив отчёта. Обоим нужно одно и то
  // же — процесс. Различает их только то, известен ли идентификатор прежней
  // сессии: если известен, её возобновляют, а не начинают заново.
  for (const task of tasks) {
    // Отбор идёт по признаку «этапу нужна сессия», а не по цене этапа.
    // Раньше здесь стоял перечень классов, и прогон на чужом железе в него
    // не попадал: класс у него «ожидательный». Из-за этого умершая сессия
    // прогона не подхватывалась никогда — задача стояла в этапе, слот был
    // занят ею навсегда, и заметить это можно было только глазами.
    // Проверено 27.08.2026: 0002 простояла так почти шесть часов.
    if (!NEEDS_SESSION.includes(task.status)) continue;
    if (stuck.has(task.id) || hasReport(task.id)) continue;

    // Живой процесс на этом самом этапе — работа идёт, вмешиваться незачем.
    if (isRunning(task.id, task.status)) continue;

    // Запись реестра требуется только там, где есть дерево. У прогона
    // и разбора его нет вовсе, и требовать запись значило бы никогда
    // их не подхватывать.
    if (NEEDS_WORKTREE.includes(task.status) && !entryOf(task.id)) continue;

    if ((task.attempts?.continuations ?? 0) >= config.maxContinuations) {
      notes.push(`задача ${task.id}: продолжения исчерпаны, нужен разбор человеком`);
      actions.push({
        kind: 'fail-stage',
        taskId: task.id,
        stage: task.status,
        reason: 'этап не доводится до конца, продолжения исчерпаны',
      });
      continue;
    }
    actions.push({
      kind: 'continue-stage',
      taskId: task.id,
      stage: task.status,
      reason: 'этапу нужна сессия, живого процесса нет',
    });
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

    if (busy) {
      notes.push(`задача ${task.id} ждёт: исполнитель занят`);
      continue;
    }
    if (runWaiting && task.type !== 'run') continue;

    actions.push({ kind: 'start-stage', taskId: task.id, stage });
    busy = true;
  }

  actions.sort((a, b) => ACTIONS.indexOf(a.kind) - ACTIONS.indexOf(b.kind));
  return { actions, notes };
}

/** Есть ли вообще работа. Ради этого ответа сканер и запускается 288 раз в сутки. */
export const hasWork = (result) => result.actions.length > 0;
