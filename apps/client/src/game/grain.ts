import { GRAIN_TILE_CELLS, grainSlope } from './relief.js';

/**
 * Плитка фактуры породы.
 *
 * Хранит не яркость, а УКЛОН фактуры — две величины на точку. Шейдер
 * берёт их по мировым координатам, складывает с уклоном геометрии,
 * нормирует и освещает; никакого шума на видеокарте при этом нет.
 *
 * Почему плитка, а не расчёт в шейдере. Перенос `valueNoise` и `fbm`
 * в GLSL требует повторить хеш на `uint` с точным переполнением, и любое
 * расхождение с образцовой реализацией обнаружилось бы не тестом,
 * а разницей в картинке. Хуже того, сверить их «до числа» нельзя
 * в принципе: JavaScript считает в двойной точности, GLSL — в одинарной.
 * С плиткой сверять нечего — обе стороны читают одни и те же числа.
 *
 * Растровым ресурсом это не делает: плитка строится процедурно при
 * запуске и файлом не загружается. Требование замысла — про файлы,
 * а не про память, и приём здесь тот же, что записан лечением
 * для взрывов.
 */

/**
 * Сторона плитки в пикселях.
 *
 * При пяти клетках это 205 пикселей на клетку: самая мелкая крошка
 * фактуры занимает восемь пикселей — ещё различима, уже не рябит.
 */
export const GRAIN_TILE_PIXELS = 1024;

/**
 * Во сколько раз уклон уменьшается при укладке в байт.
 *
 * Уклон фактуры — величина со знаком и без естественных границ, а канал
 * текстуры хранит [0, 1]. Множитель подобран по замеру: он покрывает
 * почти весь размах, оставляя запас, и потому обрезание — редкость,
 * а не правило. Точное число проверяется тестом: если фактуру усилят,
 * тест упадёт раньше, чем обрезание станет заметно на картинке.
 */
export const GRAIN_SLOPE_SCALE = 2.2;

export interface GrainTile {
  /** RGBA, по четыре байта на точку. R и G — уклон, B и A не заняты. */
  readonly pixels: Uint8ClampedArray;
  readonly size: number;
  /** Сколько клеток мира укладывается в сторону плитки. */
  readonly cells: number;
}

/** Уклон [-scale, +scale] в байт [0, 255]. Половина шкалы означает ноль. */
export const encodeSlope = (slope: number): number =>
  Math.round(((slope / GRAIN_SLOPE_SCALE + 1) / 2) * 255);

/** Обратно. Нужна тестам и разбору, в кадре не участвует. */
export const decodeSlope = (byte: number): number =>
  ((byte / 255) * 2 - 1) * GRAIN_SLOPE_SCALE;

/**
 * Построить плитку.
 *
 * Считается один раз при запуске и живёт до конца сессии: фактура
 * от карты не зависит и от матча к матчу не меняется — в отличие
 * от рельефа, который свой на каждый seed.
 */
export const buildGrainTile = (size: number = GRAIN_TILE_PIXELS): GrainTile => {
  const pixels = new Uint8ClampedArray(size * size * 4);
  const perPixel = GRAIN_TILE_CELLS / size;

  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const slope = grainSlope(column * perPixel, row * perPixel);
      const offset = (row * size + column) * 4;

      pixels[offset] = encodeSlope(slope.du);
      pixels[offset + 1] = encodeSlope(slope.dv);
      pixels[offset + 2] = 0;
      pixels[offset + 3] = 255;
    }
  }

  return { pixels, size, cells: GRAIN_TILE_CELLS };
};
