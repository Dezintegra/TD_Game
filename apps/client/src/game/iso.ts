import {
  CELL_SCALE_PX,
  MAP_CELL_COUNT,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  PROJECTION_PITCH_DEG,
  PROJECTION_YAW_DEG,
} from '@td/shared';

/**
 * Аксонометрическая проекция поля.
 *
 * Мир поворачивается вокруг вертикальной оси на угол `yaw`, после чего
 * камера смотрит на него сверху под углом `pitch` к горизонту. Оба угла
 * зафиксированы, поэтому вся проекция сводится к четырём числам,
 * посчитанным один раз при загрузке модуля.
 *
 * Поворот намеренно не равен 45 градусам. При 45 проекция вырождается
 * в честную изометрию, где обе оси мира ложатся на экран симметрично:
 * все рёбра выстраиваются в две одинаковые диагонали, грани соседних
 * объектов сливаются, и силуэты перестают читаться. При 40 градусах правая
 * грань объекта заметно шире левой, направления рёбер у соседей
 * различаются, и каждый объект получает собственный контур.
 *
 * Вертикаль проецируется отдельно: высота уходит вверх по экрану
 * пропорционально косинусу наклона камеры.
 */
const YAW = (PROJECTION_YAW_DEG * Math.PI) / 180;
const PITCH = (PROJECTION_PITCH_DEG * Math.PI) / 180;

const COS_YAW = Math.cos(YAW);
const SIN_YAW = Math.sin(YAW);
const SIN_PITCH = Math.sin(PITCH);
const COS_PITCH = Math.cos(PITCH);

/** Множители перевода мировых координат в экранные. */
const AX = CELL_SCALE_PX * COS_YAW;
const AY = -CELL_SCALE_PX * SIN_YAW;
const BX = CELL_SCALE_PX * SIN_YAW * SIN_PITCH;
const BY = CELL_SCALE_PX * COS_YAW * SIN_PITCH;

/** Сколько экранных пикселей занимает единица высоты. */
export const ELEVATION_PX_PER_CELL = CELL_SCALE_PX * COS_PITCH;

/**
 * Направление «к зрителю» в мировых координатах.
 *
 * Экранная `y` растёт и по мировому `x`, и по мировому `y`: множители
 * `BX` и `BY` оба положительны. Значит, чем больше скалярное произведение
 * мирового вектора на эту пару, тем ближе он к зрителю, — и грань
 * объёмного тела видна тогда и только тогда, когда её внешняя нормаль
 * направлена сюда.
 *
 * Длина вектора роли не играет: важен только знак произведения,
 * поэтому нормировать его незачем.
 */
export const VIEW_DIRECTION = { x: BX, y: BY } as const;

/**
 * Площадь одной клетки на экране.
 *
 * Определитель матрицы проекции. Любопытное свойство: он равен
 * `масштаб² × sin(наклон)` и от угла поворота не зависит совсем —
 * поворот перераспределяет клетку между осями, но не меняет её площадь.
 */
export const CELL_SCREEN_AREA_PX = CELL_SCALE_PX * CELL_SCALE_PX * SIN_PITCH;

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/** Короткое имя для точки на экране — им пользуются все модули отрисовки. */
export type Point = ScreenPoint;

export interface CellPoint {
  readonly x: number;
  readonly y: number;
}

/** Клетка мира → точка на экране. */
export const worldToScreen = (cellX: number, cellY: number): ScreenPoint => ({
  x: cellX * AX + cellY * AY,
  y: cellX * BX + cellY * BY,
});

/**
 * Точка на экране → клетка мира.
 *
 * Обращение матрицы 2 × 2. Результат дробный: он показывает, в какую точку
 * клетки попали. Округление до целой клетки — забота вызывающего кода,
 * потому что для наведения курсора и для попадания снаряда нужны разные
 * правила округления.
 */
const DETERMINANT = AX * BY - AY * BX;

export const screenToWorld = (screenX: number, screenY: number): CellPoint => ({
  x: (screenX * BY - screenY * AY) / DETERMINANT,
  y: (screenY * AX - screenX * BX) / DETERMINANT,
});

/** Сколько клеток помещается в окно заданного размера. */
export const visibleCellCount = (screenWidth: number, screenHeight: number): number =>
  (screenWidth * screenHeight) / CELL_SCREEN_AREA_PX;

/** Какую долю карты занимает видимая область, в процентах. */
export const visibleMapPercent = (screenWidth: number, screenHeight: number): number =>
  (visibleCellCount(screenWidth, screenHeight) * 100) / MAP_CELL_COUNT;

/**
 * Габариты карты на экране.
 *
 * При повороте, отличном от 45 градусов, карта проецируется не в ровный ромб,
 * а в косой параллелограмм, поэтому границы считаются проекцией четырёх углов,
 * а не выводятся из размера клетки.
 */
const corners = [
  worldToScreen(0, 0),
  worldToScreen(MAP_WIDTH_CELLS, 0),
  worldToScreen(MAP_WIDTH_CELLS, MAP_HEIGHT_CELLS),
  worldToScreen(0, MAP_HEIGHT_CELLS),
];

export const MAP_BOUNDS = {
  minX: Math.min(...corners.map((point) => point.x)),
  maxX: Math.max(...corners.map((point) => point.x)),
  minY: Math.min(...corners.map((point) => point.y)),
  maxY: Math.max(...corners.map((point) => point.y)),
} as const;
