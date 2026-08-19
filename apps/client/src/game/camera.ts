import { MAP_HEIGHT_CELLS, MAP_WIDTH_CELLS, TILE_HEIGHT_PX, TILE_WIDTH_PX } from '@td/shared';

/**
 * Камера.
 *
 * Хранит точку, на которую смотрит игрок, в экранных координатах мира —
 * то есть уже после изометрической проекции, но до сдвига контейнера.
 *
 * Движение камеры не перестраивает ничего: оно превращается в сдвиг
 * контейнера сцены, то есть в два числа. Именно поэтому прокрутка карты
 * стоит примерно ноль независимо от того, сколько геометрии на ней лежит.
 */
export interface Camera {
  readonly x: number;
  readonly y: number;
}

/**
 * Границы карты в экранных координатах.
 *
 * В изометрии карта — это ромб, а не прямоугольник, поэтому её габариты
 * считаются не по размеру в клетках напрямую. Крайняя левая точка — западный
 * угол, то есть клетка (0, высота); крайняя правая — восточный, (ширина, 0).
 */
const HALF_TILE_WIDTH = TILE_WIDTH_PX / 2;
const HALF_TILE_HEIGHT = TILE_HEIGHT_PX / 2;

export const MAP_BOUNDS = {
  minX: -MAP_HEIGHT_CELLS * HALF_TILE_WIDTH,
  maxX: MAP_WIDTH_CELLS * HALF_TILE_WIDTH,
  minY: 0,
  maxY: (MAP_WIDTH_CELLS + MAP_HEIGHT_CELLS) * HALF_TILE_HEIGHT,
} as const;

/** Камера, смотрящая в центр карты. */
export const createCamera = (): Camera => ({
  x: (MAP_BOUNDS.minX + MAP_BOUNDS.maxX) / 2,
  y: (MAP_BOUNDS.minY + MAP_BOUNDS.maxY) / 2,
});

/**
 * Ограничение камеры границами карты.
 *
 * Если карта по какому-то измерению меньше окна, камера по этому измерению
 * центрируется: иначе она болталась бы, показывая пустоту то с одной
 * стороны, то с другой.
 */
export const clampCamera = (
  camera: Camera,
  viewportWidth: number,
  viewportHeight: number,
): Camera => ({
  x: clampAxis(camera.x, MAP_BOUNDS.minX, MAP_BOUNDS.maxX, viewportWidth),
  y: clampAxis(camera.y, MAP_BOUNDS.minY, MAP_BOUNDS.maxY, viewportHeight),
});

const clampAxis = (value: number, min: number, max: number, viewport: number): number => {
  const half = viewport / 2;

  if (max - min <= viewport) return (min + max) / 2;

  return Math.min(Math.max(value, min + half), max - half);
};

export const moveCamera = (camera: Camera, dx: number, dy: number): Camera => ({
  x: camera.x + dx,
  y: camera.y + dy,
});
