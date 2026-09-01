#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  budgetsAgree,
  countFailure,
  lockVerdict,
  newLock,
  refreshLock,
  shouldPause,
} from '../lib/lock.mjs';
import { createGit } from '../lib/git.mjs';
import { isPaused, readAnswers, readRegistry, readStages, readTasks } from '../lib/read-state.mjs';
import { parseWorktrees, reconcile } from '../lib/reconcile.mjs';
import { createIo } from '../lib/io.mjs';
import { createKillTree } from '../lib/run-stage.mjs';
import { createSupervisor } from '../lib/supervisor.mjs';
import { execute } from '../lib/execute.mjs';
import { repairWorld } from '../lib/repair.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { runCycle } from '../lib/cycle.mjs';
import { createTrello, missingAccess, readBoard } from '../lib/trello.mjs';
import { createTrelloBacklog } from '../lib/backlog-trello.mjs';
import { sortCards } from '../lib/validate-card.mjs';

/**
 * Супервизор: долгий процесс, который ведёт конвейер.
 *
 * Он не сессия ИИ и обращений к модели не делает вовсе. Решение принимает
 * та же счётная часть, что и прежде; новое здесь одно — этапы порождаются
 * дочерними процессами, дескрипторы которых супервизор не выпускает из рук.
 *
 * Отсюда всё остальное: срок этапа, снятие зависшего, код возврата, отчёт
 * выводом. И отсюда же то, чего больше нет: снимка сессий, слотов, отметок
 * активности и признака «идёт». Весь тот слой существовал ровно потому,
 * что дескриптора не было и живость приходилось угадывать по следам.
 *
 * Холостой ход не стоит ничего: пока работы нет, не порождается ни один
 * процесс. Прежде каждое пробуждение исполнителя стоило создания кэша —
 * около пяти копеек за «слот пуст, выхожу».
 */

const flags = process.argv.slice(2).filter((arg) => arg.startsWith('--'));
const rootArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

/**
 * Каталог самого инструмента. От него считаются ЕГО пути — правила этапов
 * и настройка разрешений, — тогда как проектные считаются от корня
 * репозитория. Граница проходит здесь и больше нигде.
 */
const home = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(rootArg ?? process.env.PIPELINE_ROOT ?? findRoot());

/** Корень репозитория: вверх от каталога инструмента до каталога с .git. */
function findRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(dir, '.git'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

/** Путь к настройке: свой ключ, переменная окружения либо файл рядом с инструментом. */
function configPath() {
  const named = process.argv.slice(2).find((arg) => arg.startsWith('--config='));
  if (named) return resolve(named.slice('--config='.length));
  if (process.env.PIPELINE_CONFIG) return resolve(process.env.PIPELINE_CONFIG);
  return join(home, 'pipeline.config.json');
}

function loadConfig() {
  const path = configPath();
  const project = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return resolveConfig(project);
}

/** Запуск внешней команды с ответом вместо исключения. */
function runCommand(args, program = 'git') {
  try {
    const stdout = execFileSync(program, args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const runGit = (args) => runCommand(args, 'git');
const { config, missing } = loadConfig();
const local = (...parts) => join(root, config.paths.local, ...parts);
const ensureLocal = () => mkdirSync(local(), { recursive: true });

/**
 * Замок с номером процесса.
 *
 * Он же и есть весь отсев двойного запуска: сторож будит супервизор раз
 * в пять минут независимо от того, жив ли прежний, и второму экземпляру
 * достаточно увидеть живой номер, чтобы уйти.
 */
const lockPath = () => local('supervisor.lock');

function readLock() {
  if (!existsSync(lockPath())) return null;
  try {
    return JSON.parse(readFileSync(lockPath(), 'utf8'));
  } catch {
    return { pid: null, takenAt: null, refreshedAt: null };
  }
}

function writeLock(lock) {
  ensureLocal();
  writeFileSync(lockPath(), JSON.stringify(lock, null, 2));
}

function releaseLock() {
  if (existsSync(lockPath())) rmSync(lockPath());
}

/**
 * Жив ли процесс с таким номером.
 *
 * Сигнал ноль ничего не посылает, а лишь спрашивает, есть ли такой процесс.
 * Отказ по правам значит, что процесс есть, но чужой, — то есть жив.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Дозапись в журнал цикла. Он местный и в репозиторий не едет. */
function note(lines) {
  const list = [lines].flat().filter(Boolean);
  if (list.length === 0) return;
  ensureLocal();
  const stamp = new Date().toISOString();
  const text = list.map((line) => `${stamp} ${line}\n`).join('');
  const path = local('cycle.log');
  writeFileSync(path, (existsSync(path) ? readFileSync(path, 'utf8') : '') + text);
  if (flags.includes('--verbose')) for (const line of list) console.log(line);
}

function readFailures() {
  if (!existsSync(local('failures.json'))) return 0;
  try {
    return JSON.parse(readFileSync(local('failures.json'), 'utf8')).inARow ?? 0;
  } catch {
    return 0;
  }
}

function writeFailures(inARow) {
  ensureLocal();
  writeFileSync(local('failures.json'), JSON.stringify({ inARow }, null, 2));
}

function saveStages(stages) {
  ensureLocal();
  writeFileSync(local('stages.json'), JSON.stringify(stages, null, 2));
}

/**
 * Подтянуть переменные из `.env`: сторож запускает Node без окружения.
 *
 * Ищем сначала рядом с инструментом, затем в корне проекта. Порядок именно
 * такой: инструмент переносится копированием, и его собственный файл должен
 * побеждать проектный. Читаются оба — `process.loadEnvFile` не перетирает
 * уже заданное, так что первый найденный и главнее, а второй лишь дополняет.
 *
 * Возвращает найденные файлы: стартовый вывод обязан назвать, откуда взяты
 * переменные. Без этого «доска недоступна» на чужой машине означает сразу
 * четыре разные беды, и разбирать их приходится наугад.
 */
function loadEnv() {
  const found = [];
  for (const path of [join(home, '.env'), join(root, '.env')]) {
    if (!existsSync(path) || found.includes(path)) continue;
    try {
      process.loadEnvFile(path);
      found.push(path);
    } catch {
      // Испорченный `.env` — не повод падать: может статься, доска и не нужна.
    }
  }
  return found;
}

/** Открыть бэклог — файловый или на доске. */
async function openBacklog({ mayWrite }) {
  if (config.backlog !== 'trello') {
    return { ok: true, ...readTasks(root, config), notes: [] };
  }

  loadEnv();
  const access = { key: process.env.TRELLO_KEY, token: process.env.TRELLO_TOKEN };
  const lacking = missingAccess({ ...access, board: config.trello.board });
  if (lacking.length > 0) {
    return {
      ok: false,
      outcome: 'misconfigured',
      why: `для работы с доской не хватает: ${lacking.join(', ')}`,
    };
  }

  const trello = createTrello(access);
  const board = await readBoard(trello, config.trello.board);
  if (!board.ok) {
    return {
      ok: false,
      outcome: 'unreachable',
      why: `доска недоступна (${board.what}): ${board.why ?? board.kind}`,
    };
  }

  // Имя станции нужно захвату: отказ «уже назначено» надо уметь прочесть
  // как «назначено нами же» и довести собственное взятие до конца.
  const store = createTrelloBacklog({ trello, config, snapshot: board, machine: hostname() });
  const adopted = mayWrite
    ? await store.adoptOrphans()
    : { adopted: [], problems: [], skipped: true };

  const { tasks, invalid, marked } = sortCards(store.parsedCards());

  return {
    ok: true,
    tasks,
    invalid,
    marked,
    store,
    notes: [
      ...adopted.problems,
      ...(adopted.adopted.length > 0 ? [`выданы номера: ${adopted.adopted.join(', ')}`] : []),
      ...(adopted.skipped ? ['номера карточкам не выдавались: правки доски запрещены'] : []),
    ],
  };
}

const supervisor = createSupervisor({
  config,
  root,
  home,
  spawn,
  killTree: createKillTree((program, args) => runCommand(args, program)),
  saveStages,
  stages: readStages(root, config),
  log: (line) => note(line),
  writeStageLog: (taskId, stage, text) => {
    // Вывод процесса целиком — взамен списка сессий, в котором этапы
    // больше не видны. Взамен неравноценное: кода возврата, стоимости
    // и перечня отказов в списке не было вовсе.
    mkdirSync(local('logs'), { recursive: true });
    writeFileSync(local('logs', `${taskId}-${stage}.log`), text, 'utf8');
  },
  // Тот же лог читается обратно — разбором упавшей задачи, и только им.
  // Отсутствие файла возвращается пустым текстом, а не отказом: разбор
  // без лога всё равно начинается, а сам факт его отсутствия — улика.
  readStageLog: (taskId, stage) => {
    if (!stage) return null;
    const path = local('logs', `${taskId}-${stage}.log`);
    return {
      stage,
      path: `${config.paths.local}/logs/${taskId}-${stage}.log`,
      text: existsSync(path) ? readFileSync(path, 'utf8') : null,
    };
  },
});

/**
 * Один оборот цикла.
 *
 * Ровно то же, что делал прежний однократный прогон, — с одной разницей:
 * порождение этапа не заканчивает работу, а начинает её. Оборот идёт
 * дальше, пока этап работает.
 */
async function turn() {
  const started = Date.now();
  const elapsed = () => (Date.now() - started) / 1000;

  const git = createGit(runGit, { remote: config.remote, mainBranch: config.mainBranch });
  const now = new Date().toISOString();
  const machine = hostname();

  // Замок обновляется первым делом каждый оборот. Держит его сам процесс
  // супервизора, а не оборот цикла: работа теперь переживает оборот, и замок,
  // снятый между ними, впустил бы второй экземпляр ровно в ту минуту, когда
  // идёт этап. Проверено пробой 31.08.2026 — второй экземпляр вошёл в работу
  // потому, что замок брался внутри цикла и до него не доходило дело при
  // недоступной доске.
  writeLock(refreshLock(readLock() ?? newLock(process.pid, now), now));

  const paused = isPaused(root, config);
  const mayWrite = !flags.includes('--dry-run') && !paused;

  const backlog = await openBacklog({ mayWrite });
  if (!backlog.ok) {
    note(backlog.why);
    return backlog.outcome;
  }

  const registry = readRegistry(root, config);
  const worktrees = parseWorktrees(runGit(['worktree', 'list', '--porcelain']).stdout);
  const repair = reconcile({ registry, worktrees, tasks: backlog.tasks, machine });

  const state = {
    tasks: backlog.tasks,
    invalid: backlog.invalid,
    marked: backlog.marked ?? [],
    registry,
    reports: supervisor.reports,
    running: supervisor.running(),
    answers: readAnswers(root, config),
    paused,
    tails: { main: git.tail() ?? 0, branches: {} },
  };

  const result = runCycle({
    git,
    state,
    config,
    now,
    pid: process.pid,
    // Замком цикла супервизор не пользуется: он держит свой, на весь срок
    // жизни процесса. Отдать сюда собственный замок значило бы объявить
    // самому себе, что работа занята.
    lock: null,
    isAlive,
    ourAuthors: config.ourAuthors,
    elapsed,
  });

  if (mayWrite && (result.actions.length > 0 || repair.repairs.length > 0)) {
    const io = {
      ...createIo({
        root,
        config,
        git,
        now,
        machine,
        run: runCommand,
        elapsed,
        reports: supervisor.reports,
      }),
      ...(backlog.store ?? {}),
      spawnStage: (assignment) => supervisor.spawnStage(assignment),
      lastSession: (taskId, stage) => supervisor.lastSession(taskId, stage),
      forgetSession: (taskId, stage) => supervisor.forgetSession(taskId, stage),
      // Отметка первого захода на этап: ею отличают свежий коммит от чужого,
      // когда отказ разрешений судят по следу.
      stageStartedAt: (taskId, stage) => supervisor.stageStartedAt(taskId, stage),
      // Предел возвратов доезжает до разбора отчёта доводом, а не читается
      // там из настройки: разбор — чистый счёт и о конфигурации не знает.
      maxRejections: config.maxRejections,
    };

    // Неудача починки печатается наравне с неудачей действия. Пока
    // возвращаемое здесь выбрасывалось, провалившаяся `finish-claim`
    // молчала: в журнале каждый оборот стояло «доводим взятие до конца»,
    // и ни разу — «не довели». Так и вышли двое суток простоя 31.08.2026.
    for (const item of repairWorld(repair.repairs, io)) {
      if (item.result === 'done') continue;
      note(`починка ${item.kind} ${item.taskId ?? ''}: ${item.why}`);
    }

    const executed = await execute(result.actions, io);
    for (const item of executed) {
      if (item.result === 'done') continue;
      note(`${item.action?.kind ?? 'действие'} ${item.action?.taskId ?? ''}: ${item.why}`);
    }
  }

  note([...backlog.notes, ...repair.notes, ...result.notes]);
  return result.outcome;
}

/** Бесконечный цикл с рубильником паузы и сторожем неудач. */
async function loop() {
  const budgets = budgetsAgree(config);
  if (!budgets.ok) note(budgets.why);
  if (missing.length > 0) note(`в настройке не хватает: ${missing.join(', ')}`);

  note(`супервизор запущен, процесс ${process.pid}, корень ${root}`);

  let stopping = false;
  // Ожидание между оборотами длится минуты, и без прерывания сигнал
  // добирался бы до цикла столько же: человек нажал Ctrl+C, а супервизор
  // ещё пять минут делает вид, что не слышал.
  // Через `globalThis` намеренно: встроенного модуля с этим именем нет,
  // а перечень известных линту глобальных имён здесь узкий.
  const waking = new globalThis.AbortController();
  const stop = (signal) => {
    if (stopping) {
      note(`повторный ${signal}: выходим немедленно`);
      process.exit(1);
    }
    stopping = true;
    note(`получен ${signal}: новых этапов не берём, идущим даём ${config.shutdownGraceSeconds} с`);
    waking.abort();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (!stopping) {
    let outcome = 'failed';
    try {
      outcome = await turn();
    } catch (error) {
      note(`оборот цикла упал: ${error.stack ?? error.message}`);
    }

    const failures = countFailure(readFailures(), outcome);
    writeFailures(failures);
    const pause = shouldPause(failures, config);
    if (pause.pause) {
      ensureLocal();
      writeFileSync(local('pause'), `${pause.why}\n`);
      note(pause.why);
    }

    if (stopping) break;
    try {
      await sleep(config.cycleMinutes * 60000, undefined, { signal: waking.signal });
    } catch {
      // Прерванное ожидание — это сигнал остановки, а не беда.
    }
  }

  // Остановка не бросает детей. Сначала им дают доработать — этап может
  // быть в шаге от коммита, — и только по истечении срока снимают
  // поддеревьями. Осиротевший процесс держит каталог дерева не хуже
  // зависшей сессии, и уборка потом падает на «каталог занят».
  await Promise.race([supervisor.settle(), sleep(config.shutdownGraceSeconds * 1000)]);
  supervisor.stopAll();
  await Promise.race([supervisor.settle(), sleep(5000)]);

  releaseLock();
  note('супервизор остановлен');
}

const startedAt = new Date().toISOString();
const verdict = lockVerdict(readLock(), startedAt, config.lockStaleMinutes, isAlive);
if (!verdict.take) {
  // Сторож будит супервизор раз в пять минут независимо от того, жив ли
  // прежний. Отсев двойного запуска — весь тут, и потому замок берётся
  // ДО первого оборота, а не внутри него: оборот может и не дойти до замка,
  // например при недоступной доске.
  console.log(`СУПЕРВИЗОР УЖЕ РАБОТАЕТ: ${verdict.why}`);
} else {
  writeLock(newLock(process.pid, startedAt));
  await loop();
}
