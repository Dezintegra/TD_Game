#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../config/defaults.mjs';
import { joinDescription, metaOf, nameWithId } from '../lib/card.mjs';
import { splitJournalEntry } from '../lib/comments.mjs';
import { createTrello, missingAccess, readBoard } from '../lib/trello.mjs';

/**
 * Одноразовый переезд файлового бэклога на доску.
 *
 * Зовётся один раз в жизни проекта и после этого не нужен вовсе. Держать
 * его в плагине всё же стоит: переезд повторят те, кто скопирует плагин
 * к себе, а восстанавливать порядок действий по журналу изменения —
 * работа на полдня.
 *
 * По умолчанию печатает намерение и ничего не делает. Исполнение включается
 * ключом `--execute`.
 *
 * Три вещи, которые скрипт делает не буквально:
 *
 * - **Приоритет становится порядком.** Числового поля на доске нет, поэтому
 *   карточки создаются в порядке «приоритет, затем время заведения» —
 *   ровно в том, в каком их брал бы сканер. Дальше порядком управляет
 *   человек, перетаскивая карточки.
 * - **Отметка заведения теряется.** У карточки она своя — время создания,
 *   и подменить его нельзя. Потеря безобидна: разрешать ею равные
 *   приоритеты больше не нужно, порядок задан положением.
 * - **Закрытые задачи уезжают в архив.** Их шестнадцать из двадцати девяти,
 *   и колонка «Закрыто» из них была бы нечитаемой. Номера архивных карточек
 *   при этом считаются занятыми — архив не забвение.
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

function loadConfig() {
  const path = fileURLToPath(new URL('../pipeline.config.json', import.meta.url));
  const project = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return resolveConfig(project).config;
}

/** Метка порядка байтов: её ставят редакторы Windows, а JSON на ней спотыкается. */
const BOM = String.fromCharCode(0xfeff);

function readTasks() {
  const dir = join(root, 'manage/tasks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const raw = readFileSync(join(dir, name), 'utf8');
      return JSON.parse(raw.startsWith(BOM) ? raw.slice(1) : raw);
    });
}

/**
 * Разобрать журнал задачи на записи.
 *
 * Каждая запись начинается заголовком `## <дата> · <из> → <в>` и станет
 * отдельным комментарием: журнал обязан дозаписываться, а комментарии
 * Trello ровно таковы. Заголовок файла в перенос не идёт — на карточке
 * его роль исполняют название и описание.
 */
function readJournalEntries(id) {
  const path = join(root, 'manage/journal', `${id}.md`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/^## /m)
    .slice(1)
    .map((chunk) => `## ${chunk}`.trim())
    .filter(Boolean);
}

/** Порядок, в котором задачи брал бы сканер: приоритет, затем время заведения. */
function inScannerOrder(tasks) {
  return [...tasks].sort((a, b) =>
    a.priority !== b.priority
      ? a.priority - b.priority
      : Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}

/**
 * Описание карточки.
 *
 * Ожидаемый результат прогона выносится отдельным разделом: его пишет
 * человек, и прятать его в служебный блок нельзя — конвейер читает его
 * именно оттуда.
 */
function describeTask(task) {
  const parts = [task.description?.trim() ?? ''];
  if (task.type === 'run' && task.run?.expectation) {
    parts.push('', '## Ожидаемый результат', '', task.run.expectation.trim());
  }
  if (task.question?.summary) {
    parts.push('', '## Вопрос владельцу продукта', '', task.question.summary.trim());
  }
  return joinDescription(parts.join('\n').trim(), metaOf(task));
}

async function main() {
  const config = loadConfig();
  loadEnv();

  const access = { key: process.env.TRELLO_KEY, token: process.env.TRELLO_TOKEN };
  const missing = missingAccess({ ...access, board: config.trello.board });
  if (missing.length > 0) {
    console.error(`не хватает: ${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const trello = createTrello(access);
  const board = await readBoard(trello, config.trello.board);
  if (!board.ok) {
    console.error(`доска недоступна (${board.what}): ${board.why ?? board.kind}`);
    process.exitCode = 1;
    return;
  }

  const listIdByState = new Map();
  for (const [state, name] of Object.entries(config.trello.lists)) {
    const list = board.lists.find((item) => item.name === name && !item.closed);
    if (list) listIdByState.set(state, list.id);
  }
  const labelIdByKey = new Map();
  for (const [key, label] of Object.entries(config.trello.labels)) {
    const found = board.labels.find((item) => item.name === label.name);
    if (found) labelIdByKey.set(key, found.id);
  }

  const tasks = inScannerOrder(readTasks());
  if (tasks.length === 0) {
    console.log('переносить нечего: файлового бэклога нет');
    return;
  }

  // Уже перенесённое не переносится второй раз. Скрипт зовут повторно,
  // когда первый заход оборвался на середине, и дубли карточек были бы
  // худшим из возможных исходов: две карточки одной задачи неразличимы.
  const already = new Set(
    board.cards.map((card) => card.desc?.match(/"id":"([^"]+)"/)?.[1]).filter(Boolean),
  );

  const plan = tasks.map((task) => ({
    task,
    entries: readJournalEntries(task.id),
    skip: already.has(task.id),
  }));

  console.log(`задач в файловом бэклоге: ${tasks.length}`);
  for (const item of plan) {
    const marks = [item.task.type, item.task.run?.kind].filter(Boolean).join(', ');
    const where = item.task.status === 'closed' ? 'архив' : config.trello.lists[item.task.status];
    const note = item.skip ? ' — УЖЕ ПЕРЕНЕСЕНА, пропуск' : '';
    console.log(
      `  · ${item.task.id} → ${where} [${marks}], записей журнала: ${item.entries.length}${note}`,
    );
  }

  if (!flags.includes('--execute')) {
    console.log('\nисполнение включается ключом --execute');
    return;
  }

  let moved = 0;
  for (const { task, entries, skip } of plan) {
    if (skip) continue;

    // Закрытая задача заводится в своей колонке и тут же уходит в архив:
    // Trello не умеет создавать карточку сразу закрытой.
    const state = task.status;
    const idList = listIdByState.get(state);
    if (!idList) {
      console.error(`нет колонки для «${state}», задача ${task.id} пропущена`);
      process.exitCode = 1;
      continue;
    }

    const created = await trello.post('cards', {
      idList,
      name: nameWithId(task.id, task.title),
      desc: describeTask(task),
      idLabels: [labelIdByKey.get(task.type), labelIdByKey.get(task.run?.kind)].filter(Boolean),
      pos: 'bottom',
    });
    if (!created.ok) {
      console.error(`не создалась карточка ${task.id}: ${created.why}`);
      process.exitCode = 1;
      continue;
    }

    for (const entry of entries) {
      const parts = splitJournalEntry(entry, {
        marker: config.trello.marker,
        limit: config.trello.maxTextLength,
      });
      for (const part of parts) {
        const posted = await trello.post(`cards/${created.data.id}/actions/comments`, {
          text: part,
        });
        if (!posted.ok) console.error(`запись журнала ${task.id} не легла: ${posted.why}`);
      }
    }

    if (state === 'closed') {
      const archived = await trello.put(`cards/${created.data.id}`, { closed: true });
      if (!archived.ok) console.error(`карточка ${task.id} не убралась в архив: ${archived.why}`);
    }

    moved += 1;
    console.log(`перенесена ${task.id} (${entries.length} записей журнала)`);
  }

  console.log(`\nперенесено задач: ${moved}`);
}

/** Подтянуть переменные из `.env`: токен доски иначе не доедет. */
function loadEnv() {
  const path = join(root, '.env');
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch (error) {
    console.error(`не удалось прочитать .env: ${error.message}`);
  }
}

await main();
