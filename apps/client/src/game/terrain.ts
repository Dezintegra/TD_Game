import type { Graphics } from 'pixi.js';
import { MAP_HEIGHT_CELLS, MAP_WIDTH_CELLS } from '@td/shared';
import { worldToScreen } from './iso.js';
import type { Point } from './iso.js';

/**
 * Отрисовка территории.
 *
 * Художественное направление: земля — схематичный каркас, всё, что на ней
 * стоит, — объёмное и детализированное. Контраст между плоским тактическим
 * полем и плотными объектами на нём и есть замысел.
 *
 * Отсюда разделение обязанностей: земля рисуется здесь линиями, объёмные
 * объекты запекаются в спрайты — рельеф в `relief-render.ts`, командный
 * центр в `base-render.ts`.
 *
 * Ключевой приём для земли — группировка по стилю линии. В PixiJS вызов
 * `stroke()` обводит весь путь, накопленный с прошлой обводки, и превращается
 * в отдельное обращение к видеокарте. Если обводить каждый отрезок сразу
 * после добавления, получаются тысячи обращений на кадр. Поэтому сначала
 * накапливаются все отрезки одного стиля, и только потом делается обводка.
 *
 * Земля плоская и лежит ниже всего на свете, поэтому живёт одним слоем.
 * Объёмные объекты обязаны вставать в общий порядок удалённости вместе
 * с юнитами, поэтому раскладываются по слоям-диагоналям, между которые
 * сцена вклинивает слои сущностей, — но живут они уже не здесь.
 *
 * Слоя `Graphics` на каждую диагональ здесь тоже больше нет. После
 * переезда скал в спрайты в нём оставалась одна-единственная вещь —
 * база; уехала и она, а держать девяносто пять пустых объектов не за чем.
 *
 * Геометрия земли строится один раз на карту. Движение камеры её
 * не трогает — сдвигается контейнер целиком.
 */
export interface TerrainColors {
  readonly grid: number;
  readonly gridMajor: number;
  /**
   * Цвет камня. Грань, скол, ребро и снег отсюда ушли вместе с гранёной
   * отрисовкой: у непрерывной поверхности оттенок в каждой точке свой
   * и считается светом, а не выбирается из палитры. Снега на скалах
   * больше нет вовсе.
   */
  readonly rock: number;
  /** Холодный подсвет сверху: второй источник у скал. */
  readonly rockSky: number;
  readonly border: number;
}

/** Каждая четвёртая линия ярче: так глаз считывает расстояния без линейки. */
const MAJOR_GRID_EVERY = 4;

/** Плоская земля: сетка клеток и граница карты. Ниже всех объёмных тел. */
export const drawGround = (graphics: Graphics, colors: TerrainColors): void => {
  graphics.clear();

  drawGrid(graphics, colors);
  drawBorder(graphics, colors);
};

/** Сколько диагоналей на карте. Столько же и слоёв объёмной территории. */
export const TERRAIN_DIAGONAL_COUNT = MAP_WIDTH_CELLS + MAP_HEIGHT_CELLS - 1;

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
 * Это работает потому, что проекция линейна: прямая в мире остаётся прямой
 * на экране.
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
