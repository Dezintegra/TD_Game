#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SLOTS } from '../lib/slots.mjs';
import { budgetsAgree, lockVerdict } from '../lib/lock.mjs';
import { createGit } from '../lib/git.mjs';
import {
  isPaused,
  readAnswers,
  readRegistry,
  readReports,
  readSlots,
  readTasks,
} from '../lib/read-state.mjs';
import { parseWorktrees, reconcile } from '../lib/reconcile.mjs';
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

/** Настройка проекта поверх умолчаний. */
function loadConfig() {
  const path = join(root, 'plugins', 'pipeline', 'pipeline.config.json');
  const project = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const { config, missing } = resolveConfig(project);
  return { config: { ...config, slots: config.slots ?? DEFAULT_SLOTS }, missing };
}

/** Запуск git с ответом вместо исключения. */
function runGit(args) {
  try {
    const stdout = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

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

  const verdict = lockVerdict(lock, now, config.lockStaleMinutes);
  if (!verdict.take) {
    print({ outcome: 'locked', why: verdict.why, actions: [], assignments: [] });
    return;
  }

  const { tasks, invalid } = readTasks(root, config);
  const registry = readRegistry(root, config);
  const { reports, problems } = readReports(root, config);
  const worktrees = parseWorktrees(runGit(['worktree', 'list', '--porcelain']).stdout);
  const repair = reconcile({ registry, worktrees, tasks, machine });

  const state = {
    tasks,
    invalid,
    registry,
    reports,
    sessions: [],
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
    ourAuthors: config.ourAuthors ?? ['Конвейер'],
    elapsed,
  });

  const work = result.actions.length + repair.repairs.length + result.assignments.length;
  if (result.lock && work > 0) writeLock(config, result.lock);
  else releaseLock(config);

  noteCycle(config, [...problems, ...repair.notes, ...result.notes]);

  print({
    outcome: result.outcome,
    machine,
    seconds: Number(elapsed().toFixed(2)),
    budgets: budgets.ok ? null : budgets.why,
    missingConfig: missing,
    repairs: repair.repairs,
    actions: result.actions,
    assignments: result.assignments,
    waiting: result.waiting,
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
    (result.assignments?.length ?? 0);
  console.log(work > 0 ? 'РАБОТА ЕСТЬ' : 'НЕЧЕГО ДЕЛАТЬ');
  console.log(JSON.stringify(result, null, 2));
}

main();
