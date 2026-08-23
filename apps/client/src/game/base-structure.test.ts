import { describe, expect, it } from 'vitest';
import {
  BASE_ANTENNA_HEIGHT,
  BASE_CREST_LIFT_PX,
  BEACON_PERIOD_TICKS,
  baseBeaconPoint,
  baseCrestPoint,
  beaconGlow,
} from './base-structure.js';
import { baseScreenBounds } from './base-render.js';
import { ELEVATION_PX_PER_CELL, worldToScreen } from './iso.js';

/**
 * Где у базы верх — вопрос не вкусовой: к гребню цепляется полоса
 * прочности, и промах здесь означает полосу, рассекающую антенну.
 *
 * Проверяется он не картинкой, а координатами: габарит модели считает
 * сама отрисовка, и с ним сравнивается точка крепления. Скриншот сказал
 * бы то же самое, но перестал бы что-либо доказывать при первой смене
 * палитры.
 */

/**
 * Верх сооружения в той же системе координат, что и точка гребня.
 *
 * Габарит модели считается относительно точки привязки, а гребень —
 * относительно места базы на карте; сравнивать их напрямую нельзя.
 */
const topOfBase = (centreX: number, centreY: number): number =>
  worldToScreen(centreX, centreY).y + baseScreenBounds().minY;

describe('гребень командного центра', () => {
  it('лежит выше самой высокой точки сооружения', () => {
    // Мачта вынесена в сторону от точки привязки, то есть на экране
    // стои́т выше неё. Полоса прочности начинается от гребня и уходит
    // вверх, поэтому гребень обязан быть выше всего сооружения целиком,
    // а не выше его середины.
    expect(baseCrestPoint(20, 20).y).toBeLessThan(topOfBase(20, 20));
  });

  it('не отрывается от силуэта', () => {
    // Обратная опасность: полоса, забравшаяся в небо, перестаёт читаться
    // как часть базы. Просвет должен быть заметным, но небольшим.
    const gap = topOfBase(20, 20) - baseCrestPoint(20, 20).y;

    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(ELEVATION_PX_PER_CELL);
  });

  it('стоит над серединой базы, а не над антенной', () => {
    const centre = worldToScreen(20, 20);

    expect(baseCrestPoint(20, 20).x).toBe(centre.x);
  });

  it('поднят выше самой антенны', () => {
    // Отдельная проверка на случай, если высоту антенны поднимут,
    // а про гребень забудут.
    expect(BASE_CREST_LIFT_PX).toBeGreaterThan(BASE_ANTENNA_HEIGHT * ELEVATION_PX_PER_CELL);
  });
});

describe('проблесковый огонь', () => {
  it('горит на мачте, а не над серединой базы', () => {
    // Мачта смещена от точки привязки, и огонь обязан быть на ней:
    // огонь по центру читался бы висящим в воздухе.
    const beacon = baseBeaconPoint(20, 20);

    expect(beacon.x).not.toBe(worldToScreen(20, 20).x);
  });

  it('остаётся ниже полосы прочности', () => {
    // Иначе полоса и огонь наложились бы друг на друга.
    expect(baseBeaconPoint(20, 20).y).toBeGreaterThan(baseCrestPoint(20, 20).y);
  });

  it('мигает: то горит, то нет', () => {
    const values: number[] = [];
    for (let tick = 0; tick < BEACON_PERIOD_TICKS; tick += 1) values.push(beaconGlow(tick));

    expect(Math.max(...values)).toBeGreaterThan(0.9);
    expect(Math.min(...values)).toBe(0);
  });

  it('молчит дольше, чем горит', () => {
    // Заградительный огонь — короткая вспышка, а не мигалка. Горящий
    // больше половины времени читается лампой, а не сигналом.
    let burning = 0;
    for (let tick = 0; tick < BEACON_PERIOD_TICKS; tick += 1) {
      if (beaconGlow(tick) > 0) burning += 1;
    }

    expect(burning).toBeLessThan(BEACON_PERIOD_TICKS / 2);
  });

  it('фаза повторяется через период', () => {
    for (let tick = 0; tick < 20; tick += 1) {
      expect(beaconGlow(tick + BEACON_PERIOD_TICKS)).toBeCloseTo(beaconGlow(tick), 10);
    }
  });

  it('зависит от тика, а не от частоты кадров', () => {
    // Проверка того же требования с другой стороны: сколько бы раз
    // кадр ни спросил про один и тот же тик, ответ обязан совпасть.
    const first = beaconGlow(7);
    const second = beaconGlow(7);

    expect(second).toBe(first);
  });

  it('яркость не выходит за единицу', () => {
    for (let tick = 0; tick < 200; tick += 1) {
      expect(beaconGlow(tick)).toBeGreaterThanOrEqual(0);
      expect(beaconGlow(tick)).toBeLessThanOrEqual(1);
    }
  });
});
