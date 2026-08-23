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
export const fbm = (x: number, y: number, seed: number, octaves: number, period = 0): number => {
  let sum = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let total = 0;

  for (let octave = 0; octave < octaves; octave += 1) {
    // Период удваивается вместе с частотой: у каждой октавы своя решётка,
    // и замкнуться на себя обязана каждая, иначе шов даст самая мелкая.
    sum +=
      amplitude * valueNoise(x * frequency, y * frequency, seed + octave * 7, period * frequency);
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

const smoothExact = (map: GameMap, u: number, v: number): number =>
  around(map, u, v, SMOOTH_TIGHTNESS, (x, y) => cellHeight(map, x, y));

const wideExact = (map: GameMap, u: number, v: number): number =>
  around(map, u, v, 0.22, (x, y) => cellHeight(map, x, y));

// ─────────────────────────────────────────────────────────────────────────
// Сетка сглаженного поля
// ─────────────────────────────────────────────────────────────────────────

/**
 * Сглаженное поле считается один раз на карту, а не при каждом обращении.
 *
 * Гауссиана по тридцати шести соседям — это тридцать шесть `Math.exp`,
 * и вызывается она по шесть раз на каждую вершину сетки. Замерено:
 * вершины семидесяти клеток стоили 2594 мс, то есть около тринадцати
 * секунд на карту с обычной долей скал — выше бюджета загрузки.
 *
 * Брать поле с сетки законно, потому что оно НИЗКОЧАСТОТНОЕ по своей
 * природе: это высоты клеток, размазанные гауссианой шириной больше
 * клетки. Четырёх узлов на клетку хватает с запасом.
 *
 * Хребтовой шум и подножие с сетки НЕ берутся и считаются точно.
 * У подножия перепад укладывается в 0,62 клетки, а у шума излом острый —
 * оба на такой сетке размазались бы, и как раз они отвечают за силуэт.
 */
const FIELD_PER_CELL = 4;

/** Запас по краю: поле спрашивают и чуть за границей карты. */
const FIELD_MARGIN_CELLS = 1;

interface SmoothField {
  readonly base: Float32Array;
  readonly wide: Float32Array;
  /** Глубина массива: сглаженное расстояние до ближайшей проходимой клетки. */
  readonly bulk: Float32Array;
  readonly pitch: number;
}

/**
 * Расстояние каждой клетки до ближайшей проходимой, в клетках.
 *
 * Обход в ширину от всех проходимых клеток разом. За краем карты
 * считается проходимо: скала у границы массивом не является, и высоты
 * ей набирать не за что.
 *
 * Зачем это нужно. Высота клетки берётась из хеша её координат, то есть
 * одиночная скала и середина большого массива получали одинаковые
 * шансы на высоту. В природе наоборот: чем шире подошва, тем выше может
 * стоять вершина, и гряда три на три обязана быть заметно ниже гряды
 * пять на пять. Глубина и есть та величина, которой этого не хватало.
 */
const cellDepth = (map: GameMap): Float32Array => {
  const size = MAP_WIDTH_CELLS * MAP_HEIGHT_CELLS;
  const depth = new Float32Array(size).fill(-1);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;

  for (let y = 0; y < MAP_HEIGHT_CELLS; y += 1) {
    for (let x = 0; x < MAP_WIDTH_CELLS; x += 1) {
      const index = y * MAP_WIDTH_CELLS + x;
      const border = x === 0 || y === 0 || x === MAP_WIDTH_CELLS - 1 || y === MAP_HEIGHT_CELLS - 1;

      if (!isRockCell(map, x, y) || border) {
        depth[index] = isRockCell(map, x, y) ? 1 : 0;
        queue[tail] = index;
        tail += 1;
      }
    }
  }

  while (head < tail) {
    const index = queue[head] ?? 0;
    head += 1;
    const x = index % MAP_WIDTH_CELLS;
    const y = (index - x) / MAP_WIDTH_CELLS;
    const next = (depth[index] ?? 0) + 1;

    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_WIDTH_CELLS || ny >= MAP_HEIGHT_CELLS) continue;

      const at = ny * MAP_WIDTH_CELLS + nx;
      if ((depth[at] ?? -1) >= 0) continue;

      depth[at] = next;
      queue[tail] = at;
      tail += 1;
    }
  }

  return depth;
};

const fields = new WeakMap<GameMap, SmoothField>();

const fieldOf = (map: GameMap): SmoothField => {
  const cached = fields.get(map);
  if (cached !== undefined) return cached;

  const pitch = (MAP_WIDTH_CELLS + 2 * FIELD_MARGIN_CELLS) * FIELD_PER_CELL + 1;
  const base = new Float32Array(pitch * pitch);
  const wide = new Float32Array(pitch * pitch);
  const bulk = new Float32Array(pitch * pitch);

  const depth = cellDepth(map);
  const depthAt = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= MAP_WIDTH_CELLS || y >= MAP_HEIGHT_CELLS
      ? 0
      : (depth[y * MAP_WIDTH_CELLS + x] ?? 0);

  for (let row = 0; row < pitch; row += 1) {
    const v = row / FIELD_PER_CELL - FIELD_MARGIN_CELLS;
    for (let column = 0; column < pitch; column += 1) {
      const u = column / FIELD_PER_CELL - FIELD_MARGIN_CELLS;
      const index = row * pitch + column;
      base[index] = smoothExact(map, u, v);
      wide[index] = wideExact(map, u, v);
      // Глубина сглаживается тем же окном, что и высоты: ступенька
      // в целых клетках дала бы на склоне заметный уступ.
      bulk[index] = around(map, u, v, 0.55, depthAt);
    }
  }

  const field: SmoothField = { base, wide, bulk, pitch };
  fields.set(map, field);

  return field;
};

/** Билинейная выборка с сетки. За её краем возвращает ноль. */
const sampleField = (data: Float32Array, pitch: number, u: number, v: number): number => {
  const x = (u + FIELD_MARGIN_CELLS) * FIELD_PER_CELL;
  const y = (v + FIELD_MARGIN_CELLS) * FIELD_PER_CELL;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= pitch || y0 + 1 >= pitch) return 0;

  const fx = x - x0;
  const fy = y - y0;
  const a = data[y0 * pitch + x0] ?? 0;
  const b = data[y0 * pitch + x0 + 1] ?? 0;
  const c = data[(y0 + 1) * pitch + x0] ?? 0;
  const d = data[(y0 + 1) * pitch + x0 + 1] ?? 0;

  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
};

/** Высоты клеток, сглаженные в непрерывную поверхность. */
export const smoothHeight = (map: GameMap, u: number, v: number): number => {
  const field = fieldOf(map);
  return sampleField(field.base, field.pitch, u, v);
};

/** То же, но окном пошире. Нужно затенению: с чем сравнивать точку. */
export const wideHeight = (map: GameMap, u: number, v: number): number => {
  const field = fieldOf(map);
  return sampleField(field.wide, field.pitch, u, v);
};

/**
 * Глубина массива в точке, в клетках.
 *
 * Единица у самого края, дальше растёт вглубь: у гряды три на три
 * середина лежит на полутора, у пять на пять — на двух с половиной.
 */
export const massifBulk = (map: GameMap, u: number, v: number): number => {
  const field = fieldOf(map);
  return sampleField(field.bulk, field.pitch, u, v);
};

/** Забыть сетку карты. Нужна при выходе из матча и тестам. */
export const forgetReliefField = (map: GameMap): void => {
  fields.delete(map);
};

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

/** Ширина подножия, в клетках: на этом расстоянии от очертания высота набирается полностью. */
export const FOOT_WIDTH_CELLS = 0.35;

/**
 * Насколько порода отступает от края клетки, в клетках.
 *
 * Ради этого отступа всё и заведено. Пока след совпадал с клетками
 * ровно, массив читался набором квадратов: у настоящей горы подошва
 * по сетке не выровнена, и глаз ловит выравнивание мгновенно.
 *
 * Отступ только внутрь. Наружу нельзя ни на волос: порода, вылезшая
 * на соседнюю клетку, легла бы на проходимую землю, и игрок читал бы
 * непроходимым то, по чему войско проходит. Недобор клетки — огрех
 * вида, перебор — обман.
 */
export const OUTLINE_INSET_MAX = 0.4;

/** Зерно очертания. Своё, чтобы не повторять рисунок хребта. */
const OUTLINE_SEED = 71;

export const outlineInset = (u: number, v: number): number =>
  OUTLINE_INSET_MAX * fbm(u * 1.9, v * 1.9, OUTLINE_SEED, 3);

/** Ширина мягкого края очертания, в клетках. */
const OUTLINE_FADE_CELLS = 0.06;

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
  // Отсчёт идёт не от края клетки, а от очертания породы: подошва
  // поднимается оттуда, где порода начинается, а не оттуда, где
  // кончается клетка.
  const distance = edgeDistance(map, u, v) - outlineInset(u, v);
  if (distance <= 0) return 0;
  if (distance >= FOOT_WIDTH_CELLS) return 1;

  return smoothstep(distance / FOOT_WIDTH_CELLS);
};

/**
 * Доля породы в точке: единица внутри очертания, ноль за ним.
 *
 * Нужна отдельно от высоты, потому что у очертания высота нулевая
 * с обеих сторон, и по ней «есть тут камень или уже земля» не отличить.
 * Шейдер берёт её прозрачностью и тем самым вырезает клетку по неровному
 * краю вместо ровного ромба.
 */
export const rockCoverage = (map: GameMap, u: number, v: number): number => {
  const distance = edgeDistance(map, u, v) - outlineInset(u, v);
  if (distance <= 0) return 0;
  if (distance >= OUTLINE_FADE_CELLS) return 1;

  return smoothstep(distance / OUTLINE_FADE_CELLS);
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
/**
 * Общий подъём породы.
 *
 * Скалы обязаны читаться непреодолимыми, а на прежней высоте они
 * выглядели складками земли, через которые можно перевалить. Цифра
 * скромная намеренно: вдвое выше — и массив начинает загораживать
 * то, что за ним, а поле с полной информацией на этом ломается.
 */
const HEIGHT_GAIN = 1.24;

/**
 * Прибавка за глубину массива и глубина, на которой она набирается.
 *
 * Ради этого заведена `massifBulk`. Одиночная скала и середина большой
 * гряды прежде получали одинаковые шансы на высоту, потому что высота
 * бралась из хеша клетки и только. Теперь три на три поднимается заметно
 * выше одиночной, пять на пять — выше трёх, и дальше рост затухает:
 * без потолка середина крупного поля скал ушла бы за антенну базы.
 */
const BULK_GAIN = 0.34;
const BULK_FULL_CELLS = 3;

/**
 * Потолок высоты рельефа, в клетках.
 *
 * Держится ниже антенны командного центра (3,2): база обязана
 * оставаться выше любой скалы, иначе её перестанет быть видно
 * из-за гряды.
 */
export const MAX_RELIEF_HEIGHT = 3;

export const surfaceHeight = (map: GameMap, u: number, v: number): number => {
  const base = smoothHeight(map, u, v);
  if (base < 0.004) return 0;

  const ridged = 1 - Math.abs(fbm(u * 0.66, v * 0.66, RIDGE_SEED, 3) * 2 - 1);
  const bulk = Math.min(massifBulk(map, u, v), BULK_FULL_CELLS) / BULK_FULL_CELLS;
  const height =
    base * (0.72 + 0.52 * ridged) * HEIGHT_GAIN * (1 + BULK_GAIN * bulk) * footFactor(map, u, v);

  return Math.min(height, MAX_RELIEF_HEIGHT);
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
