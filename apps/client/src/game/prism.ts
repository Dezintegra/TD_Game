import type { Graphics } from 'pixi.js';
import { ELEVATION_PX_PER_CELL, VIEW_DIRECTION, worldToScreen } from './iso.js';
import type { Point } from './iso.js';

/**
 * Призма — единственный объёмный примитив игры.
 *
 * Любой неподвижный объект на карте это горизонтальное основание, поднятое
 * на заданную высоту: скала, стена, корпус здания, мачта антенны.
 *
 * Техника выровнена по осям мира быть не может — она едет под углом,
 * — поэтому для неё ниже есть общий случай: тело с произвольным выпуклым
 * основанием. Призма выражается через него, но пользуется собственным
 * кодом; почему именно так, объяснено там же.
 *
 * Ключевое упрощение даёт фиксированный угол обзора. Из шести граней куба
 * зритель видит ровно три — верхнюю и две боковые; остальные три обращены
 * от него всегда. Мы их не строим вовсе. Это не оптимизация «на всякий
 * случай», а прямое следствие дизайнерского решения не давать поворачивать
 * камеру: ограничение в дизайне экономит работу в рендере.
 *
 * В нашей проекции северный угол ромба смотрит вверх, поэтому видимы левая
 * грань (запад-юг) и правая (восток-юг).
 */
export interface Prism {
  /** Левый верхний угол основания в клетках. */
  readonly x: number;
  readonly y: number;
  /** Размер основания в клетках. */
  readonly width: number;
  readonly depth: number;
  /** Высота в клетках. Ноль означает плоскую площадку без боковых граней. */
  readonly height: number;
  /** Уровень, на котором стоит основание. Нужен для уступов между скалами. */
  readonly base?: number;
}

export interface PrismFaces {
  /** Верхняя грань: четыре угла по часовой стрелке от северного. */
  readonly top: readonly Point[];
  /** Левая боковая грань. Пуста, если высота нулевая. */
  readonly left: readonly Point[];
  /** Правая боковая грань. Пуста, если высота нулевая. */
  readonly right: readonly Point[];
}

const lift = (point: Point, heightCells: number): Point => ({
  x: point.x,
  y: point.y - heightCells * ELEVATION_PX_PER_CELL,
});

export const prismFaces = (prism: Prism): PrismFaces => {
  const base = prism.base ?? 0;
  const top = base + prism.height;

  // Углы основания в проекции. Мировой прямоугольник даёт на экране ромб.
  const north = worldToScreen(prism.x, prism.y);
  const east = worldToScreen(prism.x + prism.width, prism.y);
  const south = worldToScreen(prism.x + prism.width, prism.y + prism.depth);
  const west = worldToScreen(prism.x, prism.y + prism.depth);

  const topFace = [lift(north, top), lift(east, top), lift(south, top), lift(west, top)] as const;

  if (prism.height === 0) {
    return { top: topFace, left: [], right: [] };
  }

  return {
    top: topFace,
    // Левая грань: между западным и южным рёбрами.
    left: [lift(west, top), lift(south, top), lift(south, base), lift(west, base)],
    // Правая грань: между южным и восточным рёбрами.
    right: [lift(south, top), lift(east, top), lift(east, base), lift(south, base)],
  };
};

/**
 * Условное освещение.
 *
 * Источник света неподвижен и один на весь мир. Одни и те же правила
 * применяются ко всем объектам: и к камню, и к зданиям, и к технике.
 * Именно это делает разнородные объекты частями одного мира. Разное
 * освещение у соседних предметов читается как ошибка даже теми, кто
 * не сможет объяснить, что именно не так.
 *
 * У выровненной по осям призмы видимых боковых граней ровно две, и раньше
 * яркость задавалась таблицей из трёх чисел. Повёрнутому телу таблицы мало:
 * граней у него сколько угодно и смотрят они куда угодно. Поэтому яркость
 * считается из направления внешней нормали по закону Ламберта.
 *
 * Числа подобраны так, чтобы на выровненной призме формула давала в точности
 * прежние значения: нормаль «на восток» даёт 0,72, нормаль «на юг» — 0,48.
 * Совпадение здесь не украшение, а требование: разъедься числа хоть
 * на процент, неподвижная башня и стоящая рядом повёрнутая машина
 * оказались бы освещены разными источниками.
 *
 * Грань, обращённая от источника, получает ровно фоновый уровень: он ниже
 * обеих видимых яркостей, что и требуется — такая грань попадает в кадр
 * только у повёрнутых тел.
 */
const AMBIENT_LIGHT = 0.34;

/** Свет с востоко-северо-востока. Длина вектора — сила источника. */
const LIGHT_X = 0.72 - AMBIENT_LIGHT;
const LIGHT_Y = 0.48 - AMBIENT_LIGHT;

/** Яркость боковой грани по её внешней нормали. Нормаль должна быть единичной. */
export const faceLight = (normalX: number, normalY: number): number =>
  AMBIENT_LIGHT + Math.max(0, normalX * LIGHT_X + normalY * LIGHT_Y);

/**
 * Яркость трёх граней выровненной призмы.
 *
 * Правая грань смотрит на восток, левая — на юг; верхняя не зависит
 * от поворота вокруг вертикали и потому задана числом.
 */
export const FACE_LIGHT = {
  top: 1,
  right: faceLight(1, 0),
  left: faceLight(0, 1),
} as const;

// ─────────────────────────────────────────────────────────────────────────
// Тело с произвольным основанием
// ─────────────────────────────────────────────────────────────────────────

/** Точка основания в клетках мира. */
export interface FootprintPoint {
  readonly x: number;
  readonly y: number;
}

export interface SolidFace {
  readonly points: readonly Point[];
  /** Яркость по условному освещению. */
  readonly light: number;
}

export interface SolidFaces {
  /** Верхняя грань. Видна всегда, даже у тела нулевой высоты. */
  readonly top: SolidFace;
  /** Боковые грани, обращённые к зрителю. Пусто при нулевой высоте. */
  readonly sides: readonly SolidFace[];
}

/**
 * Грани тела с произвольным выпуклым основанием.
 *
 * Призма выше — частный случай этого тела, и оба кода живут рядом
 * не по недосмотру. У выровненного прямоугольника видимые грани известны
 * заранее, и `prismFaces` пользуется этим знанием: он не считает ни нормалей,
 * ни скалярных произведений. Скал на карте тысячи, и платить за общность
 * там, где она не нужна, незачем — это ровно тот же принцип, по которому
 * мы не строим три обращённые от зрителя грани куба.
 *
 * Здесь общность нужна: основание техники повёрнуто, у крыла оно вообще
 * трапеция, и какие грани окажутся видимыми, заранее не известно. Зато
 * считается это один раз при построении кеша силуэтов, а не на кадре.
 *
 * Что оба кода дают на прямоугольнике одно и то же — закреплено тестом.
 */
export const solidFaces = (
  footprint: readonly FootprintPoint[],
  height: number,
  base = 0,
): SolidFaces => {
  const top = base + height;
  const projected = footprint.map((point) => worldToScreen(point.x, point.y));
  const topFace: SolidFace = {
    points: projected.map((point) => lift(point, top)),
    light: FACE_LIGHT.top,
  };

  if (height === 0 || footprint.length < 3) return { top: topFace, sides: [] };

  // Центр основания нужен, чтобы отличить внешнюю нормаль от внутренней.
  // Для выпуклого основания достаточно среднего по углам.
  let centreX = 0;
  let centreY = 0;
  for (const point of footprint) {
    centreX += point.x;
    centreY += point.y;
  }
  centreX /= footprint.length;
  centreY /= footprint.length;

  const sides: SolidFace[] = [];

  for (let index = 0; index < footprint.length; index += 1) {
    const from = footprint[index];
    const to = footprint[(index + 1) % footprint.length];
    if (from === undefined || to === undefined) continue;

    const edgeX = to.x - from.x;
    const edgeY = to.y - from.y;
    const length = Math.sqrt(edgeX * edgeX + edgeY * edgeY);
    // Вырожденное ребро граней не даёт. Так бывает у треугольного носа,
    // заданного четырьмя точками с двумя совпавшими.
    if (length === 0) continue;

    // Нормаль к ребру — поворот его на прямой угол. Какой из двух поворотов
    // внешний, решает знак произведения на вектор «от центра к ребру».
    let normalX = edgeY / length;
    let normalY = -edgeX / length;
    const outward =
      normalX * ((from.x + to.x) / 2 - centreX) + normalY * ((from.y + to.y) / 2 - centreY);
    if (outward < 0) {
      normalX = -normalX;
      normalY = -normalY;
    }

    // Обращённые от зрителя грани не строим вовсе — их не видно.
    if (normalX * VIEW_DIRECTION.x + normalY * VIEW_DIRECTION.y <= 0) continue;

    const screenFrom = projected[index] as Point;
    const screenTo = projected[(index + 1) % footprint.length] as Point;

    sides.push({
      points: [
        lift(screenFrom, top),
        lift(screenTo, top),
        lift(screenTo, base),
        lift(screenFrom, base),
      ],
      light: faceLight(normalX, normalY),
    });
  }

  return { top: topFace, sides };
};

/**
 * Смешивает два цвета. `amount` — доля второго цвета от 0 до 1.
 *
 * Нужна, чтобы получать корпус постройки из цвета стороны: сплошной неон
 * на крупном объекте выжигает все детали, а тёмный корпус с примесью
 * фирменного цвета и неоновой окантовкой читается гораздо лучше.
 */
export const blend = (from: number, to: number, amount: number): number => {
  const mixChannel = (shift: number): number =>
    Math.round(((from >> shift) & 0xff) * (1 - amount) + ((to >> shift) & 0xff) * amount);

  return (mixChannel(16) << 16) | (mixChannel(8) << 8) | mixChannel(0);
};

/** Умножает цвет на коэффициент яркости покомпонентно. */
export const shade = (color: number, factor: number): number => {
  const red = Math.round(((color >> 16) & 0xff) * factor);
  const green = Math.round(((color >> 8) & 0xff) * factor);
  const blue = Math.round((color & 0xff) * factor);

  return (red << 16) | (green << 8) | blue;
};

/**
 * Прокладывает путь по точкам многоугольника со сдвигом и замыкает его.
 *
 * Сдвиг нужен готовой геометрии из кеша силуэтов: она построена
 * относительно основания модели, и всё, что остаётся на кадре, —
 * сложить её точки с экранным положением объекта.
 */
export const tracePolygonAt = (
  graphics: Graphics,
  points: readonly Point[],
  offsetX: number,
  offsetY: number,
): void => {
  const first = points[0];
  if (first === undefined) return;

  graphics.moveTo(first.x + offsetX, first.y + offsetY);
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (point !== undefined) graphics.lineTo(point.x + offsetX, point.y + offsetY);
  }
  graphics.closePath();
};

/** Прокладывает путь по точкам многоугольника и замыкает его. */
export const tracePolygon = (graphics: Graphics, points: readonly Point[]): void => {
  tracePolygonAt(graphics, points, 0, 0);
};

export interface PrismStyle {
  /** Цвет корпуса. Грани затеняются от него по правилу FACE_LIGHT. */
  readonly hull: number;
  /** Цвет неоновой окантовки по рёбрам. */
  readonly accent: number;
  readonly lineWidth?: number;
  readonly lineAlpha?: number;
}

/**
 * Отрисовка одного объёмного тела.
 *
 * Порядок граней не случаен: сначала боковые, потом верхняя. При таком
 * порядке верхняя грань перекрывает стыки боковых, и на месте ребра
 * не остаётся тонкой щели фона, которая при сглаживании очень заметна.
 *
 * Неоновая окантовка обводится последней и несёт основную нагрузку
 * узнавания: тёмный корпус на тёмной земле сам по себе виден плохо.
 */
export const drawPrism = (graphics: Graphics, prism: Prism, style: PrismStyle): void => {
  const faces = prismFaces(prism);

  if (faces.left.length > 0) {
    tracePolygon(graphics, faces.left);
    graphics.fill({ color: shade(style.hull, FACE_LIGHT.left) });
  }
  if (faces.right.length > 0) {
    tracePolygon(graphics, faces.right);
    graphics.fill({ color: shade(style.hull, FACE_LIGHT.right) });
  }

  tracePolygon(graphics, faces.top);
  graphics.fill({ color: shade(style.hull, FACE_LIGHT.top) });

  tracePolygon(graphics, faces.top);
  if (faces.left.length > 0) tracePolygon(graphics, faces.left);
  if (faces.right.length > 0) tracePolygon(graphics, faces.right);

  graphics.stroke({
    width: style.lineWidth ?? 1.5,
    color: style.accent,
    alpha: style.lineAlpha ?? 0.85,
  });
};

/**
 * Обход клеток карты в порядке удалённости от зрителя.
 *
 * Объёмные тела перекрывают друг друга, поэтому порядок отрисовки перестаёт
 * быть безразличным. Правило простое: чем больше сумма координат клетки,
 * тем ближе она к зрителю и тем позже её надо рисовать.
 *
 * Это классический алгоритм художника, и в изометрии он точен, а не
 * приблизителен: тело на клетке с меньшей суммой физически не может закрыть
 * тело с большей.
 *
 * Обычный построчный обход массива этому порядку не соответствует, поэтому
 * идём по диагоналям. Клетки одной диагонали друг друга не перекрывают,
 * так что их порядок внутри диагонали безразличен — и этим мы дальше
 * воспользуемся, чтобы группировать заливки.
 */
export const diagonalCells = (
  width: number,
  height: number,
  sum: number,
): readonly (readonly [number, number])[] => {
  const cells: (readonly [number, number])[] = [];

  const startX = Math.max(0, sum - height + 1);
  const endX = Math.min(sum, width - 1);

  for (let x = startX; x <= endX; x += 1) {
    cells.push([x, sum - x]);
  }

  return cells;
};

export const forEachDiagonal = (
  width: number,
  height: number,
  visitDiagonal: (cells: readonly (readonly [number, number])[]) => void,
): void => {
  for (let sum = 0; sum <= width + height - 2; sum += 1) {
    const cells = diagonalCells(width, height, sum);
    if (cells.length > 0) visitDiagonal(cells);
  }
};
