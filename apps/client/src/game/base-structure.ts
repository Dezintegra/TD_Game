import type { Container, Renderer } from 'pixi.js';
import { ELEVATION_PX_PER_CELL, worldToScreen } from './iso.js';
import type { Point } from './iso.js';
import { BASE_TOP_LEVEL, MAST_X, MAST_Y } from './base-model.js';
import { mountBase } from './base-render.js';
import type { BaseColors } from './base-render.js';

/**
 * Командный центр — база игрока.
 *
 * Этот модуль остался фасадом: он знает, ГДЕ у базы верх и как её
 * поставить на карту, но не знает, из чего она собрана. Устройство
 * сооружения живёт в `base-model.ts`, отрисовка — в `base-render.ts`.
 *
 * Разделение появилось не ради чистоты. К гребню базы цепляется полоса
 * прочности, а рисует её отрисовка сущностей — то есть совсем другой
 * модуль, которому нельзя знать про тела, фермы и чаши. Раньше знание
 * «где верх» выводилось из тех же чисел, что и модель, и лежало рядом
 * с ней; теперь оно выводится из одного числа `BASE_TOP_LEVEL`, а модель
 * может меняться как угодно.
 */

export { BASE_ANTENNA_HEIGHT, BASE_FOOTPRINT_CELLS, BASE_LAUNCH_POINT } from './base-model.js';
export type { BaseColors } from './base-render.js';

/** Просвет между верхом сооружения и полосой прочности, в пикселях. */
const CREST_CLEARANCE_PX = 12;

/**
 * Подъём гребня над точкой привязки базы, в экранных пикселях.
 *
 * Величина постоянная, и это следствие линейности проекции: расстояние
 * между привязкой базы и верхом её антенны на экране одно и то же,
 * где бы база ни стояла. Поэтому считается один раз при загрузке
 * модуля, а не на каждом кадре.
 *
 * Слагаемые: мачта вынесена от привязки в сторону и потому уже стои́т
 * на экране выше неё, дальше высота самого сооружения и просвет.
 */
export const BASE_CREST_LIFT_PX =
  -worldToScreen(MAST_X, MAST_Y).y + BASE_TOP_LEVEL * ELEVATION_PX_PER_CELL + CREST_CLEARANCE_PX;

/**
 * Точка над гребнем базы: сюда цепляется полоса прочности.
 *
 * По горизонтали берётся от точки привязки, а не от мачты: полоса
 * должна висеть над серединой сооружения, а не над антенной,
 * смещённой в угол.
 */
export const baseCrestPoint = (centreX: number, centreY: number): Point => {
  const centre = worldToScreen(centreX, centreY);

  return { x: centre.x, y: centre.y - BASE_CREST_LIFT_PX };
};

/**
 * Экранная точка проблескового огня на вершине мачты.
 *
 * Огонь — единственная часть базы, которая не запекается: он мигает,
 * а запечённая текстура мигать не умеет. Рисуется он в слое поверх тел,
 * рядом с полосой прочности.
 */
export const baseBeaconPoint = (centreX: number, centreY: number): Point => {
  const at = worldToScreen(centreX + MAST_X, centreY + MAST_Y);

  return { x: at.x, y: at.y - BASE_BEACON_LEVEL * ELEVATION_PX_PER_CELL };
};

/** Высота огня. На полклетки выше вершины мачты — как на настоящей. */
const BASE_BEACON_LEVEL = BASE_TOP_LEVEL - 0.12;

/**
 * Период мигания, в тиках.
 *
 * Полтора десятка тиков горит, три десятка молчит — при тридцати тиках
 * в секунду это привычный ритм авиационного заградительного огня.
 * Считается от НОМЕРА ТИКА, а не от часов: у игроков разная частота
 * кадров, а тик общий, и одно и то же событие обязано выглядеть
 * у обоих одинаково.
 */
export const BEACON_PERIOD_TICKS = 45;

/** Какую долю периода занимает вспышка. */
const FLASH_SHARE = 0.34;

/** Яркость огня на заданном тике: от нуля до единицы. */
export const beaconGlow = (tick: number): number => {
  const phase =
    (((tick % BEACON_PERIOD_TICKS) + BEACON_PERIOD_TICKS) % BEACON_PERIOD_TICKS) /
    BEACON_PERIOD_TICKS;
  if (phase >= FLASH_SHARE) return 0;

  // Полуволна синуса: огонь разгорается и гаснет, а не щёлкает. Резкое
  // переключение на объекте в три пикселя читается мерцанием экрана,
  // а не сигналом.
  return Math.sin((Math.PI * phase) / FLASH_SHARE);
};

/**
 * Поставить базу на карту.
 *
 * Строится один раз при загрузке карты: база неподвижна и неизменна.
 */
export const placeBase = (
  layer: Container,
  renderer: Renderer,
  centreX: number,
  centreY: number,
  colors: BaseColors,
  density: number,
): void => {
  mountBase(layer, renderer, centreX, centreY, colors, density);
};
