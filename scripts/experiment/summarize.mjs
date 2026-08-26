/**
 * Свод факторного замера: из долей — одна таблица и одна картина влияния.
 *
 * Считается здесь три вещи, и третья — главная.
 *
 * Первая: средний отклик по уровню каждой величины. Это «главный эффект»:
 * насколько длиннее матч, когда доход вдвое, если про остальное не спрашивать.
 *
 * Вторая: разброс внутри уровня. Без него средний эффект обманчив —
 * величина может в среднем не значить ничего, потому что в одной половине
 * матрицы ускоряет, а в другой ровно настолько же замедляет.
 *
 * Третья: парные взаимодействия. Ровно та причина, по которой перебор
 * сделан полным: «уменьшение карты при одних параметрах не даёт ускорения,
 * а при других даёт». Мерка простая — насколько эффект одной величины
 * зависит от уровня другой; если не зависит вовсе, число около нуля.
 *
 *   node --no-warnings scripts/experiment/summarize.mjs shards \
 *     --out tempo-factorial.json --summary tempo-summary.md
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at !== -1 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};

const dir = argv[0] ?? 'shards';
const outPath = flag('out', 'tempo-factorial.json');
const summaryPath = flag('summary', 'tempo-summary.md');

const FACTOR_LABELS = {
  income: 'доход',
  speed: 'скорость',
  towerHp: 'прочность башен',
  radius: 'радиус юнитов',
  map: 'размер карты',
};
const FACTORS = Object.keys(FACTOR_LABELS);

// ── Сбор ─────────────────────────────────────────────────────────────

const results = [];
let seed = 0;
let matches = 0;

for (const name of readdirSync(dir)) {
  if (!name.endsWith('.json')) continue;

  const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  seed = parsed.seed ?? seed;
  matches = parsed.matches ?? matches;
  results.push(...(parsed.results ?? []));
}

results.sort((left, right) => left.id.localeCompare(right.id));

const good = results.filter((row) => row.error === undefined && row.matches > 0);
const broken = results.filter((row) => row.error !== undefined || row.matches === 0);

// ── Величины ─────────────────────────────────────────────────────────

const TICKS_PER_SECOND = 30;
const asTime = (ticks) => {
  const total = Math.round(ticks / TICKS_PER_SECOND);
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`;
};

const mean = (list) =>
  list.length === 0 ? 0 : list.reduce((sum, it) => sum + it, 0) / list.length;

/** Отклик ячейки. Медиана длины — то, ради чего замер и затевался. */
const response = (row) => row.medianTicks;

const levelsOf = (factor) => [...new Set(good.map((row) => row[factor]))].sort((a, b) => a - b);

/** Средний отклик по уровню величины и разброс внутри уровня. */
const mainEffect = (factor) =>
  levelsOf(factor).map((level) => {
    const at = good.filter((row) => row[factor] === level);
    const values = at.map(response);
    const centre = mean(values);

    return {
      level,
      cells: at.length,
      meanTicks: Math.round(centre),
      spreadTicks: Math.round(
        Math.sqrt(mean(values.map((value) => (value - centre) * (value - centre)))),
      ),
      timeoutShare: Math.round(mean(at.map((row) => row.timeoutShare)) * 100) / 100,
    };
  });

/**
 * Взаимодействие двух величин.
 *
 * Считается так: для каждого уровня второй величины берётся размах отклика
 * по первой («сколько даёт доход, когда карта маленькая»), и смотрится,
 * насколько эти размахи расходятся между собой. Расходятся — значит одна
 * величина меняет действие другой, и говорить о них по отдельности нельзя.
 */
const interaction = (first, second) => {
  const spans = levelsOf(second).map((level) => {
    const at = good.filter((row) => row[second] === level);
    const byLevel = levelsOf(first).map((own) =>
      mean(at.filter((row) => row[first] === own).map(response)),
    );
    return Math.max(...byLevel) - Math.min(...byLevel);
  });

  return {
    first,
    second,
    spans: spans.map((span) => Math.round(span)),
    divergenceTicks: Math.round(Math.max(...spans) - Math.min(...spans)),
  };
};

const pairs = [];
for (let i = 0; i < FACTORS.length; i += 1) {
  for (let j = i + 1; j < FACTORS.length; j += 1) {
    pairs.push(interaction(FACTORS[i], FACTORS[j]));
  }
}
pairs.sort((left, right) => right.divergenceTicks - left.divergenceTicks);

// ── Вывод ────────────────────────────────────────────────────────────

const summary = [];
summary.push('## Факторный замер темпа матча');
summary.push('');
summary.push(
  `Ячеек ${String(results.length)}, сосчиталось ${String(good.length)}, ` +
    `не сосчиталось ${String(broken.length)}. Матчей на ячейку ${String(matches)}, ` +
    `зерно ${String(seed)} у всех одно.`,
);
summary.push('');

if (good.length > 0) {
  const sorted = [...good].sort((left, right) => response(left) - response(right));
  summary.push(
    `Самый быстрый матч: ${sorted[0].id} — ${asTime(response(sorted[0]))}. ` +
      `Самый долгий: ${sorted[sorted.length - 1].id} — ` +
      `${asTime(response(sorted[sorted.length - 1]))}.`,
  );
  summary.push('');

  summary.push('### Главные эффекты');
  summary.push('');
  summary.push('| величина | уровень | ячеек | медиана | разброс | таймаутов |');
  summary.push('|---|---|---|---|---|---|');

  for (const factor of FACTORS) {
    for (const row of mainEffect(factor)) {
      summary.push(
        `| ${FACTOR_LABELS[factor]} | ×${String(row.level)} | ${String(row.cells)} | ` +
          `${asTime(row.meanTicks)} | ±${asTime(row.spreadTicks)} | ` +
          `${String(Math.round(row.timeoutShare * 100))}% |`,
      );
    }
  }

  summary.push('');
  summary.push('### Взаимодействия');
  summary.push('');
  summary.push(
    'Насколько действие одной величины зависит от уровня другой. ' +
      'Число около нуля означает, что величины независимы и о них можно ' +
      'говорить порознь; большое — что нельзя.',
  );
  summary.push('');
  summary.push('| пара | размахи по уровням | расхождение |');
  summary.push('|---|---|---|');

  for (const pair of pairs) {
    summary.push(
      `| ${FACTOR_LABELS[pair.first]} × ${FACTOR_LABELS[pair.second]} | ` +
        `${pair.spans.map(asTime).join(' · ')} | ${asTime(pair.divergenceTicks)} |`,
    );
  }
}

if (broken.length > 0) {
  summary.push('');
  summary.push('### Не сосчиталось');
  summary.push('');
  for (const row of broken) {
    summary.push(`- \`${row.id}\` — ${row.error ?? 'ноль матчей в базе'}`);
  }
}

writeFileSync(
  outPath,
  JSON.stringify(
    {
      seed,
      matches,
      results,
      mainEffects: Object.fromEntries(FACTORS.map((f) => [f, mainEffect(f)])),
      interactions: pairs,
    },
    null,
    2,
  ),
  'utf8',
);
writeFileSync(summaryPath, `${summary.join('\n')}\n`, 'utf8');

process.stdout.write(`${summary.join('\n')}\n`);
