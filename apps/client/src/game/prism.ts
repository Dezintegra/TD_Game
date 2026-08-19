import { ELEVATION_PX_PER_CELL, worldToScreen } from './iso.js';
import type { Point } from './iso.js';

/**
 * Призма — единственный объёмный примитив игры.
 *
 * Любой объект на карте это горизонтальное основание, поднятое на заданную
 * высоту: скала, стена, корпус здания, мачта антенны. Юниты, когда появятся,
 * будут собираться из тех же призм.
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
 * Источник света неподвижен, и направление каждой грани известно заранее,
 * поэтому считать нормали и скалярные произведения незачем — достаточно трёх
 * множителей яркости.
 *
 * Одни и те же множители применяются ко всем объектам: и к камню, и к зданиям.
 * Именно это делает разнородные объекты частями одного мира. Разное освещение
 * у соседних предметов читается как ошибка даже теми, кто не сможет
 * объяснить, что именно не так.
 */
export const FACE_LIGHT = {
  top: 1,
  right: 0.72,
  left: 0.48,
} as const;

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
export const forEachDiagonal = (
  width: number,
  height: number,
  visitDiagonal: (cells: readonly (readonly [number, number])[]) => void,
): void => {
  for (let sum = 0; sum <= width + height - 2; sum += 1) {
    const cells: (readonly [number, number])[] = [];

    const startX = Math.max(0, sum - height + 1);
    const endX = Math.min(sum, width - 1);

    for (let x = startX; x <= endX; x += 1) {
      cells.push([x, sum - x]);
    }

    if (cells.length > 0) visitDiagonal(cells);
  }
};
