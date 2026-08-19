import type { Graphics } from 'pixi.js';
import { MAP_HEIGHT_CELLS, MAP_WIDTH_CELLS, Terrain } from '@td/shared';
import { cellX, cellY } from '@td/sim';
import type { GameMap } from '@td/sim';
import { worldToScreen } from './iso.js';

/**
 * Каркасная отрисовка территории.
 *
 * Художественное направление: территория — линии, юниты — детализированы.
 * Никаких заливок и текстур. Каркас читается мгновенно, не перетягивает
 * внимание и выглядит как тактический дисплей, а не как недоделанная
 * графика.
 *
 * Ключевой приём этого файла — группировка по стилю линии.
 *
 * В PixiJS вызов `stroke()` обводит весь путь, накопленный с прошлой
 * обводки, и превращается в отдельное обращение к видеокарте. Если обводить
 * каждый отрезок сразу после его добавления, на карте получается несколько
 * тысяч таких обращений на кадр, и частота падает втрое.
 *
 * Поэтому здесь сначала накапливаются ВСЕ отрезки одного стиля, и только
 * потом делается одна обводка. Обращений к видеокарте становится шесть
 * вместо тысяч.
 *
 * Геометрия строится один раз и живёт в объекте Graphics. Движение камеры
 * её не трогает — сдвигается контейнер целиком.
 */
export interface TerrainColors {
  readonly grid: number;
  readonly gridMajor: number;
  readonly rock: number;
  readonly border: number;
  readonly baseSelf: number;
  readonly baseEnemy: number;
}

/** Каждая четвёртая линия ярче: так глаз считывает расстояния без линейки. */
const MAJOR_GRID_EVERY = 4;

export const drawTerrain = (graphics: Graphics, map: GameMap, colors: TerrainColors): void => {
  graphics.clear();

  drawGrid(graphics, colors);
  drawRockEdges(graphics, map, colors);
  drawBorder(graphics, colors);
  drawBases(graphics, map, colors);
};

export interface Point {
  readonly x: number;
  readonly y: number;
}

const segment = (graphics: Graphics, from: Point, to: Point): void => {
  graphics.moveTo(from.x, from.y).lineTo(to.x, to.y);
};

/**
 * Сетка клеток.
 *
 * Рисуется длинными линиями через всю карту, а не отрезками на каждую
 * клетку: 194 отрезка вместо 36 тысяч. Визуально результат тот же —
 * сетка есть сетка, — а вершин на два порядка меньше.
 *
 * Это работает потому, что изометрическая проекция линейна: прямая в мире
 * остаётся прямой на экране.
 *
 * Два прохода — по одному на каждый стиль линии, чтобы каждый стиль обводился
 * ровно один раз.
 */
const drawGrid = (graphics: Graphics, colors: TerrainColors): void => {
  for (const major of [false, true]) {
    for (let x = 0; x <= MAP_WIDTH_CELLS; x += 1) {
      if ((x % MAJOR_GRID_EVERY === 0) !== major) continue;
      segment(graphics, worldToScreen(x, 0), worldToScreen(x, MAP_HEIGHT_CELLS));
    }

    for (let y = 0; y <= MAP_HEIGHT_CELLS; y += 1) {
      if ((y % MAJOR_GRID_EVERY === 0) !== major) continue;
      segment(graphics, worldToScreen(0, y), worldToScreen(MAP_WIDTH_CELLS, y));
    }

    graphics.stroke({ width: 1, color: major ? colors.gridMajor : colors.grid });
  }
};

/**
 * Обход рёбер на границе скальных массивов.
 *
 * Выдаются только рёбра между проходимой и непроходимой клеткой. Внутренние
 * рёбра массива пропускаются: их всё равно не видно за соседними скалами,
 * а вершин они добавляют втрое больше, чем нужно. Для монолита 3 × 3 это
 * 12 рёбер по периметру вместо 36.
 *
 * Функция чистая и ничего не рисует: она отдаёт геометрию, а что с ней
 * делать — рисовать или посчитать в тесте — решает вызывающий код.
 */
export const forEachBoundaryEdge = (
  map: GameMap,
  visit: (from: Point, to: Point) => void,
): void => {
  for (let index = 0; index < map.cells.length; index += 1) {
    if (map.cells[index] === Terrain.Ground) continue;

    const x = cellX(index);
    const y = cellY(index);

    // Углы ромба клетки. Мировая клетка занимает квадрат [x, x+1] × [y, y+1],
    // его четыре угла в проекции дают ромб.
    const north = worldToScreen(x, y);
    const east = worldToScreen(x + 1, y);
    const south = worldToScreen(x + 1, y + 1);
    const west = worldToScreen(x, y + 1);

    if (isOpen(map, x - 1, y)) visit(north, west);
    if (isOpen(map, x + 1, y)) visit(east, south);
    if (isOpen(map, x, y - 1)) visit(north, east);
    if (isOpen(map, x, y + 1)) visit(west, south);
  }
};

const drawRockEdges = (graphics: Graphics, map: GameMap, colors: TerrainColors): void => {
  forEachBoundaryEdge(map, (from, to) => segment(graphics, from, to));

  graphics.stroke({ width: 2, color: colors.rock, alpha: 0.85 });
};

/** Проходима ли клетка. Клетки за краем карты считаются скалой. */
const isOpen = (map: GameMap, x: number, y: number): boolean => {
  if (x < 0 || y < 0 || x >= MAP_WIDTH_CELLS || y >= MAP_HEIGHT_CELLS) return false;

  return map.cells[y * MAP_WIDTH_CELLS + x] === Terrain.Ground;
};

const drawBorder = (graphics: Graphics, colors: TerrainColors): void => {
  const north = worldToScreen(0, 0);
  const east = worldToScreen(MAP_WIDTH_CELLS, 0);
  const south = worldToScreen(MAP_WIDTH_CELLS, MAP_HEIGHT_CELLS);
  const west = worldToScreen(0, MAP_HEIGHT_CELLS);

  graphics
    .moveTo(north.x, north.y)
    .lineTo(east.x, east.y)
    .lineTo(south.x, south.y)
    .lineTo(west.x, west.y)
    .lineTo(north.x, north.y)
    .stroke({ width: 2, color: colors.border, alpha: 0.6 });
};

/** Размер метки базы в клетках. */
const BASE_MARKER_CELLS = 3;

const drawBases = (graphics: Graphics, map: GameMap, colors: TerrainColors): void => {
  const baseColors = [colors.baseSelf, colors.baseEnemy];

  map.baseCells.forEach((cell, playerIndex) => {
    const color = baseColors[playerIndex] ?? colors.baseSelf;
    const x = cellX(cell);
    const y = cellY(cell);
    const half = BASE_MARKER_CELLS / 2;

    const north = worldToScreen(x - half, y - half);
    const east = worldToScreen(x + half, y - half);
    const south = worldToScreen(x + half, y + half);
    const west = worldToScreen(x - half, y + half);

    graphics
      .moveTo(north.x, north.y)
      .lineTo(east.x, east.y)
      .lineTo(south.x, south.y)
      .lineTo(west.x, west.y)
      .lineTo(north.x, north.y)
      .stroke({ width: 3, color, alpha: 0.95 });

    // Перекрестие в центре: без него ромб на каркасной карте теряется
    // среди линий сетки.
    graphics
      .moveTo(north.x, north.y)
      .lineTo(south.x, south.y)
      .moveTo(east.x, east.y)
      .lineTo(west.x, west.y)
      .stroke({ width: 1, color, alpha: 0.5 });
  });
};
