import { MAP_CELL_COUNT, TILE_HEIGHT_PX, TILE_WIDTH_PX } from '@td/shared';

/**
 * Изометрическая проекция 2:1.
 *
 * Идея простая: мировая сетка поворачивается на 45° и сплющивается вдвое
 * по вертикали. Клетка, которая «сверху» была бы квадратом, превращается
 * в ромб шириной 96 и высотой 48 пикселей.
 *
 * Формулы получаются из этого поворота напрямую:
 *   экранный X зависит от РАЗНОСТИ мировых координат — движение по мировой
 *   оси X уводит вправо, по оси Y влево;
 *   экранный Y зависит от их СУММЫ — движение по любой из осей уводит вниз,
 *   но вдвое медленнее.
 *
 * Угол фиксирован и не меняется никогда, поэтому матрица проекции —
 * четыре константы, а не объект с состоянием.
 */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface CellPoint {
  readonly x: number;
  readonly y: number;
}

const HALF_TILE_WIDTH = TILE_WIDTH_PX / 2;
const HALF_TILE_HEIGHT = TILE_HEIGHT_PX / 2;

/** Клетка мира → точка на экране (центр верхнего угла ромба). */
export const worldToScreen = (cellX: number, cellY: number): ScreenPoint => ({
  x: (cellX - cellY) * HALF_TILE_WIDTH,
  y: (cellX + cellY) * HALF_TILE_HEIGHT,
});

/**
 * Точка на экране → клетка мира.
 *
 * Обращение системы уравнений из worldToScreen. Результат дробный: он
 * показывает, в какую точку клетки попали. Округление до целой клетки —
 * забота вызывающего кода, потому что для наведения курсора и для
 * попадания снаряда нужны разные правила округления.
 */
export const screenToWorld = (screenX: number, screenY: number): CellPoint => ({
  x: screenX / TILE_WIDTH_PX + screenY / TILE_HEIGHT_PX,
  y: screenY / TILE_HEIGHT_PX - screenX / TILE_WIDTH_PX,
});

/**
 * Сколько клеток помещается в окно заданного размера.
 *
 * Считается через площадь, а не через пересчёт углов: в изометрии видимая
 * область — ромб, и подсчёт «сколько клеток по горизонтали и вертикали»
 * даёт неверный ответ.
 *
 * Одна клетка занимает на экране `ширина × высота / 2` пикселей — половину
 * описанного вокруг неё прямоугольника, потому что ромб вписан в него
 * ровно наполовину.
 */
export const visibleCellCount = (screenWidth: number, screenHeight: number): number =>
  (screenWidth * screenHeight) / ((TILE_WIDTH_PX * TILE_HEIGHT_PX) / 2);

/** Какую долю карты занимает видимая область, в процентах. */
export const visibleMapPercent = (screenWidth: number, screenHeight: number): number =>
  (visibleCellCount(screenWidth, screenHeight) * 100) / MAP_CELL_COUNT;
