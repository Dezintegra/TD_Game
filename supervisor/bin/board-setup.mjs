#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../config/defaults.mjs';
import { describeAction, planBoard } from '../lib/board-setup.mjs';
import { createTrello, missingAccess } from '../lib/trello.mjs';

/**
 * Привести доску Trello к виду, пригодному для бэклога.
 *
 * Заводит колонку на каждое состояние автомата и метки на типы задач,
 * виды прогона и две служебные надобности. Зовётся руками — при заведении
 * доски и когда есть сомнение, всё ли на месте.
 *
 * Второй прогон подряд ничего не делает и так и говорит. Скрипт настройки
 * зовут в том числе с испугу, и такой зов не должен заводить вторую
 * колонку «Проработка» рядом с первой.
 *
 * По умолчанию печатает намерение и завершается. Исполнение включается
 * ключом `--execute` — тем же, что и у цикла: доска общая с человеком,
 * и молча её перестраивать нельзя.
 */

const flags = process.argv.slice(2).filter((arg) => arg.startsWith('--'));
const rootArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const root = resolve(rootArg ?? findRoot());

function findRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(dir, '.git'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

/**
 * Подтянуть переменные из `.env`.
 *
 * Планировщик запускает Node без окружения разработчика, и токен иначе
 * до скрипта не доедет вовсе. Уже заданные переменные встроенный
 * загрузчик не трогает, так что задать их через окружение по-прежнему
 * можно — и это удобно, когда доска пробная.
 */
function loadEnv() {
  const path = join(root, '.env');
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch (error) {
    console.error(`не удалось прочитать .env: ${error.message}`);
  }
}

function loadConfig() {
  const path = fileURLToPath(new URL('../pipeline.config.json', import.meta.url));
  const project = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return resolveConfig(project).config;
}

async function main() {
  loadEnv();
  const config = loadConfig();
  const board = config.trello.board;

  const missing = missingAccess({
    key: process.env.TRELLO_KEY,
    token: process.env.TRELLO_TOKEN,
    board,
  });
  if (missing.length > 0) {
    console.error(`не хватает: ${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const trello = createTrello({
    key: process.env.TRELLO_KEY,
    token: process.env.TRELLO_TOKEN,
  });

  // Колонки читаются вместе с закрытыми: колонка в архиве — это не
  // отсутствующая, и заводить рядом вторую с тем же именем нельзя.
  const lists = await trello.get(`boards/${board}/lists`, {
    filter: 'all',
    fields: 'name,closed',
  });
  if (!lists.ok) return fail('колонки', lists);

  const labels = await trello.get(`boards/${board}/labels`, { fields: 'name,color', limit: 50 });
  if (!labels.ok) return fail('метки', labels);

  const { actions, notes } = planBoard({ config, lists: lists.data, labels: labels.data });
  for (const note of notes) console.log(`замечание: ${note}`);

  if (actions.length === 0) {
    console.log('доска уже настроена, делать нечего');
    return;
  }

  if (!flags.includes('--execute')) {
    console.log(`намерения (${actions.length}), исполнение включается ключом --execute:`);
    for (const action of actions) console.log(`  · ${describeAction(action)}`);
    return;
  }

  for (const action of actions) {
    const result = await apply(trello, board, action);
    if (!result.ok) {
      console.error(`не удалось: ${describeAction(action)} — ${result.why}`);
      process.exitCode = 1;
      return;
    }
    console.log(`сделано: ${describeAction(action)}`);
  }
}

/** Исполнить одно действие плана. */
function apply(trello, board, action) {
  switch (action.kind) {
    case 'create-list':
      return trello.post('lists', { name: action.name, idBoard: board, pos: action.pos });
    case 'reopen-list':
      return trello.put(`lists/${action.id}/closed`, { value: false });
    case 'create-label':
      return trello.post('labels', { name: action.name, color: action.color, idBoard: board });
    case 'name-label':
    case 'recolor-label':
      return trello.put(`labels/${action.id}`, { name: action.name, color: action.color });
    default:
      return Promise.resolve({ ok: false, why: `неизвестное действие ${action.kind}` });
  }
}

/**
 * Отказ при чтении доски.
 *
 * Обрыв связи от отказа в правах отделён намеренно: первое лечится
 * ожиданием, второе — токеном, и спутав их, разбирающий пойдёт чинить
 * не то.
 */
function fail(what, result) {
  const reason =
    result.kind === 'offline'
      ? `до Trello не достучались: ${result.why}`
      : result.kind === 'throttled'
        ? 'превышен предел обращений, попробуйте через минуту'
        : `Trello отказал (${result.status}): ${result.why}`;
  console.error(`не прочитать ${what} — ${reason}`);
  process.exitCode = 1;
}

await main();
