#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SLOTS } from '../lib/slots.mjs';
import { budgetsAgree, countFailure, lockVerdict, shouldPause } from '../lib/lock.mjs';
import { createGit } from '../lib/git.mjs';
import {
  isPaused,
  readAnswers,
  readRegistry,
  readReports,
  readSessions,
  readSlots,
  readTasks,
} from '../lib/read-state.mjs';
import { parseWorktrees, reconcile } from '../lib/reconcile.mjs';
import { createIo } from '../lib/io.mjs';
import { execute } from '../lib/execute.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { runCycle } from '../lib/cycle.mjs';

/**
 * Один прогон оркестратора.
 *
 * Печатает решение в машиночитаемом виде и завершается. Ничего не исполняет
 * сам: заводить деревья, порождать сессии и коммитить будет сессия, которая
 * этот вывод прочла.
 *
 * Холостой прогон обязан стоить секунды. Поэтому при пустом перечне действий
 * вывод короткий и однозначный — сессии не за что зацепиться и незачем
 * рассуждать.
 */

// Доводы: необязательный путь к корню и ключи. Ключи нельзя принимать
// за путь — иначе `--release` становится каталогом, и замок снимается
// не там, где лежит.
const flags = process.argv.slice(2).filter((arg) => arg.startsWith('--'));
const rootArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const root = resolve(rootArg ?? findRoot());
const started = Date.now();
const elapsed = () => (Date.now() - started) / 1000;

/** Корень репозитория: вверх от расположения плагина до каталога с .git. */
function findRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(dir, '.git'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

/**
 * Настройка проекта поверх умолчаний.
 *
 * Ищется рядом с самим плагином, а не по пути от корня репозитория: плагин
 * обязан работать из любого каталога, куда его скопируют, а `plugins/pipeline`
 * — это привязка к нынешнему месту, а не к плагину.
 */
function loadConfig() {
  const path = fileURLToPath(new URL('../pipeline.config.json', import.meta.url));
  const project = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const { config, missing } = resolveConfig(project);
  return { config: { ...config, slots: config.slots ?? DEFAULT_SLOTS }, missing };
}

/**
 * Запуск внешней команды с ответом вместо исключения.
 *
 * Через `execFileSync`, а не через оболочку: доводы уходят как есть, и ни
 * кавычки, ни русские буквы в сообщении коммита ничего не ломают.
 */
function runCommand(args, program = 'git') {
  try {
    const stdout = execFileSync(program, args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const runGit = (args) => runCommand(args, 'git');

/** Замок цикла лежит рядом с прочим местным хозяйством. */
function lockPath(config) {
  return join(root, config.paths.local, 'orchestrator.lock');
}

function readLock(config) {
  const path = lockPath(config);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { pid: null, takenAt: null, refreshedAt: null };
  }
}

function writeLock(config, lock) {
  const dir = join(root, config.paths.local);
  mkdirSync(dir, { recursive: true });
  writeFileSync(lockPath(config), JSON.stringify(lock, null, 2));
}

/**
 * Жив ли процесс с таким номером.
 *
 * Сигнал ноль ничего не посылает, а лишь спрашивает, есть ли такой процесс.
 * Отказ по правам значит, что процесс есть, но чужой, — то есть жив.
 *
 * Без этой проверки замок переживал взявший его процесс и держал конвейер
 * до истечения получаса. Так и вышло 27.08.2026: сценарий отработал, сессия
 * оркестратора почему-то не позвала `--release`, и следующие шесть
 * пробуждений отвечали «замок держит процесс 24020» — которого давно нет.
 * Тридцать минут простоя за один незакрытый файл.
 *
 * Замку и не нужно жить дольше процесса: с ключом `--execute` вся работа
 * с бэклогом делается внутри него, а сессия оркестратора после этого лишь
 * пересказывает вывод человеку. Стеречь ей нечего.
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
 * Освободить замок.
 *
 * Освобождается он не всегда. Когда работа выдана, замок остаётся за сессией,
 * которая эту работу исполняет: иначе следующее пробуждение застанет
 * недоделанное взятие задачи и начнёт его заново. Сессия отпускает замок
 * сама, вызвав этот же сценарий с ключом `--release`, а если не отпустит —
 * замок протухнет по сроку.
 *
 * А вот при холостом прогоне замок надо снять немедленно. Иначе конвейер
 * запирает сам себя до истечения срока брошенности — на полчаса вместо пяти
 * минут. Проверено первым же настоящим прогоном.
 */
function releaseLock(config) {
  const path = lockPath(config);
  if (existsSync(path)) rmSync(path);
}

/** Сколько циклов подряд закончились неудачей. Счётчик местный. */
function readFailures(config) {
  const path = join(root, config.paths.local, 'failures.json');
  if (!existsSync(path)) return 0;
  try {
    return JSON.parse(readFileSync(path, 'utf8')).inARow ?? 0;
  } catch {
    return 0;
  }
}

function writeFailures(config, inARow) {
  mkdirSync(join(root, config.paths.local), { recursive: true });
  writeFileSync(
    join(root, config.paths.local, 'failures.json'),
    JSON.stringify({ inARow }, null, 2),
  );
}

/** Дозапись в журнал цикла. Он местный и в репозиторий не едет. */
function noteCycle(config, lines) {
  if (lines.length === 0) return;
  const dir = join(root, config.paths.local);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString();
  const text = lines.map((line) => `${stamp} ${line}\n`).join('');
  const path = join(dir, 'cycle.log');
  writeFileSync(path, (existsSync(path) ? readFileSync(path, 'utf8') : '') + text);
}

function main() {
  const { config, missing } = loadConfig();

  // Сессия, доделавшая работу, отпускает замок этим же сценарием.
  if (flags.includes('--release')) {
    releaseLock(config);
    console.log('НЕЧЕГО ДЕЛАТЬ');
    console.log(JSON.stringify({ outcome: 'released' }, null, 2));
    return;
  }

  // Нехватка обязательной настройки — не повод гадать. Но и не повод стоять:
  // без команды выкладки конвейер работает, пока задача до выкладки не дошла.
  const budgets = budgetsAgree(config);

  const git = createGit(runGit, { remote: config.remote, mainBranch: config.mainBranch });
  const lock = readLock(config);
  const now = new Date().toISOString();
  const machine = hostname();

  const verdict = lockVerdict(lock, now, config.lockStaleMinutes, isAlive);
  if (!verdict.take) {
    print({ outcome: 'locked', why: verdict.why, actions: [], assignments: [] });
    return;
  }

  const { tasks, invalid } = readTasks(root, config);
  const registry = readRegistry(root, config);
  const { reports, problems } = readReports(root, config);
  const worktrees = parseWorktrees(runGit(['worktree', 'list', '--porcelain']).stdout);
  const repair = reconcile({ registry, worktrees, tasks, machine });

  // Снимок сессий кладёт оркестратор перед прогоном: сам сценарий сессий
  // не видит — их отдаёт только сессия. Нет снимка — о живости исполнителей
  // ничего не известно, и продолжателей никто не назначает.
  const snapshot = readSessions(root, config);

  const state = {
    tasks,
    invalid,
    registry,
    reports,
    sessions: snapshot.sessions,
    sessionsKnown: snapshot.known,
    answers: readAnswers(root, config),
    occupancy: readSlots(
      root,
      config,
      config.slots.map((slot) => slot.name),
    ),
    paused: isPaused(root, config),
    tails: { main: git.tail() ?? 0, branches: {} },
  };

  const result = runCycle({
    git,
    state,
    config,
    now,
    pid: process.pid,
    lock,
    isAlive,
    ourAuthors: config.ourAuthors ?? ['Конвейер'],
    elapsed,
  });

  const releases = result.releases ?? [];
  const work =
    result.actions.length + repair.repairs.length + result.assignments.length + releases.length;
  if (result.lock && work > 0) writeLock(config, result.lock);
  else releaseLock(config);

  // Действия сканера ничего не знают о слотах: слоты — дело раскладки.
  // Здесь они соединяются, чтобы исполнителю досталось всё разом.
  const bySlot = new Map(result.assignments.map((item) => [item.assignment.taskId, item]));
  const enriched = result.actions.map((action) => {
    const placed = bySlot.get(action.taskId);
    if (!placed) return action;
    return {
      ...action,
      slot: placed.slot,
      assignment: placed.assignment,
      branch: placed.assignment.branch,
      sessionTitle: placed.assignment.sessionTitle,
    };
  });

  // Теневой режим по умолчанию: цикл печатает решение, но мира не трогает.
  // Исполнение включается явным ключом — так задуман первый шаг ввода
  // в строй, и так же удобно смотреть, что конвейер собирается делать.
  let executed = null;
  if (flags.includes('--execute')) {
    const io = createIo({ root, config, git, now, machine, run: runCommand, elapsed });
    // Слоты освобождаются ПЕРЕД исполнением: раскладка уже посчитала их
    // свободными и могла выдать кому-то, а снятие после записи стёрло бы
    // свежее назначение.
    for (const item of releases) io.clearSlot(item.slot);
    executed = execute(enriched, io);
  }

  // Планировщик перезапустит оркестратор через пять минут независимо
  // от исхода. Значит, застрявший конвейер будет молча падать сутками,
  // и заметить это будет некому: несколько неудач подряд взводят паузу сами.
  const failures = countFailure(readFailures(config), result.outcome);
  writeFailures(config, failures);
  const pause = shouldPause(failures, config);
  if (pause.pause) {
    writeFileSync(join(root, config.paths.local, 'pause'), `${pause.why}\n`);
    result.notes.push(pause.why);
  }

  noteCycle(config, [...problems, ...repair.notes, ...result.notes]);

  print({
    executed,
    outcome: result.outcome,
    machine,
    seconds: Number(elapsed().toFixed(2)),
    budgets: budgets.ok ? null : budgets.why,
    missingConfig: missing,
    repairs: repair.repairs,
    actions: result.actions,
    assignments: result.assignments,
    releases,
    waiting: result.waiting,
    locked: result.locked ?? [],
    notes: result.notes,
  });
}

/**
 * Вывод.
 *
 * Первой строкой — короткий ответ на единственный вопрос холостого прогона:
 * есть работа или нет. Сессия, прочитавшая «нечего делать», вправе
 * завершиться немедленно, не читая остального.
 */
function print(result) {
  const work =
    (result.actions?.length ?? 0) +
    (result.repairs?.length ?? 0) +
    (result.assignments?.length ?? 0) +
    (result.releases?.length ?? 0);
  console.log(work > 0 ? 'РАБОТА ЕСТЬ' : 'НЕЧЕГО ДЕЛАТЬ');
  console.log(JSON.stringify(result, null, 2));
}

main();
