#!/usr/bin/env node
/**
 * Замер стоимости тика симуляции.
 *
 *   pnpm bench:tick                   замерить
 *   pnpm bench:tick -- --ticks 4000   сколько тиков считать за прогон
 *   pnpm bench:tick -- --repeats 5    сколько прогонов, берётся медиана
 *   pnpm bench:tick -- --seed 7       какой мир считать
 *   pnpm bench:tick -- --force        мерить, не глядя на занятость машины
 *   pnpm bench:tick -- --history      показать прошлые замеры
 *
 * Здесь нет ни браузера, ни сервера, ни записи на диск: только ядро
 * симуляции и решения компьютерных сторон. Поэтому цифра сравнима
 * и между прогонами, и между машинами — в отличие от кадров в секунду,
 * которые без живой видеокарты мерить бессмысленно вовсе.
 *
 * Из этого же следует, что именно такой замер имеет смысл гонять
 * в контейнере с выделенной долей процессора; как — в `docker/bench.md`.
 *
 * Считается медиана нескольких прогонов, а не среднее: одна случайная
 * задержка от сборщика мусора или чужого процесса сдвигает среднее
 * и не трогает медиану.
 *
 * Импорт идёт прямо из `dist` по относительному пути, а не по имени
 * пакета. Причина простая: `@td/sim` не значится в зависимостях корня
 * репозитория, и по имени отсюда не разрешился бы. Внутри самого `dist`
 * импорты разрешаются как обычно, относительно своего пакета.
 */

import { createOpponent } from '../packages/ai/dist/index.js';
import { createWorld, step as stepWorld } from '../packages/sim/dist/index.js';
import {
  die,
  note,
  printHistory,
  recordEntry,
  requireQuietMachine,
  step,
  warn,
  BUSY_LIMIT,
} from './perf-common.mjs';

// ── Ключи ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const force = argv.includes('--force');

const numeric = (name, fallback) => {
  const at = argv.indexOf(name);
  if (at === -1 || argv[at + 1] === undefined) return fallback;
  const value = Number(argv[at + 1]);
  if (!Number.isFinite(value) || value <= 0) die(`${name} ожидает положительное число`);
  return value;
};

const ticks = numeric('--ticks', 3000);
const repeats = numeric('--repeats', 3);

// Повторы гоняют ОДНО И ТО ЖЕ зерно, а не разные.
//
// Это принципиально. Симуляция детерминирована: при одном зерне работа
// повторяется тик в тик, и любой разброс между прогонами — машинный шум,
// то есть ровно то, что повтор и должен измерять. Разные зёрна дают миры
// разной тяжести (разные карты, разное число юнитов), и их разброс
// говорил бы о выборе зерна, а не о состоянии машины: замер выглядел бы
// шумным там, где шума нет.
//
// Сменить мир можно ключом --seed; сравнивать замеры имеет смысл только
// при одном и том же зерне.
const seed = numeric('--seed', 1);

if (argv.includes('--history')) {
  printHistory();
  process.exit(0);
}

// ── Один прогон ──────────────────────────────────────────────────────
//
// Повторяет цикл арены: обе стороны думают, их команды уходят в шаг мира.
// Ровно то, что происходит на сервере в живом матче, — за вычетом сети
// и записи, которые к стоимости счёта отношения не имеют.
const oneRun = (worldSeed) => {
  let world = createWorld(worldSeed);
  const opponents = [createOpponent(0, worldSeed), createOpponent(1, worldSeed + 1)];

  const started = process.hrtime.bigint();

  let done = 0;
  for (; done < ticks && world.winner === null; done += 1) {
    const issued = [];
    for (const opponent of opponents) issued.push(...opponent.decide(world));
    world = stepWorld(world, issued);
  }

  const elapsedNs = Number(process.hrtime.bigint() - started);
  return { done, micros: elapsedNs / done / 1000 };
};

// ── Замер ────────────────────────────────────────────────────────────
step('Смотрю, свободна ли машина');
const busy = await requireQuietMachine({ force });

step(`Считаю ${ticks} тиков ${repeats} раз на зерне ${seed}`);
if (force && busy > BUSY_LIMIT) warn('машина занята, к цифре относитесь как к оценке');

// Первый прогон выбрасывается: на нём JIT ещё разогревается, и он
// стабильно медленнее остальных — то есть измерял бы разогрев, а не код.
oneRun(seed);

const runs = [];
for (let attempt = 1; attempt <= repeats; attempt += 1) {
  const result = oneRun(seed);
  note(`прогон ${attempt}: ${result.micros.toFixed(1)} мкс на тик (${result.done} тиков)`);
  runs.push(result.micros);
}

const sorted = [...runs].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const spread = sorted[sorted.length - 1] - sorted[0];

note(`разброс между прогонами: ${spread.toFixed(1)} мкс`);

recordEntry({
  kind: 'тик',
  // Единица измерения стоит в названии, а не отдельным полем: величин
  // здесь две и единицы у них разные.
  measurements: {
    'тик симуляции, мкс': Math.round(median * 10) / 10,
    'тиков в секунду': Math.round(1e6 / median),
  },
  busy,
  passed: true,
  unit: '',
});
