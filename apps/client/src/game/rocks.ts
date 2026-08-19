import type { Graphics } from 'pixi.js';
import { MAP_HEIGHT_CELLS, MAP_WIDTH_CELLS, Terrain } from '@td/shared';
import type { GameMap } from '@td/sim';
import { FACE_LIGHT, forEachDiagonal, shade } from './prism.js';
import { ELEVATION_PX_PER_CELL, worldToScreen } from './iso.js';
import type { Point } from './iso.js';

/**
 * Скалы.
 *
 * Первая версия рисовала каждую клетку коробкой, и выглядело это ровно так,
 * как звучит: серые кубики. Настоящая скала — не параллелепипед, у неё есть
 * вершина, скаты и неровные грани.
 *
 * Поэтому клетка рисуется не призмой, а усечённой пирамидой: основание —
 * ромб клетки, наверху либо острый пик, либо небольшая площадка. Вершина
 * смещена от центра, скаты получаются разной крутизны, и соседние клетки
 * складываются в массив с несколькими пиками вместо ровной плиты.
 *
 * Высота и форма каждой клетки берутся из хеша её координат: хранить их
 * негде и незачем, поскольку на правила игры они не влияют. Ошибка
 * в подборе высоты может испортить вид, но не может испортить матч.
 */
export interface RockColors {
  readonly rock: number;
  readonly facet: number;
  readonly edge: number;
}

/**
 * Уровни высоты скал в клетках.
 *
 * Разброс намеренно широкий: массив из клеток одной высоты читается как
 * плита, а не как скальный выход. Верхний уровень — редкий острый пик,
 * нижний — почти россыпь щебня у подножия.
 */
const ROCK_LEVELS = [0.32, 0.55, 0.78, 1.05, 1.45] as const;

/**
 * Доля, на которую верхняя площадка уже основания.
 *
 * Ноль означает острый пик, значения побольше — срезанную вершину.
 * Чередование того и другого и создаёт вид настоящей породы: одни клетки
 * вытягиваются в шпили, другие остаются гранёными глыбами.
 */
const TOP_SHRINK = [0, 0, 0.14, 0.3, 0.45] as const;

/**
 * Целочисленный хеш координат клетки.
 *
 * Один хеш даёт и высоту, и форму, и смещение вершины. Функция чистая,
 * поэтому одна и та же карта всегда выглядит одинаково, но хранить ничего
 * не требуется.
 *
 * Math.imul, а не обычное умножение: на больших числах оператор `*` уходит
 * в плавающую точку и теряет младшие биты, из-за чего хеш вырождается.
 */
const hashCell = (x: number, y: number): number => {
  let hash = Math.imul(x + 0x9e37, 0x85ebca6b) ^ Math.imul(y + 0x79b9, 0xc2b2ae35);
  hash = Math.imul(hash ^ (hash >>> 13), 0x27d4eb2f);
  return (hash ^ (hash >>> 16)) >>> 0;
};

export const rockHeight = (x: number, y: number): number =>
  ROCK_LEVELS[hashCell(x, y) % ROCK_LEVELS.length] ?? ROCK_LEVELS[0];

/** Самая высокая скала, какая может встретиться. Нужна, чтобы база была выше. */
export const MAX_ROCK_HEIGHT = ROCK_LEVELS[ROCK_LEVELS.length - 1] ?? 1;

/** Насколько верхняя площадка клетки уже её основания. */
export const rockTopShrink = (x: number, y: number): number =>
  TOP_SHRINK[(hashCell(x, y) >>> 5) % TOP_SHRINK.length] ?? 0;

const isRock = (map: GameMap, x: number, y: number): boolean => {
  if (x < 0 || y < 0 || x >= MAP_WIDTH_CELLS || y >= MAP_HEIGHT_CELLS) return false;

  return map.cells[y * MAP_WIDTH_CELLS + x] !== Terrain.Ground;
};

const lift = (point: Point, heightCells: number): Point => ({
  x: point.x,
  y: point.y - heightCells * ELEVATION_PX_PER_CELL,
});

interface RockShape {
  /** Четыре угла основания: север, восток, юг, запад. */
  readonly base: readonly [Point, Point, Point, Point];
  /** Четыре угла верхней площадки. При остром пике все четыре совпадают. */
  readonly top: readonly [Point, Point, Point, Point];
}

/**
 * Геометрия одной скальной клетки.
 *
 * Основание всегда совпадает с ромбом клетки — так соседние скалы стыкуются
 * без щелей и массив читается единым телом. Вся неровность живёт наверху:
 * высота, степень усечения и смещение вершины.
 */
export const rockShape = (x: number, y: number): RockShape => {
  const hash = hashCell(x, y);
  const height = rockHeight(x, y);
  const shrink = rockTopShrink(x, y);

  const base: readonly [Point, Point, Point, Point] = [
    worldToScreen(x, y),
    worldToScreen(x + 1, y),
    worldToScreen(x + 1, y + 1),
    worldToScreen(x, y + 1),
  ];

  // Смещение вершины в пределах четверти клетки. Без него все пики
  // оказались бы строго по центру, и массив снова выглядел бы регулярным.
  const offsetX = (((hash >>> 9) % 9) - 4) / 16;
  const offsetY = (((hash >>> 14) % 9) - 4) / 16;
  const peakX = x + 0.5 + offsetX;
  const peakY = y + 0.5 + offsetY;

  const corner = (cornerX: number, cornerY: number): Point =>
    lift(
      worldToScreen(peakX + (cornerX - peakX) * shrink, peakY + (cornerY - peakY) * shrink),
      height,
    );

  return {
    base,
    top: [corner(x, y), corner(x + 1, y), corner(x + 1, y + 1), corner(x, y + 1)],
  };
};

const polygon = (graphics: Graphics, points: readonly Point[]): void => {
  const first = points[0];
  if (first === undefined) return;

  graphics.moveTo(first.x, first.y);
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (point !== undefined) graphics.lineTo(point.x, point.y);
  }
  graphics.closePath();
};

/**
 * Скат скалы между ребром основания и соответствующим ребром вершины.
 *
 * Если у пика вершина острая, четырёхугольник вырождается в треугольник —
 * рисовать его всё равно можно, лишние совпадающие точки безвредны.
 */
const slope = (graphics: Graphics, shape: RockShape, fromIndex: number, toIndex: number): void => {
  const baseFrom = shape.base[fromIndex];
  const baseTo = shape.base[toIndex];
  const topFrom = shape.top[fromIndex];
  const topTo = shape.top[toIndex];
  if (!baseFrom || !baseTo || !topFrom || !topTo) return;

  polygon(graphics, [baseFrom, baseTo, topTo, topFrom]);
};

/** Индексы углов: 0 север, 1 восток, 2 юг, 3 запад. */
const NORTH = 0;
const EAST = 1;
const SOUTH = 2;
const WEST = 3;

/**
 * Отрисовка всех скал карты.
 *
 * Здесь встречаются два требования, которые в лоб несовместимы.
 *
 * Ради частоты кадров заливки надо группировать по стилю грани. Ради
 * корректного перекрытия объекты надо рисовать в порядке удалённости
 * от зрителя, то есть чередуя стили.
 *
 * Компромисс: группируем внутри одной диагонали. Клетки одной диагонали
 * друг друга не перекрывают, поэтому порядок их отрисовки безразличен —
 * и все их одноимённые скаты можно залить одним вызовом. Получается пять
 * заливок на диагональ вместо пяти на каждую скалу, и счёт зависит только
 * от размера карты, но не от количества скал на ней.
 *
 * Внутри клетки порядок такой: сначала дальние скаты, затем верхняя
 * площадка, затем ближние. Дальние скаты видны только у пологих скал,
 * у крутых они закрыты вершиной — рисуем их всегда, лишнее просто
 * перекроется.
 */
export const drawRocks = (graphics: Graphics, map: GameMap, colors: RockColors): void => {
  const topColor = shade(colors.rock, FACE_LIGHT.top);
  const facetColor = shade(colors.facet, FACE_LIGHT.top);
  const rightColor = shade(colors.rock, FACE_LIGHT.right);
  const leftColor = shade(colors.rock, FACE_LIGHT.left);
  const backColor = shade(colors.rock, FACE_LIGHT.left * 0.8);

  forEachDiagonal(MAP_WIDTH_CELLS, MAP_HEIGHT_CELLS, (cells) => {
    const rocks = cells.filter(([x, y]) => isRock(map, x, y));
    if (rocks.length === 0) return;

    const shapes = rocks.map(([x, y]) => rockShape(x, y));

    // Дальние скаты: обращены на север и запад, от зрителя.
    for (const shape of shapes) {
      slope(graphics, shape, NORTH, EAST);
      slope(graphics, shape, WEST, NORTH);
    }
    graphics.fill({ color: backColor });

    // Ближний правый скат.
    for (const shape of shapes) slope(graphics, shape, EAST, SOUTH);
    graphics.fill({ color: rightColor });

    // Ближний левый скат.
    for (const shape of shapes) slope(graphics, shape, SOUTH, WEST);
    graphics.fill({ color: leftColor });

    // Верхняя площадка. У острых пиков вырождена в точку и не видна.
    for (const shape of shapes) polygon(graphics, shape.top);
    graphics.fill({ color: topColor });

    // Скол на верхней площадке: половина её, залитая другим оттенком.
    // Даёт фактуру камня там, где площадка достаточно велика.
    for (const shape of shapes) {
      const [north, east, south] = shape.top;
      if (north && east && south) polygon(graphics, [north, east, south]);
    }
    graphics.fill({ color: facetColor });

    // Рёбра. Именно они отделяют скалу от соседней: без обводки массив
    // сливается в одно пятно, потому что все скаты одного цвета.
    for (const shape of shapes) {
      slope(graphics, shape, EAST, SOUTH);
      slope(graphics, shape, SOUTH, WEST);
      polygon(graphics, shape.top);
    }
    graphics.stroke({ width: 1, color: colors.edge, alpha: 0.55 });
  });
};
