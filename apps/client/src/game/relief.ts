import { MAP_HEIGHT_CELLS, MAP_WIDTH_CELLS, Terrain } from '@td/shared';
import type { GameMap } from '@td/sim';
import { hashOf } from './noise.js';
import { rockHeight } from './rocks.js';

/**
 * Поверхность скального массива.
 *
 * Прежде скала была телом из плоско залитых граней: усечённая пирамида
 * на клетку, четыре заливки, обводка рёбер. Грань залита одним цветом
 * на всю площадь, поэтому поверхности у камня не было нигде — был силуэт
 * и три оттенка на нём.
 *
 * Здесь скала перестаёт быть телом и становится участком непрерывного
 * поля высот. Высоты клеток берутся прежние, тем же хешем координат,
 * но сглаживаются в единый хребет.
 *
 * ## Главное правило модуля: фактура не входит в геометрию
 *
 * Складки, зерно и крошка меняют только направление, куда смотрит
 * поверхность (`grainOffset`), и НЕ входят в её высоту (`surfaceHeight`).
 * Это не стилистический выбор, а вывод из пробы: тот же шум, внесённый
 * в высоту, превращает гряду в осыпь белых катышков — шум с длиной волны
 * меньше шага выборки делает из гладкого склона частокол столбиков,
 * и сглаживанием это уже не чинится.
 *
 * Разделение и даёт весь приём: силуэт задаёт поле высот и остаётся
 * гладким, а подробности живут в освещении, где их может быть сколько
 * угодно.
 *
 * ## Это образцовая реализация, а не боевая
 *
 * Функции здесь чистые и считаются на процессоре — так их можно покрыть
 * тестами и по ним же написать шейдер. Для кадра они не годятся и не
 * предназначены: наивный расчёт измерен и стоит полторы секунды
 * на сорок две клетки. В кадре работает запечённая текстура.
 */

/** Занята ли клетка скалой. За краем карты скалы нет. */
export const isRockCell = (map: GameMap, x: number, y: number): boolean => {
  if (x < 0 || y < 0 || x >= MAP_WIDTH_CELLS || y >= MAP_HEIGHT_CELLS) return false;

  return map.cells[y * MAP_WIDTH_CELLS + x] !== Terrain.Ground;
};

/** Высота клетки для поля: своя у скальной, ноль у проходимой. */
export const cellHeight = (map: GameMap, x: number, y: number): number =>
  isRockCell(map, x, y) ? rockHeight(x, y) : 0;

// ─────────────────────────────────────────────────────────────────────────
// Дробный шум
// ─────────────────────────────────────────────────────────────────────────

/**
 * Значение решётчатого шума в узле.
 *
 * Хеш берётся общий, из `noise.ts`: тот же, которым пользуются излом
 * разряда и разлёт обломков. Своего заводить незачем, а два разных хеша
 * в одном рендере рано или поздно разъедутся в поведении.
 */
const latticeValue = (x: number, y: number, seed: number): number =>
  hashOf([x, y, seed]) / 0x1_0000_0000;

/** Сглаживающая кривая Эрмита. Даёт нулевую производную на концах. */
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/**
 * Гладкий шум по решётке единичного шага, значения в [0, 1).
 *
 * Именно гладкий, а не поток случайных чисел из `noise.ts`: там числа
 * независимы, а здесь соседние точки обязаны быть близки — иначе
 * поверхность не получится, получится помеха.
 *
 * `period` замыкает решётку на себя. Он нужен фактуре: её уклон
 * запекается в замощаемую плитку, а плитка сходится без шва только
 * тогда, когда узлы решётки повторяются целое число раз. Ноль означает
 * «не замыкать» — так работает рельеф, которому замощение ни к чему.
 */
export const valueNoise = (x: number, y: number, seed: number, period = 0): number => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smoothstep(x - xi);
  const v = smoothstep(y - yi);

  const wrap = (n: number): number => (period > 0 ? ((n % period) + period) % period : n);
  const x0 = wrap(xi);
  const y0 = wrap(yi);
  const x1 = wrap(xi + 1);
  const y1 = wrap(yi + 1);

  const a = latticeValue(x0, y0, seed);
  const b = latticeValue(x1, y0, seed);
  const c = latticeValue(x0, y1, seed);
  const d = latticeValue(x1, y1, seed);

  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
};

/**
 * Сумма октав: каждая следующая вдвое чаще и вдвое слабее.
 *
 * Результат нормирован суммой весов, поэтому остаётся в [0, 1)
 * при любом числе октав. Без нормировки амплитуда зависела бы от их
 * количества, и подбирать множители пришлось бы заново при каждой
 * правке подробности.
 */
export const fbm = (
  x: number,
  y: number,
  seed: number,
  octaves: number,
  period = 0,
): number => {
  let sum = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let total = 0;

  for (let octave = 0; octave < octaves; octave += 1) {
    // Период удваивается вместе с частотой: у каждой октавы своя решётка,
    // и замкнуться на себя обязана каждая, иначе шов даст самая мелкая.
    sum += amplitude * valueNoise(x * frequency, y * frequency, seed + octave * 7, period * frequency);
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }

  return sum / total;
};

// ─────────────────────────────────────────────────────────────────────────
// Поле высот
// ─────────────────────────────────────────────────────────────────────────

/** Ширина полосы сглаживания, в клетках. Больше — глаже переход между уровнями. */
const SMOOTH_TIGHTNESS = 0.85;

/** Полуширина окна выборки, в клетках. Дальше вес гауссианы пренебрежимо мал. */
const WINDOW = 2;

/** Гауссово среднее величины по клеткам вокруг точки. */
const around = (
  map: GameMap,
  u: number,
  v: number,
  tightness: number,
  value: (x: number, y: number) => number,
): number => {
  // Центры клеток лежат на полуцелых координатах, поэтому отсчёт идёт
  // от `u - 0.5`: иначе окно смещается на половину клетки и гряда
  // уползает от своего следа на карте.
  const cx = u - 0.5;
  const cy = v - 0.5;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);

  let sum = 0;
  let weights = 0;

  for (let j = -WINDOW; j <= WINDOW + 1; j += 1) {
    for (let i = -WINDOW; i <= WINDOW + 1; i += 1) {
      const x = x0 + i;
      const y = y0 + j;
      const dx = cx - x;
      const dy = cy - y;
      const weight = Math.exp(-(dx * dx + dy * dy) * tightness);

      sum += value(x, y) * weight;
      weights += weight;
    }
  }

  return sum / weights;
};

/** Высоты клеток, сглаженные в непрерывную поверхность. */
export const smoothHeight = (map: GameMap, u: number, v: number): number =>
  around(map, u, v, SMOOTH_TIGHTNESS, (x, y) => cellHeight(map, x, y));

/** То же, но окном пошире. Нужно затенению: с чем сравнивать точку. */
export const wideHeight = (map: GameMap, u: number, v: number): number =>
  around(map, u, v, 0.22, (x, y) => cellHeight(map, x, y));

/**
 * Расстояние от точки до края каменной области, в клетках.
 *
 * Считается по клеткам-соседям, а не размытием, и это существенно.
 * Размытие даёт границу, не совпадающую с клеткой, и подножие идёт
 * фестонами — проверено, выглядит браком. Здесь же граница ровно там,
 * где кончается клетка.
 *
 * Вне скалы возвращается ноль: точка уже за краем.
 */
export const edgeDistance = (map: GameMap, u: number, v: number): number => {
  const x = Math.floor(u);
  const y = Math.floor(v);
  if (!isRockCell(map, x, y)) return 0;

  let distance = Number.POSITIVE_INFINITY;

  if (!isRockCell(map, x - 1, y)) distance = Math.min(distance, u - x);
  if (!isRockCell(map, x + 1, y)) distance = Math.min(distance, x + 1 - u);
  if (!isRockCell(map, x, y - 1)) distance = Math.min(distance, v - y);
  if (!isRockCell(map, x, y + 1)) distance = Math.min(distance, y + 1 - v);

  // Вогнутый угол: обе прямые соседки — скалы, а диагональная нет.
  // Без этого случая подножие в углу обрывалось бы уступом.
  for (let i = -1; i <= 1; i += 2) {
    for (let j = -1; j <= 1; j += 2) {
      if (isRockCell(map, x + i, y + j)) continue;

      const cornerX = i < 0 ? x : x + 1;
      const cornerY = j < 0 ? y : y + 1;
      distance = Math.min(distance, Math.hypot(u - cornerX, v - cornerY));
    }
  }

  // Ни один сосед по кольцу не проходим — точка в глубине массива.
  // Ближайший край тогда лежит за этим кольцом, то есть не ближе клетки:
  // даже стоя вплотную к границе своей клетки, до внешней стороны
  // соседней остаётся ровно единица. Единица и есть верная нижняя оценка.
  //
  // Число здесь не косметическое. Любое значение меньше `FOOT_WIDTH_CELLS`
  // просаживало бы высоту по всей внутренности крупного массива —
  // незаметно на глаз и совершенно неверно.
  return Number.isFinite(distance) ? distance : 1;
};

/** Ширина подножия, в клетках: на этом расстоянии от края высота набирается полностью. */
export const FOOT_WIDTH_CELLS = 0.62;

/**
 * Множитель подножия: ноль на границе клетки, единица вглубь массива.
 *
 * Обрыв у границы — не остаток прежней геометрии, а требование. Скала
 * обязана читаться непроходимой, а её след на карте — совпадать
 * с клетками, по которым игрок читает, где пройдёт войско. Пологое
 * подножие, переходящее в землю, обещало бы подъём, которого правила
 * не дают.
 */
export const footFactor = (map: GameMap, u: number, v: number): number => {
  const distance = edgeDistance(map, u, v);
  if (distance <= 0) return 0;
  if (distance >= FOOT_WIDTH_CELLS) return 1;

  return smoothstep(distance / FOOT_WIDTH_CELLS);
};

/** Зерно хребтового шума. Своё у каждого слоя, чтобы слои не совпадали. */
const RIDGE_SEED = 11;

/**
 * Высота поверхности в точке, в клетках.
 *
 * Хребтовой шум — это `1 - |2n - 1|`: у обычного шума гребни круглые,
 * а у этого на месте среднего значения получается излом. Гряда из него
 * выходит с рёбрами, а не из холмиков.
 */
export const surfaceHeight = (map: GameMap, u: number, v: number): number => {
  const base = smoothHeight(map, u, v);
  if (base < 0.004) return 0;

  const ridged = 1 - Math.abs(fbm(u * 0.66, v * 0.66, RIDGE_SEED, 3) * 2 - 1);

  return base * (0.72 + 0.52 * ridged) * footFactor(map, u, v);
};

// ─────────────────────────────────────────────────────────────────────────
// Фактура
// ─────────────────────────────────────────────────────────────────────────

/** Шаг численной производной, в клетках. Общий у рельефа и у фактуры. */
const STEP = 0.02;

/**
 * Сторона плитки фактуры, в клетках.
 *
 * Пять, а не любое круглое число. Замощение бесшовно только тогда, когда
 * период решётки — целое число узлов у КАЖДОЙ октавы; самая низкая
 * частота фактуры — 2,6 на клетку, и первое `T`, при котором 2,6 × `T`
 * целое, это пятёрка (13 узлов).
 */
export const GRAIN_TILE_CELLS = 5;

/**
 * Возмущение поверхности фактурой породы, в клетках высоты.
 *
 * В геометрию НЕ входит — только в нормаль. Три слоя отвечают за разное:
 * складки дают крупный рисунок породы, зерно — шероховатость, крошка —
 * мелкую сыпь на границе различимости.
 *
 * Функция периодична с шагом `GRAIN_TILE_CELLS`, и это не украшение:
 * её уклон запекается в замощаемую плитку, а образцовая реализация
 * на процессоре обязана считать ровно то же, что видеокарта, — иначе
 * сверять их будет нечем.
 */
export const grainOffset = (u: number, v: number): number => {
  const period = GRAIN_TILE_CELLS;
  const folds = fbm(u * 2.6, v * 2.6, 31, 3, 2.6 * period) - 0.5;
  const grain = fbm(u * 9, v * 9, 47, 3, 9 * period) - 0.5;
  const crumb = fbm(u * 24, v * 24, 61, 2, 24 * period) - 0.5;

  return folds * 0.24 + grain * 0.055 + crumb * 0.012;
};

/** Уклон фактуры в точке: то, что кладётся в плитку и складывается с уклоном рельефа. */
export const grainSlope = (u: number, v: number): { readonly du: number; readonly dv: number } => ({
  du: (grainOffset(u + STEP, v) - grainOffset(u - STEP, v)) / (2 * STEP),
  dv: (grainOffset(u, v + STEP) - grainOffset(u, v - STEP)) / (2 * STEP),
});

/** Направление, куда смотрит поверхность. Единичной длины. */
export interface SurfaceNormal {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Нормаль поверхности с учётом фактуры.
 *
 * Уклон складывается из двух слагаемых: настоящего, от поля высот,
 * и мнимого, от фактуры. Второе меняет освещение, но не силуэт —
 * ровно в этом весь приём.
 */
export const surfaceNormal = (map: GameMap, u: number, v: number): SurfaceNormal => {
  const slopeX =
    (surfaceHeight(map, u + STEP, v) - surfaceHeight(map, u - STEP, v)) / (2 * STEP) +
    (grainOffset(u + STEP, v) - grainOffset(u - STEP, v)) / (2 * STEP);
  const slopeY =
    (surfaceHeight(map, u, v + STEP) - surfaceHeight(map, u, v - STEP)) / (2 * STEP) +
    (grainOffset(u, v + STEP) - grainOffset(u, v - STEP)) / (2 * STEP);

  const length = Math.sqrt(slopeX * slopeX + slopeY * slopeY + 1);

  return { x: -slopeX / length, y: -slopeY / length, z: 1 / length };
};
