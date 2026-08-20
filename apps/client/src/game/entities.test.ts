import { describe, expect, it } from 'vitest';
import type { Graphics } from 'pixi.js';
import { PPM_ONE, StructureKind, UnitType, asEntityId, asPlayerId, asTickNumber } from '@td/shared';
import { cellCentre, cellIndex, createWorld } from '@td/sim';
import type { WorldState } from '@td/sim';
import { drawEntities } from './entities.js';
import type { EntityColors, EntityLayers, ViewBounds } from './entities.js';

/**
 * Порядок отрисовки проверяется не картинкой, а тем, в какую полосу
 * глубины попал объект.
 *
 * Полосы и есть механизм перекрытия: между ними сцена вставляет слои
 * неподвижной территории, поэтому «юнит попал в полосу раньше скалы»
 * означает ровно «юнит нарисован за скалой». Скриншот сказал бы то же
 * самое, но перестал бы что-либо доказывать при первой смене палитры.
 */

const SEED = 4242;

/** Заглушка Graphics: методы ничего не делают, но остаются цепочечными. */
const stubGraphics = (): Graphics => {
  const stub: Record<string, () => unknown> = {};
  for (const name of [
    'moveTo',
    'lineTo',
    'closePath',
    'fill',
    'stroke',
    'circle',
    'rect',
    'clear',
  ]) {
    stub[name] = () => stub;
  }
  return stub as unknown as Graphics;
};

/** Экран заведомо больше карты: отсечение по видимости не должно мешать. */
const WHOLE_MAP: ViewBounds = {
  minX: -1e6,
  maxX: 1e6,
  minY: -1e6,
  maxY: 1e6,
};

const COLORS: EntityColors = {
  self: 0x00ff29,
  enemy: 0xd264ff,
  hullDark: 0x23271f,
  health: 0x00ff29,
  healthLow: 0xff5c5c,
  shot: 0xeaffef,
  shotLethal: 0xff5c5c,
};

/**
 * Мир без живых генералов и без построек, кроме заказанных.
 * Базы в отрисовке сущностей не участвуют — их рисует территория.
 */
const bare = (): WorldState => {
  const world = createWorld(SEED);

  return {
    ...world,
    generals: world.generals.map((general) => ({ ...general, alive: false })),
    units: [],
    shots: [],
  };
};

const wallAt = (cell: number) => ({
  id: asEntityId(500),
  owner: asPlayerId(0),
  kind: StructureKind.Wall,
  cell,
  health: 100,
  growthPpm: PPM_ONE,
  readyAtTick: asTickNumber(0),
  builtAtTick: asTickNumber(0),
});

const unitAt = (cell: number) => ({
  id: asEntityId(600),
  owner: asPlayerId(0),
  unitType: UnitType.Assault,
  position: cellCentre(cell),
  health: 100,
  readyAtTick: asTickNumber(0),
});

/** Полосы, которые запросила отрисовка, в порядке обращения. */
const bandsFor = (world: WorldState): number[] => {
  const graphics = stubGraphics();
  const bands: number[] = [];

  const layers: EntityLayers = {
    band(index) {
      bands.push(index);
      return graphics;
    },
    shots: graphics,
  };

  drawEntities(layers, world, WHOLE_MAP, COLORS, asPlayerId(0));

  return bands;
};

describe('полосы глубины', () => {
  it('постройка и юнит в одной клетке попадают в одну полосу', () => {
    // Раньше постройка считалась по углу клетки, а юнит по своей точке,
    // и одна и та же клетка давала им разные полосы. Из-за этого юнит
    // севернее постройки оказывался с ней вровень и рисовался поверх,
    // хотя стоит за ней.
    const cell = cellIndex(10, 10);

    const structureBands = bandsFor({ ...bare(), structures: [wallAt(cell)] });
    const unitBands = bandsFor({ ...bare(), units: [unitAt(cell)] });

    expect(new Set(structureBands)).toEqual(new Set([21]));
    expect(new Set(unitBands)).toEqual(new Set([21]));
  });

  it('юнит южнее постройки попадает в более позднюю полосу', () => {
    const world = {
      ...bare(),
      structures: [wallAt(cellIndex(10, 10))],
      units: [unitAt(cellIndex(10, 11))],
    };

    const bands = bandsFor(world);

    // Сортировка по глубине гарантирует неубывание, а разные полосы —
    // что между ними может вклиниться территория.
    expect(bands).toEqual([...bands].sort((a, b) => a - b));
    expect(Math.max(...bands)).toBe(22);
    expect(Math.min(...bands)).toBe(21);
  });

  it('юнит севернее постройки попадает в более раннюю полосу', () => {
    const world = {
      ...bare(),
      structures: [wallAt(cellIndex(10, 10))],
      units: [unitAt(cellIndex(10, 9))],
    };

    const bands = bandsFor(world);

    expect(bands[0]).toBe(20);
    expect(Math.max(...bands)).toBe(21);
  });
});
