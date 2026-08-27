/**
 * Факторный замер темпа матча.
 *
 * Пять величин по три уровня, полный перебор — 243 сочетания. Перебор
 * именно полный, а не выборочный, и это главное решение здесь: уменьшение
 * карты при одном доходе ускоряет матч, а при другом нет, и увидеть такое
 * можно только прогнав сочетания, а не пары. Выборка по одному параметру
 * за раз ответила бы про середину и умолчала бы про углы.
 *
 * Что меряем. Длину матча в тиках и то, чем матч кончился. Предел матча
 * НЕ поднят намеренно: упор в потолок сам по себе есть показание
 * «затянулся», и поднимать его значило бы платить временем счёта за то,
 * что и так известно.
 *
 * Матчей на ячейку немного — ищется тенденция, а не точное число.
 * Подтверждать найденное положено отдельным прогоном на длинной серии.
 *
 * Зерно у всех ячеек ОДНО И ТО ЖЕ. Тогда разница между ячейками —
 * это разница правил, а не разных случайных карт; сравнение выходит
 * парным и куда чувствительнее при том же числе матчей.
 *
 *   node --no-warnings scripts/experiment/tempo-factorial.mjs \
 *     --shard 0 --of 12 --matches 5 --out shard-0.json
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARENA_MAIN = join(repoRoot, 'apps', 'arena', 'dist', 'main.js');
const LOGS_ROOT = join(repoRoot, '.matchlog', 'experiment');

// ── Матрица ──────────────────────────────────────────────────────────

/**
 * Уровни взяты по границам задачи: доход и прочность двигаются только
 * вверх, скорость и радиус — в обе стороны, карта ±50 процентов.
 *
 * Порядок ключей и уровней устойчив: по нему сходятся номера ячеек между
 * задачами, а значит и между прогонами.
 */
export const FACTORS = {
  income: [1, 1.5, 2],
  speed: [0.75, 1, 1.25],
  towerHp: [1, 1.5, 2],
  radius: [0.75, 1, 1.25],
  map: [0.5, 1, 1.5],
};

/** Ключ множителя в арене. Имена намеренно человеческие, а не как в коде. */
const FLAG_OF = {
  income: '--income',
  speed: '--speed',
  towerHp: '--tower-hp',
  baseHp: '--base-hp',
  radius: '--radius',
  map: '--map',
};

/**
 * Ячейки перебора. Без набора величин берётся полная матрица.
 *
 * Свой набор нужен точечной развёртке: когда вопрос уже сужен до одной-двух
 * величин, гнать все 243 сочетания незачем — ответ утонет в усреднении
 * по тому, что спрашивать не собирались.
 */
export const cells = (factors = FACTORS) => {
  for (const key of Object.keys(factors)) {
    if (FLAG_OF[key] === undefined) {
      throw new Error(`неизвестная величина «${key}»; есть: ${Object.keys(FLAG_OF).join(', ')}`);
    }
  }

  let out = [{}];

  for (const [key, levels] of Object.entries(factors)) {
    const next = [];
    for (const base of out) for (const level of levels) next.push({ ...base, [key]: level });
    out = next;
  }

  return out.map((values, index) => ({ id: `c${String(index).padStart(3, '0')}`, ...values }));
};

/**
 * Раздать ячейки по задачам чередованием, а не куском подряд.
 *
 * Соседние по номеру ячейки отличаются только последней величиной —
 * размером карты, — и нарезка подряд сложила бы все большие карты
 * в одну задачу. Она бы и стала самой долгой, а остальные простаивали бы.
 */
export const shardOf = (list, shard, of) => list.filter((_cell, index) => index % of === shard);

// ── Ключи ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at !== -1 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};
const numeric = (name, fallback) => Number(flag(name, String(fallback)));

// ── Прогон одной ячейки ──────────────────────────────────────────────

const arena = (args, dir) => {
  execFileSync(process.execPath, ['--no-warnings', ARENA_MAIN, ...args], {
    stdio: 'inherit',
    env: { ...process.env, ARENA_DIR: dir },
  });
};

const quantile = (sorted, share) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];

const metricsOf = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });

  const rows = db.prepare("select winner, ticks, end_reason from match where kind = 'arena'").all();
  // Средние по ходу матча — не итог, а объяснение итога: они говорят,
  // ЧЕМ ячейка отличается, а не только насколько она быстрее.
  const shape = db
    .prepare(
      `select avg(units_alive) as units, avg(towers) as towers, avg(walls) as walls,
              avg(energy) as energy, avg(income_per_tick) as income,
              max(upgrade_total_level) as upgrades
         from sample`,
    )
    .all()[0];

  db.close();

  const ticks = rows.map((row) => Number(row.ticks)).sort((a, b) => a - b);
  const matches = rows.length;
  const share = (predicate) => (matches === 0 ? 0 : rows.filter(predicate).length / matches);

  return {
    matches,
    medianTicks: quantile(ticks, 0.5),
    minTicks: ticks[0] ?? 0,
    maxTicks: ticks[ticks.length - 1] ?? 0,
    meanTicks: matches === 0 ? 0 : Math.round(ticks.reduce((sum, it) => sum + it, 0) / matches),
    timeoutShare: share((row) => row.end_reason === 'timeout'),
    winShare0: share((row) => row.winner === 0),
    winShare1: share((row) => row.winner === 1),
    // Каждое число округляется: это тенденция, а не точный отсчёт,
    // и пятнадцать знаков после запятой только мешали бы читать.
    avgUnits: Math.round(Number(shape?.units ?? 0) * 10) / 10,
    avgTowers: Math.round(Number(shape?.towers ?? 0) * 10) / 10,
    avgWalls: Math.round(Number(shape?.walls ?? 0) * 10) / 10,
    avgEnergy: Math.round(Number(shape?.energy ?? 0)),
    avgIncome: Math.round(Number(shape?.income ?? 0) * 10) / 10,
    maxUpgrades: Number(shape?.upgrades ?? 0),
  };
};

const runCell = (cell, { matches, seed, profiles, jobs }) => {
  const dir = join(LOGS_ROOT, cell.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const started = Date.now();

  try {
    arena(
      [
        'run',
        '--matches',
        String(matches),
        '--seed',
        String(seed),
        '--profiles',
        profiles,
        '--jobs',
        String(jobs),
        // Перебираются только те величины, что есть в ячейке: остальные
        // остаются задуманными, и передавать по ним «единицу» незачем —
        // лишний ключ в строке запуска читался бы как «здесь тоже правили».
        ...Object.keys(FLAG_OF)
          .filter((key) => cell[key] !== undefined)
          .flatMap((key) => [FLAG_OF[key], String(cell[key])]),
      ],
      dir,
    );
    arena(['ingest'], dir);

    const dbPath = join(dir, 'arena.sqlite');
    if (!existsSync(dbPath)) throw new Error('база не создалась — прогон не дал логов');

    return {
      ...cell,
      wallSeconds: Math.round((Date.now() - started) / 1000),
      ...metricsOf(dbPath),
    };
  } catch (error) {
    // Ячейка, которая не считается, — это тоже результат, и он ценнее
    // молчания: крайние сочетания (тесная карта при раздутом радиусе)
    // вполне могут оказаться неиграбельными. Ронять из-за одной такой
    // остальные двенадцать нельзя.
    return {
      ...cell,
      wallSeconds: Math.round((Date.now() - started) / 1000),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Логи сносятся сразу: подробная запись матча весит мегабайты,
    // а нужна она только до сборки базы. Диск runner'а не резиновый.
    rmSync(dir, { recursive: true, force: true });
  }
};

// ── Точка входа ──────────────────────────────────────────────────────

const shard = numeric('shard', 0);
const of = Math.max(1, numeric('of', 1));
const matches = numeric('matches', 5);
const seed = numeric('seed', 9000);
const jobs = numeric('jobs', 2);
const profiles = flag('profiles', 'baseline-2026-08,baseline-2026-08');
const out = flag('out', `experiment-shard-${String(shard)}.json`);
const only = flag('only', '');
const factorsRaw = flag('factors', '');

const all = cells(factorsRaw === '' ? undefined : JSON.parse(factorsRaw));
const mine = only === '' ? shardOf(all, shard, of) : all.filter((cell) => cell.id === only);

process.stdout.write(
  `ячеек всего ${String(all.length)}, в этой задаче ${String(mine.length)} ` +
    `(доля ${String(shard)} из ${String(of)}), матчей на ячейку ${String(matches)}\n` +
    `величины: ${factorsRaw === '' ? 'полная матрица' : factorsRaw}\n`,
);

const results = [];
for (const [index, cell] of mine.entries()) {
  const shown = Object.keys(FLAG_OF)
    .filter((key) => cell[key] !== undefined)
    .map((key) => `${key} ×${String(cell[key])}`)
    .join(', ');

  process.stdout.write(`\n── ${cell.id} (${String(index + 1)}/${String(mine.length)}): ${shown}\n`);

  results.push(runCell(cell, { matches, seed, profiles, jobs }));
  writeFileSync(out, JSON.stringify({ seed, matches, profiles, results }, null, 2), 'utf8');
}

const broken = results.filter((row) => row.error !== undefined).length;
process.stdout.write(
  `\nготово: ячеек ${String(results.length)}, не сосчиталось ${String(broken)}; итог в ${out}\n`,
);
