#!/usr/bin/env node
/**
 * Прогон очереди проверок баланса.
 *
 *   pnpm balance:run                      разобрать очередь целиком
 *   pnpm balance:run -- --dry-run         показать план, ничего не считая
 *   pnpm balance:run -- --only <id>       одна запись
 *   pnpm balance:run -- --all             гнать и то, что уже мерено на этом коде
 *   pnpm balance:run -- --max-matches 200 предел матчей за прогон
 *   pnpm balance:run -- --summary <файл>  куда положить сводку (markdown)
 *   pnpm balance:run -- --issue <файл>    куда положить текст Issue, если сдвиг
 *
 * Зачем это существует. Проверка баланса — это десятки безголовых
 * матчей: шестьдесят занимают машину минут на десять, чемпионат — на
 * часы. Посреди задачи столько не ждут, поэтому проверка не отменяется,
 * а откладывается: агент заводит задачу типа `run` в бэклоге, а разбирает
 * накопившееся ночная джоба на чужом железе. Правила — в CLAUDE.md,
 * правило 8; устройство бэклога — в `manage/README.md`.
 *
 * Отдельного файла очереди больше нет: очередью служит сам бэклог. Два списка
 * ожидающей работы неизбежно расходятся, и однажды становится непонятно,
 * какому из них верить.
 *
 * Инструмент **приводит величины и предлагает, куда посмотреть**, но
 * не решает, стал баланс лучше или хуже. Это то же разделение, на котором
 * стоит сама арена: сводка, которая сама себе судья, незаметно начинает
 * измерять то, что подтверждает её представление о хорошем.
 */

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Импорт прямо из `dist` по относительному пути, а не по имени пакета:
// `@td/shared` не значится в зависимостях корня репозитория и по имени
// отсюда не разрешился бы. Так же поступает и `bench-tick.mjs`.
import { TICKS_PER_SECOND } from '../packages/shared/dist/index.js';

import { queueFromBacklog } from './balance-queue.mjs';
import { die, git, note, ok, repoRoot, step, warn } from './perf-common.mjs';

// ── Где что лежит ────────────────────────────────────────────────────

const JOURNAL_PATH = join(repoRoot, 'balance', 'journal.jsonl');
const ARENA_MAIN = join(repoRoot, 'apps', 'arena', 'dist', 'main.js');

// Логи прогонов ложатся в общий для арены `.matchlog`, но каждая запись
// очереди получает свой каталог: иначе матчи разных проверок смешиваются
// в одной базе и сводка считает чужие матчи своими.
const LOGS_ROOT = join(repoRoot, '.matchlog', 'balance');

// ── Пороги, за которыми сдвиг считается заметным ─────────────────────
//
// Матчи детерминированы, поэтому ЛЮБОЕ расхождение цифр настоящее:
// шума, который надо было бы отсеивать, здесь нет вовсе. Пороги стоят
// не против шума, а против мелочи: на шестидесяти матчах один
// перевернувшийся исход — это 1,7 процентного пункта, и будить человека
// ради него незачем.

/** Сдвиг доли побед стороны, в долях единицы. Пять пунктов — три матча из шестидесяти. */
const WIN_SHARE_STEP = 0.05;

/** Сдвиг медианной длины матча, в долях. Десятая часть от десяти минут — минута. */
const LENGTH_STEP = 0.1;

/** Сдвиг доли исходов одного вида (упёрлись в предел времени, снесли базу). */
const REASON_SHARE_STEP = 0.1;

/** Сколько матчей джоба готова прогнать за одну ночь, если не сказано иное. */
const DEFAULT_MATCH_BUDGET = 400;

// ── Ключи ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const value = (name, fallback = undefined) => {
  const at = argv.indexOf(name);
  return at === -1 || argv[at + 1] === undefined ? fallback : argv[at + 1];
};

const dryRun = has('--dry-run');
const runAll = has('--all');
const only = value('--only');
const summaryPath = value('--summary');
const issuePath = value('--issue');
const budget = Number(value('--max-matches', String(DEFAULT_MATCH_BUDGET)));

if (!Number.isFinite(budget) || budget <= 0) die('--max-matches ожидает положительное число');

// ── Мелочи ───────────────────────────────────────────────────────────

/**
 * Склонение числительного: «1 запись», «2 записи», «5 записей».
 *
 * Не педантизм. Сводку читает человек, и «1 записей» в первой же строке
 * заставляет усомниться заодно и во всех остальных цифрах.
 */
const plural = (count, one, few, many) => {
  const tens = Math.abs(count) % 100;
  const ones = tens % 10;

  if (tens > 10 && tens < 20) return `${String(count)} ${many}`;
  if (ones === 1) return `${String(count)} ${one}`;
  if (ones > 1 && ones < 5) return `${String(count)} ${few}`;

  return `${String(count)} ${many}`;
};

const entries = (count) => plural(count, 'запись', 'записи', 'записей');
const matchesOf = (count) => plural(count, 'матч', 'матча', 'матчей');
const checks = (count) => plural(count, 'проверке', 'проверках', 'проверках');

// ── Очередь ──────────────────────────────────────────────────────────

/** Имя записи служит и именем каталога с логами — отсюда строгость. */
const ID_SHAPE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * Собрать очередь из бэклога.
 *
 * Отдельного файла очереди больше нет: очередью служит сам бэклог, а прогон
 * баланса — обычная задача типа `run` с видом `arena`. Причина в том, что два
 * списка ожидающей работы неизбежно расходятся: запись в очереди живёт своей
 * жизнью, задача — своей, и однажды становится непонятно, какой из них верить.
 *
 * Формат записи внутри прогонщика оставлен прежним намеренно: он разумный,
 * а переписывать заодно и его значило бы менять две вещи одной правкой.
 */
const readQueue = () => {
  const parsed = queueFromBacklog(repoRoot, warn);
  if (parsed.length === 0 && !existsSync(join(repoRoot, 'manage', 'tasks'))) {
    die(`бэклога нет: ${join(repoRoot, 'manage', 'tasks')}`);
  }

  const seen = new Set();

  for (const entry of parsed) {
    const where = `запись «${String(entry?.id ?? 'без имени')}»`;

    if (!ID_SHAPE.test(String(entry?.id ?? '')))
      die(`${where}: id обязателен и состоит из строчных латинских букв, цифр и дефисов`);
    if (seen.has(entry.id)) die(`${where}: такое id уже есть в очереди`);
    seen.add(entry.id);

    if (!Array.isArray(entry.profiles) || entry.profiles.length !== 2)
      die(`${where}: profiles — ровно два профиля, кого с кем меряем`);
    if (!Number.isInteger(entry.matches) || entry.matches <= 0)
      die(`${where}: matches — целое число матчей`);
    if (!Number.isInteger(entry.seed)) die(`${where}: seed — целое число`);
    for (const field of ['task', 'why', 'expect'])
      if (typeof entry[field] !== 'string' || entry[field].trim() === '')
        die(`${where}: ${field} обязателен — без него цифры некому будет истолковать`);
  }

  warnAboutTwins(parsed);

  return parsed;
};

/**
 * Предупредить о записях с одинаковой настройкой прогона.
 *
 * Матчи арены детерминированы, поэтому две записи с одними профилями,
 * числом матчей и зерном дадут В ТОЧНОСТИ одни и те же цифры. Джоба
 * считает их порознь, то есть платит шестьюдесятью матчами за второй
 * прогон того же — а сравнение при этом ничего не добавляет: второе
 * число обязано совпасть с первым, что бы ни случилось с игрой.
 *
 * Опаснее не трата, а вид независимой проверки. Две записи в Issue
 * читаются как два свидетельства, хотя свидетельство одно.
 *
 * Предупреждение, а не отказ: совпадение может быть и намеренным —
 * скажем, у записей разные `until`, и одна доживает после другой.
 * Запрещать за автора то, что он мог сделать нарочно, здесь не место.
 */
const warnAboutTwins = (queue) => {
  const bySetup = new Map();

  for (const entry of queue) {
    const key = `${entry.profiles.join(' против ')} · ${String(entry.matches)} · ${String(entry.seed)}`;
    bySetup.set(key, [...(bySetup.get(key) ?? []), entry.id]);
  }

  for (const [key, ids] of bySetup) {
    if (ids.length < 2) continue;
    warn(
      `одинаковая настройка у записей ${ids.join(', ')} (${key}). ` +
        'Матчи детерминированы, значит цифры совпадут в точности, ' +
        'и второй прогон ничего не добавит. Разведите зёрнами.',
    );
  }
};

// ── Журнал ───────────────────────────────────────────────────────────
//
// Журнал едет в репозиторий, в отличие от журнала замеров скорости.
// Разница принципиальная: кадры в секунду говорят об этой машине и о том,
// чем она была занята в ту минуту, а матчи арены детерминированы —
// при том же коде и зерне runner GitHub выдаст ровно то же, что выдала бы
// рабочая машина. Такие числа сравнимы между прогонами и между машинами,
// а значит им место в истории проекта, а не в локальном файле.

const readJournal = () => {
  if (!existsSync(JOURNAL_PATH)) return [];

  return readFileSync(JOURNAL_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        warn(`строка ${String(index + 1)} журнала не разбирается, пропущена`);
        return null;
      }
    })
    .filter((record) => record !== null);
};

/**
 * Настройка прогона — то, при совпадении чего два замера сравнимы.
 *
 * Строка служит и ключом сравнения, и подписью в сводке, поэтому
 * читается словами, а не набором чисел: подпись «4 · 4242 · 180»
 * человеку не говорит ничего.
 */
const setupOf = (entry) =>
  [
    entry.profiles.join(' против '),
    matchesOf(entry.matches),
    `зерно ${String(entry.seed)}`,
    entry.seconds === undefined ? 'без предела времени' : `предел ${String(entry.seconds)} с`,
  ].join(' · ');

const recordsOf = (journal, entry) =>
  journal.filter((record) => record.id === entry.id && record.setup === setupOf(entry));

// ── План: что гоняем, что пропускаем и почему ────────────────────────

const today = new Date().toISOString().slice(0, 10);
const sha = git('rev-parse', 'HEAD');

/**
 * Пути, от которых зависит исход матча на арене.
 *
 * Арена безголовая: ни клиента, ни браузера в ней нет вовсе. Правка
 * отрисовки, HUD или лобби изменить исход не может физически, а вот
 * заставить прогнать всю очередь заново — вполне, потому что коммит
 * в main она всё-таки создаёт.
 */
const BALANCE_PATHS = ['packages/shared', 'packages/sim', 'packages/ai', 'apps/arena'];

/**
 * Менялись ли правила игры с того прогона.
 *
 * Не смогли ответить (истории нет, коммит недостижим) — отвечаем «да»:
 * лишний прогон стоит часа машинного времени, пропущенный сдвиг — куда
 * дороже.
 */
const rulesChangedSince = (oldSha) => {
  try {
    return git('diff', '--name-only', `${oldSha}..HEAD`, '--', ...BALANCE_PATHS) !== '';
  } catch {
    return true;
  }
};

const planFor = (entry, journal, spent) => {
  const mine = recordsOf(journal, entry);
  const last = mine.at(-1);

  if (only !== undefined && entry.id !== only) return { skip: 'выбрана другая запись' };
  if (typeof entry.until === 'string' && entry.until < today)
    return { skip: `срок записи вышел ${entry.until}` };

  // Пропуск по неизменившимся правилам — не экономия ради экономии.
  // Матчи детерминированы: пока `packages/sim`, `packages/ai`
  // и `packages/shared` те же, при том же зерне выйдут те же цифры
  // до последнего тика. Прогнать их заново значит занять час и узнать
  // ровно то, что уже записано в журнале.
  if (!runAll && last !== undefined && !rulesChangedSince(last.sha))
    return { skip: `правила игры не менялись с прогона ${last.ranAt.slice(0, 10)}` };

  if (spent + entry.matches > budget)
    return { skip: `не влезает в предел ${String(budget)} матчей за прогон` };

  return { last, first: mine[0] };
};

// ── Прогон одной записи ──────────────────────────────────────────────

const arena = (args, dir) => {
  // `--no-warnings` — потому что арена читает базу через node:sqlite,
  // а он предупреждает о своей экспериментальности при каждом запуске.
  execFileSync(process.execPath, ['--no-warnings', ARENA_MAIN, ...args], {
    stdio: 'inherit',
    env: { ...process.env, ARENA_DIR: dir },
  });
};

const runEntry = (entry) => {
  const dir = join(LOGS_ROOT, entry.id);

  // Каталог сносится целиком, а не дописывается. Прошлый прогон не нужен
  // по строчке: он весь целиком лежит в журнале одной записью, а логи
  // с совпавшими именами матчей смешали бы старые матчи с новыми.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  arena(
    [
      'run',
      '--matches',
      String(entry.matches),
      '--seed',
      String(entry.seed),
      '--profiles',
      entry.profiles.join(','),
      ...(entry.seconds === undefined ? [] : ['--seconds', String(entry.seconds)]),
    ],
    dir,
  );
  arena(['ingest'], dir);

  return metricsOf(join(dir, 'arena.sqlite'));
};

// ── Величины ─────────────────────────────────────────────────────────
//
// Их пять, и каждая отвечает на свой вопрос. Больше брать не стоит:
// сводка, в которой сорок чисел, не читается вовсе, а чем шире набор,
// тем чаще что-нибудь в нём дрогнет и разбудит человека зря.
//
//   доли побед сторон  — кто кого; главный вопрос баланса;
//   доля ничьих        — сколько матчей никто не выиграл;
//   медианная длина    — темп; проектная вилка 10–15 минут в game-design.md;
//   разброс длины      — десятая и девяностая доли: одинаковы ли матчи;
//   исходы             — чем матчи кончались (снесли базу, вышло время).

const quantile = (sorted, share) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];

const metricsOf = (dbPath) => {
  if (!existsSync(dbPath)) die(`база ${dbPath} не создалась — прогон не дал логов`);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare("select winner, ticks, end_reason from match where kind = 'arena'").all();
  db.close();

  const matches = rows.length;
  if (matches === 0) die(`в базе ${dbPath} нет матчей арены`);

  const ticks = rows.map((row) => Number(row.ticks)).sort((left, right) => left - right);
  const reasons = {};
  for (const row of rows)
    reasons[String(row.end_reason)] = (reasons[String(row.end_reason)] ?? 0) + 1;

  const share = (count) => count / matches;

  return {
    matches,
    winShare0: share(rows.filter((row) => row.winner === 0).length),
    winShare1: share(rows.filter((row) => row.winner === 1).length),
    drawShare: share(rows.filter((row) => row.winner === null).length),
    medianTicks: quantile(ticks, 0.5),
    lowTicks: quantile(ticks, 0.1),
    highTicks: quantile(ticks, 0.9),
    reasonShares: Object.fromEntries(
      Object.entries(reasons).map(([reason, count]) => [reason, share(count)]),
    ),
  };
};

// ── Сравнение ────────────────────────────────────────────────────────
//
// Сравнивается с ПРОШЛЫМ прогоном, а не с самым первым. Иначе замеченный
// и принятый сдвиг всплывал бы каждую ночь до скончания века. Плата
// за это — медленное сползание: сдвиг по проценту в неделю ни один порог
// не переступит. Поэтому в таблице рядом со «сдвигом с прошлого раза»
// всегда стоит и «с линии отсчёта» — он ничего не поднимает, но виден.

const asTime = (ticks) => {
  const total = Math.round(ticks / TICKS_PER_SECOND);
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`;
};

const asPercent = (share) => `${(share * 100).toFixed(1)}%`;

const shift = (before, after) => {
  const delta = after - before;
  return `${delta >= 0 ? '+' : '−'}${Math.abs(delta * 100).toFixed(1)} п.п.`;
};

const lengthShift = (before, after) => {
  const delta = before === 0 ? 0 : (after - before) / before;
  return `${delta >= 0 ? '+' : '−'}${Math.abs(delta * 100).toFixed(0)}%`;
};

/**
 * Что разошлось с прошлым разом. Пустой список — цифры на месте.
 *
 * Каждое расхождение несёт не только величину, но и подсказку, куда
 * смотреть. Подсказка механическая — она следует из вида величины,
 * а не из понимания игры, — но она избавляет от первого получаса
 * блуждания по коду.
 */
const divergences = (before, after) => {
  const found = [];

  // Доли побед сторон разбираются вместе, одной строкой. Порознь они
  // дают две записи об одном и том же событии: сколько прибавила одна
  // сторона, столько же потеряла другая.
  const sideMoved = ['winShare0', 'winShare1'].some(
    (key) => Math.abs(after[key] - before[key]) >= WIN_SHARE_STEP,
  );

  if (sideMoved)
    found.push({
      what: 'доли побед сторон',
      before: `${asPercent(before.winShare0)} против ${asPercent(before.winShare1)}`,
      after: `${asPercent(after.winShare0)} против ${asPercent(after.winShare1)}`,
      shift: `${shift(before.winShare0, after.winShare0)} у первой стороны`,
      look:
        'перевес сторон. Смотреть правки в правилах и ценах: ' +
        '`packages/shared/src/balance.ts`, `packages/sim`, `packages/ai`',
    });

  const lengthDelta =
    before.medianTicks === 0 ? 0 : (after.medianTicks - before.medianTicks) / before.medianTicks;

  if (Math.abs(lengthDelta) >= LENGTH_STEP)
    found.push({
      what: 'медианная длина матча',
      before: asTime(before.medianTicks),
      after: asTime(after.medianTicks),
      shift: lengthShift(before.medianTicks, after.medianTicks),
      look:
        'уехал темп матча. Проектная вилка — 10–15 минут, см. `docs/game-design.md`. ' +
        'Смотреть доход, цены и прочность базы',
    });

  const reasons = new Set([
    ...Object.keys(before.reasonShares),
    ...Object.keys(after.reasonShares),
  ]);

  for (const reason of reasons) {
    const was = before.reasonShares[reason] ?? 0;
    const now = after.reasonShares[reason] ?? 0;
    if (Math.abs(now - was) < REASON_SHARE_STEP) continue;

    found.push({
      what: `доля исходов «${reason}»`,
      before: asPercent(was),
      after: asPercent(now),
      shift: shift(was, now),
      look:
        reason === 'timeout'
          ? 'матчи упираются в предел времени — оборона обгоняет наступление'
          : 'изменилось, чем кончаются матчи',
    });
  }

  return found;
};

// ── Отчёт ────────────────────────────────────────────────────────────

const table = (rows) =>
  ['| величина | было | стало | сдвиг |', '|---|---|---|---|', ...rows].join('\n');

const metricRows = (before, after) => {
  const rows = [
    ['доля побед первой стороны', asPercent, 'winShare0'],
    ['доля побед второй стороны', asPercent, 'winShare1'],
    ['доля ничьих', asPercent, 'drawShare'],
  ].map(
    ([label, format, key]) =>
      `| ${label} | ${before === undefined ? '—' : format(before[key])} | ${format(after[key])} | ` +
      `${before === undefined ? '—' : shift(before[key], after[key])} |`,
  );

  rows.push(
    `| медианная длина матча | ${before === undefined ? '—' : asTime(before.medianTicks)} | ` +
      `${asTime(after.medianTicks)} | ` +
      `${before === undefined ? '—' : lengthShift(before.medianTicks, after.medianTicks)} |`,
  );
  rows.push(
    `| длина, от десятой до девяностой доли | ` +
      `${before === undefined ? '—' : `${asTime(before.lowTicks)}–${asTime(before.highTicks)}`} | ` +
      `${asTime(after.lowTicks)}–${asTime(after.highTicks)} | — |`,
  );

  for (const [reason, part] of Object.entries(after.reasonShares))
    rows.push(
      `| исход «${reason}» | ` +
        `${before === undefined ? '—' : asPercent(before.reasonShares[reason] ?? 0)} | ` +
        `${asPercent(part)} | ` +
        `${before === undefined ? '—' : shift(before.reasonShares[reason] ?? 0, part)} |`,
    );

  return rows;
};

const entrySection = (entry, result) => {
  const out = [];
  const { metrics, last, first, found } = result;

  out.push(`### ${entry.id} — ${found.length === 0 ? 'без расхождений' : 'сдвиг'}`);
  out.push('');
  out.push(
    `Задача: **${entry.task}**. ${entry.why}\n\n` +
      `Настройка: ${setupOf(entry)}. Код \`${sha.slice(0, 8)}\`.`,
  );
  out.push('');
  out.push(
    last === undefined
      ? 'Прошлого прогона с такой настройкой нет — эти цифры и станут линией отсчёта.'
      : `Сравнение с прогоном ${last.ranAt.slice(0, 10)} (код \`${last.sha.slice(0, 8)}\`).`,
  );
  out.push('');
  out.push(table(metricRows(last?.metrics, metrics)));

  if (first !== undefined && first !== last) {
    out.push('');
    out.push(
      `С линии отсчёта ${first.ranAt.slice(0, 10)}: доли побед ` +
        `${shift(first.metrics.winShare0, metrics.winShare0)} и ` +
        `${shift(first.metrics.winShare1, metrics.winShare1)}, длина ` +
        `${lengthShift(first.metrics.medianTicks, metrics.medianTicks)}.`,
    );
  }

  out.push('');
  out.push(`Ожидалось: ${entry.expect}`);

  if (found.length > 0) {
    out.push('');
    out.push('Куда смотреть:');
    found.forEach((item, index) =>
      out.push(
        `- **${item.what}** ${item.shift} — ${item.look}${index === found.length - 1 ? '.' : ';'}`,
      ),
    );
  }

  return out.join('\n');
};

const proposals = (shifted) =>
  [
    '## Что с этим делать',
    '',
    'Джоба цифры привела, но судить о них не берётся: сдвиг может быть',
    'и целью правки, и её незамеченным последствием.',
    '',
    '- сдвиг **нежелателен** — заведите изменение OpenSpec на выправление',
    '  и перенесите в него цифры из таблиц выше;',
    '- сдвиг **и был целью** — ничего делать не нужно: следующей ночью',
    '  сравнение пойдёт уже с новыми цифрами, и Issue не повторится.',
    '  Стоит только освежить `expect` в записи очереди, чтобы ожидание',
    '  не расходилось с тем, чего от игры хотят теперь;',
    '- вопрос **закрыт** — закройте задачу в `manage/tasks/`, иначе',
    '  проверка будет гоняться вечно.',
    '',
    `Записей со сдвигом: ${String(shifted.length)} — ${shifted.map((item) => item.entry.id).join(', ')}.`,
  ].join('\n');

// ── Дело ─────────────────────────────────────────────────────────────

const queue = readQueue();
const journal = readJournal();

if (queue.length === 0) {
  ok('очередь проверок баланса пуста — мерить нечего');
  if (summaryPath !== undefined)
    writeFileSync(summaryPath, '## Проверки баланса\n\nОчередь пуста — мерить нечего.\n', 'utf8');
  process.exit(0);
}

// Сборка нужна в любом случае, даже для плана: и арена, и константы игры
// берутся из `dist`, а не из исходников.
if (!existsSync(ARENA_MAIN)) die(`арена не собрана: ${ARENA_MAIN} нет. Сначала \`pnpm build\``);

step(`очередь: ${entries(queue.length)}, код ${sha.slice(0, 8)}`);

const done = [];
const planned = [];
const skipped = [];
let spent = 0;

for (const entry of queue) {
  const plan = planFor(entry, journal, spent);

  if (plan.skip !== undefined) {
    note(`${entry.id}: пропуск — ${plan.skip}`);
    skipped.push({ entry, why: plan.skip });
    continue;
  }

  if (dryRun) {
    note(`${entry.id}: прогнали бы ${matchesOf(entry.matches)} (${setupOf(entry)})`);
    planned.push(entry);
    spent += entry.matches;
    continue;
  }

  step(`${entry.id}: ${matchesOf(entry.matches)}, ${setupOf(entry)}`);
  const metrics = runEntry(entry);
  spent += entry.matches;

  const found = plan.last === undefined ? [] : divergences(plan.last.metrics, metrics);
  done.push({ entry, metrics, last: plan.last, first: plan.first, found });

  appendFileSync(
    JOURNAL_PATH,
    `${JSON.stringify({
      id: entry.id,
      ranAt: new Date().toISOString(),
      sha,
      setup: setupOf(entry),
      task: entry.task,
      metrics,
      diverged: found.map((item) => item.what),
    })}\n`,
    'utf8',
  );
}

// Сводка пишется всегда, даже когда всё на месте: «прогнали и разошлось»
// и «не прогнали вовсе» должны различаться снаружи, иначе молчание джобы
// читается как «баланс в порядке».
const shifted = done.filter((result) => result.found.length > 0);

const summary = [
  `## Проверки баланса, ${today}`,
  '',
  dryRun
    ? `Только план, ни одного матча не сыграно: прогнали бы ${entries(planned.length)} ` +
      `и ${matchesOf(spent)} при пределе в ${matchesOf(budget)}. ` +
      `Пропущено: ${entries(skipped.length)}.`
    : `Прогнано: ${entries(done.length)}, из них со сдвигом: ${String(shifted.length)}. ` +
      `Матчей сыграно: ${matchesOf(spent)} при пределе в ${matchesOf(budget)}. ` +
      `Пропущено: ${entries(skipped.length)}.`,
  '',
  ...done.map((result) => `${entrySection(result.entry, result)}\n`),
  ...(skipped.length === 0
    ? []
    : [
        '### Пропущенные',
        '',
        ...skipped.map((item) => `- \`${item.entry.id}\` — ${item.why};`),
        '',
      ]),
].join('\n');

process.stdout.write(`\n${summary}\n`);

if (summaryPath !== undefined) writeFileSync(summaryPath, `${summary}\n`, 'utf8');

if (issuePath !== undefined && shifted.length > 0)
  writeFileSync(
    issuePath,
    [
      `Ночной прогон очереди проверок баланса ${today} нашёл сдвиг ` +
        `в ${checks(shifted.length)} из ${String(done.length)}.`,
      '',
      ...shifted.map((result) => `${entrySection(result.entry, result)}\n`),
      proposals(shifted),
    ].join('\n'),
    'utf8',
  );

if (dryRun) ok('это был только план — ни одного матча не сыграно');
else if (shifted.length > 0) warn(`сдвиг в ${checks(shifted.length)} — читайте сводку выше`);
else ok('цифры на месте');
