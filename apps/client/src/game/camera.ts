import { MAP_BOUNDS } from './iso.js';

/**
 * Камера.
 *
 * Хранит точку, на которую смотрит игрок, в экранных координатах мира —
 * то есть уже после проекции, но до сдвига контейнера.
 *
 * Движение камеры не перестраивает ничего: оно превращается в сдвиг
 * контейнера сцены, то есть в два числа. Именно поэтому прокрутка карты
 * стоит примерно ноль независимо от того, сколько геометрии на ней лежит.
 */
export interface Camera {
  readonly x: number;
  readonly y: number;
}

export { MAP_BOUNDS };

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
