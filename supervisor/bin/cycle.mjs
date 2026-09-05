#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerOf } from '../lib/provider.mjs';
import { budgetsAgree } from '../lib/lock.mjs';
import { createGit } from '../lib/git.mjs';
import {
  isApiPaused,
  isPaused,
  readAnswers,
  readPermissions,
  readRegistry,
  readTasks,
} from '../lib/read-state.mjs';
import { parseWorktrees, reconcile } from '../lib/reconcile.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { scan } from '../lib/scan.mjs';
import { createTrello, missingAccess, readBoard } from '../lib/trello.mjs';
import { createTrelloBacklog } from '../lib/backlog-trello.mjs';
import { sortCards } from '../lib/validate-card.mjs';

/**
 * Что конвейер собирается делать.
 *
 * Только смотрит: читает бэклог, реестр и деревья, считает решение и печатает
 * его. Мира не касается вовсе — ни коммита, ни дерева, ни процесса.
 *
 * Исполнения здесь больше нет намеренно. Оно переехало в супервизор
 * (`supervise.mjs`), и вот почему: этап живёт десятками минут, а однократный
 * прогон завершается за секунду. Породив этап и выйдя, он оставил бы
 * процесс без хозяина — ровно ту беду, ради которой всё затевалось.
 *
 * Живость этапов однократному прогону неизвестна: дескрипторы держит
 * супервизор, а не диск. Поэтому картина здесь печатается такой, какой она
 * была бы при полностью свободной машине, и «этапу нужна сессия» в выводе
 * означает «нужна, если её ещё никто не ведёт».
 */

const rootArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
/** Каталог инструмента: от него считаются его собственные пути. */
const home = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(rootArg ?? findRoot());

function findRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(dir, '.git'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

function loadConfig() {
  const path = fileURLToPath(new URL('../pipeline.config.json', import.meta.url));
  const project = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return resolveConfig(project);
}

function runCommand(args, program = 'git') {
  try {
    // `windowsHide` прячет консольное окно потомка. Без него каждый вызов
    // git из супервизора, запущенного в фоне, вспыхивает отдельным окном
    // и забирает фокус — а вызовов этих десятки за оборот.
    const stdout = execFileSync(program, args, {
      cwd: root,
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

/** Подтянуть переменные из `.env`: без токена доска недоступна. */
function loadEnv() {
  const path = join(root, '.env');
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch {
    // Испорченный `.env` — не повод падать: может статься, доска и не нужна.
  }
}

/**
 * Прочитать бэклог, ничего в нём не меняя.
 *
 * Номера карточкам здесь не раздаются: это правка доски, а смотрящий прогон
 * мира не касается. Карточка без номера попадёт в негодные с причиной —
 * и это честнее, чем молча переименовать её при взведённой паузе.
 */
async function openBacklog(config) {
  if (config.backlog !== 'trello') {
    return { ok: true, ...readTasks(root, config, home) };
  }

  loadEnv();
  const access = { key: process.env.TRELLO_KEY, token: process.env.TRELLO_TOKEN };
  const lacking = missingAccess({ ...access, board: config.trello.board });
  if (lacking.length > 0) {
    return { ok: false, why: `для работы с доской не хватает: ${lacking.join(', ')}` };
  }

  const trello = createTrello(access);
  const board = await readBoard(trello, config.trello.board);
  if (!board.ok) {
    return { ok: false, why: `доска недоступна (${board.what}): ${board.why ?? board.kind}` };
  }

  const store = createTrelloBacklog({ trello, config, snapshot: board, machine: hostname() });
  return { ok: true, ...sortCards(store.parsedCards()) };
}

async function main() {
  const { config, missing } = loadConfig();
  const backlog = await openBacklog(config);
  if (!backlog.ok) {
    print({ why: backlog.why, actions: [], repairs: [] });
    return;
  }

  const git = createGit(runGit, { remote: config.remote, mainBranch: config.mainBranch });
  const machine = hostname();
  const registry = readRegistry(root, config);
  const worktrees = parseWorktrees(runGit(['worktree', 'list', '--porcelain']).stdout);
  const repair = reconcile({ registry, worktrees, tasks: backlog.tasks, machine });

  const decision = scan({
    tasks: backlog.tasks,
    invalid: backlog.invalid,
    marked: backlog.marked ?? [],
    registry,
    reports: [],
    // Живых этапов смотрящий прогон не знает: дескрипторы у супервизора.
    running: [],
    answers: readAnswers(root, config),
    // Правила разрешений — доводом, как и всё прочее: сканер сам диска
    // не трогает. Смотрящий прогон обязан видеть ту же картину, что боевой
    // цикл, иначе он показывал бы работу, которой цикл не сделает.
    permissions: providerOf(config) === 'claude' ? readPermissions(home, config) : null,
    ...(providerOf(config) === 'codex' ? { stageCommands: {} } : {}),
    paused: isPaused(root, config),
    apiPaused: isApiPaused(root, config),
    tails: { main: git.tail() ?? 0, branches: {} },
    config,
  });

  const budgets = budgetsAgree(config);
  print({
    machine,
    budgets: budgets.ok ? null : budgets.why,
    missingConfig: missing,
    repairs: repair.repairs,
    actions: decision.actions,
    notes: [...repair.notes, ...decision.notes],
  });
}

/**
 * Вывод.
 *
 * Первой строкой — короткий ответ на единственный вопрос: есть работа
 * или нет. Прочитавшему «нечего делать» дальше читать незачем.
 */
function print(result) {
  const work = (result.actions?.length ?? 0) + (result.repairs?.length ?? 0);
  console.log(work > 0 ? 'РАБОТА ЕСТЬ' : 'НЕЧЕГО ДЕЛАТЬ');
  console.log(JSON.stringify(result, null, 2));
}

await main();
