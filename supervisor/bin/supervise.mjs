#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  budgetsAgree,
  countFailure,
  lockVerdict,
  newLock,
  refreshLock,
  shouldPause,
} from '../lib/lock.mjs';
import { codexProbeCommand, providerOf, readCodexAnswer } from '../lib/provider.mjs';
import { judgeProbe, shouldProbe } from '../lib/api-health.mjs';
import { TAG, clock, createConsole, humanDuration } from '../lib/console.mjs';
import { checkEnvironment } from '../lib/environment.mjs';
import { createGit } from '../lib/git.mjs';
import {
  isApiPaused,
  isPaused,
  readApiPause,
  readAnswers,
  readPermissions,
  readRegistry,
  readStages,
  readTasks,
} from '../lib/read-state.mjs';
import { parseWorktrees, reconcile } from '../lib/reconcile.mjs';
import { createIo } from '../lib/io.mjs';
import { createKillTree, createProbeProcess } from '../lib/run-stage.mjs';
import { createSupervisor } from '../lib/supervisor.mjs';
import { execute } from '../lib/execute.mjs';
import { repairWorld } from '../lib/repair.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { runCycle } from '../lib/cycle.mjs';
import { judgeSelfUpdate } from '../lib/self-update.mjs';
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
 * Слив перед самообновлением: новый код уже на диске, ждём тишины. Пока
 * флаг взведён, сканер не выдаёт сессий — иначе при двух местах и полной
 * очереди тихий момент не наступил бы никогда (замечено 02.09.2026
 * в первый же час после вливания самообновления).
 */
let draining = false;

/**
 * Каталог самого инструмента. От него считаются ЕГО пути — правила этапов
 * и настройка разрешений, — тогда как проектные считаются от корня
 * репозитория. Граница проходит здесь и больше нигде.
 */
// `resolve` здесь не для красоты: без него путь приходит с разделителем
// на конце, и он лезет во все склейки и во весь вывод.
const home = resolve(fileURLToPath(new URL('..', import.meta.url)));
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
  const provider = process.argv
    .slice(2)
    .find((arg) => arg.startsWith('--provider='))
    ?.slice('--provider='.length);
  return resolveConfig({ ...project, ...(provider ? { provider } : {}) });
}

/**
 * Спросить сервер модели, отвечает ли он.
 *
 * Три мелочи здесь несут всю цену, и все три замерены 03.09.2026, а не
 * выведены рассуждением.
 *
 * **Дешёвая модель.** На ней проба стоит $0,019 против $0,087 на обычной.
 *
 * **Каталог без проекта.** Из дерева репозитория та же проба стоит $0,267:
 * в промпт уезжают CLAUDE.md и память. Отсюда `cwd` во временном каталоге.
 *
 * **Никакого своего системного промпта.** Это главная неожиданность замера:
 * `--system-prompt 'Отвечай одним словом.'` выглядит экономнее и стоит
 * $0,053 — в 2,7 раза ДОРОЖЕ, — потому что рушит кэш промпта приложения.
 * Двадцать четыре тысячи токенов его собственного промпта дешевле прочесть
 * из кэша, чем заменить своими двадцатью.
 *
 * Итог: около двух центов и шести секунд на пробу. Заход этапа
 * в перегруженный сервер стоит до пяти минут и одной попытки задачи, а сами
 * этапы обходятся в $1,7–15 — так что даже проба раз в минуту окупается
 * многократно.
 *
 * Судим по итоговому событию, а не по коду возврата: приложение отвечает
 * нулём и на отказ сервера, а состояние отказа кладёт в `api_error_status`.
 * Неразобравшийся ответ считаем отказом без состояния — сервер, чей ответ
 * нечем прочесть, работы всё равно не примет.
 *
 * @returns {{ ok: boolean, status: string|number|null }}
 */
function probeApi() {
  if (providerOf(config) === 'codex') {
    const command = codexProbeCommand(config);
    const dir = mkdtempSync(join(tmpdir(), 'td-probe-'));
    try {
      const answer = readCodexAnswer(runCommand(command.args, command.program, dir));
      return { ok: answer.outcome === 'done', status: answer.why };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const args = ['-p', 'скажи: готов', '--output-format', 'json', '--max-turns', '1'];
  if (config.apiProbeModel) args.push('--model', config.apiProbeModel);
  const run = runCommand(args, config.claudeCommand, mkdtempSync(join(tmpdir(), 'td-probe-')));
  try {
    const envelope = JSON.parse(run.stdout.slice(run.stdout.indexOf('{')));
    const status =
      envelope.api_error_status ?? (envelope.terminal_reason === 'api_error' ? 'api_error' : null);
    return { ok: !envelope.is_error && status == null, status };
  } catch {
    return { ok: false, status: null };
  }
}

/** Запуск внешней команды с ответом вместо исключения. */
function runCommand(args, program = 'git', cwd = root) {
  try {
    // `windowsHide` прячет консольное окно потомка. Без него каждый вызов
    // git из супервизора, запущенного в фоне, вспыхивает отдельным окном
    // и забирает фокус — а вызовов этих десятки за оборот.
    const stdout = execFileSync(program, args, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      windowsHide: true,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const runGit = (args) => runCommand(args, 'git');
const { config, missing } = loadConfig();
const git = createGit(runGit, { remote: config.remote, mainBranch: config.mainBranch });

/**
 * Каталог инструмента от корня репозитория, с прямыми косыми: так его
 * понимает git. Инструмент, лежащий вне репозитория, обновлять нечем —
 * тогда `null`, и самообновление честно объявляет себя выключенным.
 */
function ownDirOf() {
  const path = relative(root, home);
  if (!path || path.startsWith('..') || isAbsolute(path)) return null;
  return path.split(sep).join('/');
}

const ownDir = ownDirOf();
/**
 * Хеш дерева собственного кода на момент запуска. По нему после каждого
 * оборота видно, сменился ли код на диске, — чем угодно: подтягиванием,
 * ручным `git pull`, локальным коммитом.
 */
const loadedTree = ownDir ? git.treeOf(ownDir) : null;

/**
 * Рассказчик.
 *
 * Подробный по умолчанию, и это перемена. Прежде супервизор молчал, пока
 * не потребуют ключом `--verbose`, — а наблюдать за конвейером нужно всегда,
 * а не только когда о нём вспомнили. Ключ оставлен и ничего не меняет:
 * он стоит в чужих сторожах и командных файлах, и отвергать его значило бы
 * ломать их запуск ради чистоты перечня ключей.
 *
 * Цвет — только в терминал. При перенаправлении в файл журнал сторожа
 * наполнился бы управляющими последовательностями, а читать их нечем.
 */
const say = createConsole({
  quiet: flags.includes('--quiet'),
  colour: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
});
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

/**
 * Дозапись в журнал цикла. Он местный и в репозиторий не едет.
 *
 * Те же строки идут и в консоль. Одно другому не замена: журнал читают
 * потом и целиком, консоль смотрят сейчас и мельком, — и если оставить
 * только журнал, то за работой конвейера снова нельзя будет наблюдать.
 */
function note(lines, tag = TAG.cycle) {
  const list = [lines].flat().filter(Boolean);
  if (list.length === 0) return;
  ensureLocal();
  const stamp = new Date().toISOString();
  const text = list.map((line) => `${stamp} ${line}\n`).join('');
  const path = local('cycle.log');
  writeFileSync(path, (existsSync(path) ? readFileSync(path, 'utf8') : '') + text);
  // `null` означает «только в журнал». Так пишет супервизор: он рассказывает
  // о том же своими строками, с верными тегами и подробнее, и печатать
  // журнальную запись рядом значило бы говорить дважды.
  if (tag) say.line(tag, list);
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
    return { ok: true, ...readTasks(root, config, home), notes: [] };
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
  // Опрос системы о процессе по номеру. Тем же способом, что и снятие:
  // одной внешней командой, ответ вместо исключения.
  probe: createProbeProcess((program, args) => runCommand(args, program)),
  // Дескриптор живого этапа называет станцию и своего супервизора: местное
  // хранилище состояния можно скопировать, а номер процесса с другой машины
  // здесь не значит ничего.
  machine: hostname(),
  supervisorPid: process.pid,
  saveStages,
  stages: readStages(root, config),
  say,
  log: (line) => note(line, null),
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

/** Сколько задач стоит в этом состоянии. Состояние задачи и есть её колонка. */
function counted(tasks, status) {
  return tasks.filter((task) => task.status === status).length;
}

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

  const now = new Date().toISOString();
  const machine = hostname();

  // Замок обновляется первым делом каждый оборот. Держит его сам процесс
  // супервизора, а не оборот цикла: работа теперь переживает оборот, и замок,
  // снятый между ними, впустил бы второй экземпляр ровно в ту минуту, когда
  // идёт этап. Проверено пробой 31.08.2026 — второй экземпляр вошёл в работу
  // потому, что замок брался внутри цикла и до него не доходило дело при
  // недоступной доске.
  writeLock(refreshLock(readLock() ?? newLock(process.pid, now), now));

  // Один `git fetch` на оборот — свой, а не по случаю. До сих пор удалённая
  // ветка обновлялась в общем `.git` только тогда, когда её подтягивала
  // сессия этапа, и подтягивание главной ветки работало на этом случайном
  // обновлении. Неудача сверки оборот не останавливает: он идёт
  // по последней известной картине.
  const fetched = git.fetch(config.mainBranch);
  if (!fetched.ok) {
    note(
      `свериться с удалённой веткой не удалось (${fetched.failure}): работаем по прежней картине`,
    );
  }

  // Обход сирот идёт ДО чтения живости: этап, осиротевший при смене
  // супервизора, мог кончиться минуту назад, и место обязано освободиться
  // этим же оборотом, а не при следующем перезапуске.
  supervisor.sweep();

  const paused = isPaused(root, config);
  const apiPaused = isApiPaused(root, config);
  // Записи запрещает и пауза сервера: оборот под ней всё равно не дойдёт
  // до сканирования, а лишнее обращение к доске под лежачим сервером
  // ничего не даёт.
  const mayWrite = !flags.includes('--dry-run') && !paused && !apiPaused;

  const backlog = await openBacklog({ mayWrite });
  if (!backlog.ok) {
    note(backlog.why, TAG.error);
    return backlog.outcome;
  }

  // Опись доски строкой: сколько задач прочитано, сколько идёт, сколько ждёт
  // человека и сколько не разобралось. Это первое, о чём спрашивают, глядя
  // в консоль, и последнее, что видно из журнала цикла.
  say.line(
    TAG.board,
    `прочитано задач ${backlog.tasks.length}` +
      `, идёт этапов ${supervisor.running().length}` +
      `, ждут ответа ${counted(backlog.tasks, 'awaiting-po')}` +
      `, в ошибке ${counted(backlog.tasks, 'failed')}` +
      `${backlog.invalid?.length ? `, не разобралось ${backlog.invalid.length}` : ''}`,
  );

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
    // Исходы этапов, осиротевших при смене супервизора: живость они уже
    // не значат, зато объясняют в журнале задачи, почему прошлый заход
    // ничего не дал.
    orphans: supervisor.orphanOutcomes,
    apiFailures: supervisor.apiFailures,
    answers: readAnswers(root, config),
    // Правила разрешений читаются здесь, а не сканером: сканер запускается
    // 288 раз в сутки и остаётся чистым счётом от доводов.
    permissions: providerOf(config) === 'claude' ? readPermissions(home, config) : null,
    ...(providerOf(config) === 'codex' ? { stageCommands: {} } : {}),
    paused,
    apiPaused,
    draining,
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
      // Исход сироты и его забвение — та же пара, что чтение и снятие отчёта:
      // дескриптор стирается с диска лишь после удавшейся записи в журнал.
      readOrphan: (taskId, stage) =>
        supervisor.orphanOutcomes.find((item) => item.taskId === taskId && item.stage === stage) ??
        null,
      forgetOrphan: (taskId, stage) => supervisor.forgetOrphan(taskId, stage),
      // Отказ сервера и его забвение — та же пара: запись снимается с очереди
      // только после удавшейся правки задачи.
      readApiFailure: (taskId, stage) =>
        supervisor.apiFailures.find((item) => item.taskId === taskId && item.stage === stage) ??
        null,
      forgetApiFailure: (taskId, stage) => supervisor.forgetApiFailure(taskId, stage),
      // Отметка первого захода на этап: ею отличают свежий коммит от чужого,
      // когда отказ разрешений судят по следу.
      stageStartedAt: (taskId, stage) => supervisor.stageStartedAt(taskId, stage),
      // Предел возвратов доезжает до разбора отчёта доводом, а не читается
      // там из настройки: разбор — чистый счёт и о конфигурации не знает.
      maxRejections: config.maxRejections,
      // Тем же порядком — предел автоматических возвратов из ошибки.
      maxAutoReturns: config.maxAutoReturns,
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

/**
 * Перезапуститься на новом коде, передав замок.
 *
 * Порядок выстрадан замыслом, а не удобством: сначала рождается новый
 * процесс, потом в замок записывается ЕГО номер, и только потом старый
 * выходит. Так ни в один момент замок не пуст и не указывает на мёртвого —
 * а сторож планировщика, проснувшийся посреди перезапуска, видит живой
 * номер и второго экземпляра не поднимает.
 *
 * Новый процесс — тот же, что у пускателя в фоновом режиме: отсоединённый,
 * с выводом в файл, с теми же аргументами. Консоль не наследуется намеренно:
 * окно принадлежит старому процессу и закроется вместе с ним, а запись
 * в закрытую консоль на Windows роняет процесс.
 *
 * Возвращает `false`, если новый процесс не родился: тогда старый продолжает
 * работать на прежнем коде — это хуже перезапуска, но лучше пустого места.
 */
function restart() {
  ensureLocal();
  const outPath = local('supervisor.out.log');
  let child;
  try {
    child = spawn(process.execPath, process.argv.slice(1), {
      cwd: root,
      detached: true,
      stdio: ['ignore', openSync(outPath, 'a'), openSync(local('supervisor.err.log'), 'a')],
      windowsHide: true,
      env: process.env,
    });
  } catch (error) {
    note(`перезапуск не удался: ${error.message}; продолжаю на прежнем коде`, TAG.error);
    return false;
  }
  if (!child.pid) {
    note('перезапуск не удался: новый процесс не родился; продолжаю на прежнем коде', TAG.error);
    return false;
  }
  child.unref();

  const now = new Date().toISOString();
  writeLock({ ...newLock(child.pid, now), handedFrom: process.pid });
  note(
    `перезапуск на новом коде: процесс ${child.pid} получил замок, ` +
      `его вывод — в ${outPath}; этот процесс (${process.pid}) завершается`,
  );
  return true;
}

/**
 * Представиться.
 *
 * Печатается один раз, при запуске, и отвечает на вопросы, которые иначе
 * задают журналу цикла и файлу настройки: что именно запущено, откуда взята
 * настройка, каким проектом оно правит и как часто просыпается.
 *
 * Особенно нужно на второй машине: там половина бед — это «запустил не то»
 * и «взял чужую настройку», и обе видно прямо здесь.
 */
function greet() {
  const backlogName =
    config.backlog === 'trello'
      ? `доска Trello ${config.trello?.board ?? '— не названа —'}`
      : `файлы в ${config.paths.tasks}`;

  // Переменные подтягиваются ДО осмотра: иначе он честно доложит, что доступа
  // к доске нет, при заполненном рядом файле.
  const envFiles = loadEnv();
  const world = checkEnvironment({
    home,
    root,
    config,
    run: (program, args) => runCommand(args, program),
    exists: existsSync,
    envFiles,
  });

  say.block('СУПЕРВИЗОР КОНВЕЙЕРА ЗАПУЩЕН', [
    ['процесс', process.pid],
    ['инструмент', home],
    ['корень проекта', root],
    [
      'настройка',
      existsSync(configPath()) ? configPath() : `${configPath()} — НЕТ, взяты умолчания`,
    ],
    ['бэклог', backlogName],
    ['главная ветка', `${config.remote}/${config.mainBranch}`],
    ['оборот раз в', humanDuration(config.cycleMinutes * 60000)],
    ['этапов разом', config.maxConcurrent],
    ['пульс этапа раз в', humanDuration(config.pulseSeconds * 1000)],
    ['вывод этапа', providerOf(config) === 'codex' ? 'Codex JSONL' : config.stageOutputFormat],
    flags.includes('--dry-run') && ['режим', 'ТЕНЬ: считаем и печатаем, мира не трогаем'],
    isPaused(root, config) && ['режим', 'ПАУЗА человека: новой работы не берём'],
    isApiPaused(root, config) && ['режим', 'ПАУЗА сервера: пробуем по расписанию'],
    [
      'самообновление',
      config.selfUpdate === false
        ? 'выключено настройкой'
        : flags.includes('--dry-run')
          ? 'выключено: тень'
          : ownDir
            ? `слежу за ${ownDir}/ (дерево ${loadedTree ? loadedTree.slice(0, 7) : 'не прочиталось'})`
            : 'выключено: инструмент лежит вне репозитория',
    ],
    ...world.rows,
  ]);

  for (const problem of world.problems) note(problem, TAG.warn);

  // Единственная нехватка, останавливающая запуск. Всё прочее — предупреждение:
  // без `gh` конвейер прекрасно живёт, пока ни одна задача не дошла до проверок.
  if (world.fatal) {
    note(world.fatal, TAG.error);
    releaseLock();
    process.exit(1);
  }
}

/** Чем кончился оборот, по-человечески. Коды исходов наружу не выносим. */
const OUTCOME = {
  idle: 'работы нет',
  worked: 'работа выдана',
  blocked: 'записи невозможны',
  paused: 'взведён рубильник паузы',
  'api-paused': 'сервер модели не отвечает',
  locked: 'замок держит другой цикл',
  failed: 'оборот не удался',
  misconfigured: 'настройка неполна',
  unreachable: 'бэклог недоступен',
};

/** Бесконечный цикл с рубильником паузы и сторожем неудач. */
async function loop() {
  const budgets = budgetsAgree(config);
  if (!budgets.ok) note(budgets.why, TAG.warn);
  if (missing.length > 0) note(`в настройке не хватает: ${missing.join(', ')}`, TAG.warn);

  note(`супервизор запущен, процесс ${process.pid}, корень ${root}`, null);
  greet();

  let turns = 0;
  let stopping = false;
  // Ожидание между оборотами длится минуты, и без прерывания сигнал
  // добирался бы до цикла столько же: человек нажал Ctrl+C, а супервизор
  // ещё пять минут делает вид, что не слышал.
  // Через `globalThis` намеренно: встроенного модуля с этим именем нет,
  // а перечень известных линту глобальных имён здесь узкий.
  const waking = new globalThis.AbortController();
  /**
   * Взвести, подержать или снять паузу сервера модели.
   *
   * Пробу делаем сами и здесь: `api-health` — чистый счёт и обращений
   * не делает вовсе, иначе проверять его пришлось бы живым сервером,
   * то есть по погоде.
   *
   * Очередь отказов под паузой не расходуется: сканер до неё не доходит.
   * Поэтому её длина и служит признаком «отказы были» до самого снятия.
   */
  function judgeApi() {
    const armed = isApiPaused(root, config);
    const state = readApiPause(root, config) ?? { attempt: 0, lastProbeAt: null };
    const asked = shouldProbe({
      apiErrors: supervisor.apiFailures.length,
      threshold: config.pauseAfterApiErrors,
      armed,
      now: Date.now(),
      lastProbeAt: state.lastProbeAt,
      attempt: state.attempt,
      schedule: config.apiProbeBackoffSeconds,
    });

    if (!asked.probe) {
      // Молчащая пауза неотличима от забытой, поэтому срок следующей пробы
      // называется вслух каждый оборот, пока она держится.
      if (armed) say.line(TAG.warn, `пауза сервера: ${asked.why}`);
      return;
    }

    const probe = probeApi();
    const verdict = judgeProbe({ armed, ok: probe.ok, status: probe.status });

    if (verdict.verdict === 'idle') {
      note(`проба сервера: ${verdict.why}`);
      return;
    }

    if (verdict.verdict === 'lift') {
      // Снимаем ТОЛЬКО свой файл. Рубильник человека означает «человек занят
      // деревом» или «человек разбирается», и вернувшийся сервер об этом
      // не говорит ничего.
      rmSync(local('pause.api'), { force: true });
      say.line(TAG.cycle, `пауза сервера снята: ${verdict.why}`);
      return;
    }

    ensureLocal();
    writeFileSync(
      local('pause.api'),
      `${JSON.stringify(
        {
          armedAt: armed ? (state.armedAt ?? clock()) : clock(),
          attempt: (state.attempt ?? 0) + 1,
          lastProbeAt: Date.now(),
          status: probe.status,
          why: verdict.why,
        },
        null,
        2,
      )}
`,
    );
    say.line(
      TAG.warn,
      `${verdict.verdict === 'arm' ? 'пауза сервера взведена' : 'пауза сервера держится'}: ` +
        `${verdict.why}`,
    );
  }

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
    turns += 1;
    const began = Date.now();
    say.line(TAG.cycle, `оборот №${turns} начат`);

    try {
      outcome = await turn();
    } catch (error) {
      note(`оборот цикла упал: ${error.stack ?? error.message}`, TAG.error);
    }

    say.line(
      TAG.cycle,
      `оборот №${turns}: ${OUTCOME[outcome] ?? outcome} (${humanDuration(Date.now() - began)})`,
    );

    // Пауза сервера решается ПОСЛЕ оборота, по тем же соображениям, что
    // и самообновление: очередь отказов этого оборота уже собрана, и видно,
    // сколько их было.
    judgeApi();

    const failures = countFailure(readFailures(), outcome);
    writeFailures(failures);
    const pause = shouldPause(failures, config);
    if (pause.pause) {
      ensureLocal();
      writeFileSync(local('pause'), `${pause.why}\n`);
      note(pause.why, TAG.error);
    }

    if (stopping) break;

    // Свой код проверяется ПОСЛЕ оборота: отчёты этого оборота уже перенесены,
    // и если этапов нет — момент тихий. Причина отложенного обновления пишется
    // раз в оборот; выключенное самообновление называется один раз.
    const update = judgeSelfUpdate({
      git,
      ownDir,
      mainBranch: config.mainBranch,
      loadedTree,
      enabled: config.selfUpdate !== false,
      dryRun: flags.includes('--dry-run'),
      running: supervisor.busy(),
      pending: supervisor.reports.length,
    });
    if (update.verdict !== 'off' || turns === 1) note(update.notes);
    draining = update.verdict === 'wait';
    if (update.verdict === 'restart' && restart()) {
      // Без снятия замка: он уже передан новому процессу.
      process.exit(0);
    }

    // Время следующего оборота, а не «жду пять минут»: глядя в консоль
    // посреди тишины, человек хочет знать, когда она кончится, а не сколько
    // её было отпущено от какого-то момента в прошлом.
    const nextAt = new Date(Date.now() + config.cycleMinutes * 60000);
    say.line(
      TAG.cycle,
      `следующий оборот в ${clock(nextAt)} (через ${humanDuration(config.cycleMinutes * 60000)})` +
        `${supervisor.running().length > 0 ? '; этап продолжает работать' : ''}`,
    );

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
// Собственный номер нужен переданному замку: старый процесс, перезапускаясь,
// записывает в замок номер нового и выходит, и новому достаточно узнать себя.
const verdict = lockVerdict(readLock(), startedAt, config.lockStaleMinutes, isAlive, process.pid);
if (!verdict.take) {
  // Сторож будит супервизор раз в пять минут независимо от того, жив ли
  // прежний. Отсев двойного запуска — весь тут, и потому замок берётся
  // ДО первого оборота, а не внутри него: оборот может и не дойти до замка,
  // например при недоступной доске.
  console.log(`СУПЕРВИЗОР УЖЕ РАБОТАЕТ: ${verdict.why}`);
} else {
  // Отметка передачи читается ДО записи своего замка: своя запись её стирает.
  const handedFrom = readLock()?.handedFrom ?? null;
  writeLock(newLock(process.pid, startedAt));
  if (handedFrom) note(`замок получен от процесса ${handedFrom}: продолжаю на новом коде`, null);
  await loop();
}
