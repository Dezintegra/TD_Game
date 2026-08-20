import { describe, expect, it } from 'vitest';
import type { Graphics } from 'pixi.js';
import {
  BASE_ANTENNA_HEIGHT,
  BASE_CREST_LIFT_PX,
  baseCrestPoint,
  drawBase,
} from './base-structure.js';
import { ELEVATION_PX_PER_CELL, worldToScreen } from './iso.js';

/**
 * Где у базы верх — вопрос не вкусовой: к гребню цепляется полоса
 * прочности, и промах здесь означает полосу, рассекающую антенну.
 *
 * Проверяется он не картинкой, а координатами: база рисуется в заглушку,
 * которая запоминает каждую точку, и полученный габарит сравнивается
 * с точкой крепления. Скриншот сказал бы то же самое, но перестал бы
 * что-либо доказывать при первой смене палитры.
 */

/** Заглушка Graphics, запоминающая все точки, которые ей назвали. */
const tracing = (): { graphics: Graphics; points: { x: number; y: number }[] } => {
  const points: { x: number; y: number }[] = [];
  const stub: Record<string, (...args: number[]) => unknown> = {};

  for (const name of ['moveTo', 'lineTo', 'circle']) {
    stub[name] = (x, y) => {
      points.push({ x, y });
      return stub;
    };
  }

  for (const name of ['closePath', 'fill', 'stroke', 'rect', 'clear']) {
    stub[name] = () => stub;
  }

  return { graphics: stub as unknown as Graphics, points };
};

/** Габарит нарисованной базы в экранных координатах. */
const baseBounds = (centreX: number, centreY: number) => {
  const { graphics, points } = tracing();
  drawBase(graphics, centreX, centreY, 0x00ff29);

  expect(points.length).toBeGreaterThan(0);

  return {
    top: Math.min(...points.map((point) => point.y)),
    left: Math.min(...points.map((point) => point.x)),
    right: Math.max(...points.map((point) => point.x)),
  };
};

describe('гребень командного центра', () => {
  it('лежит выше самой высокой точки нарисованной базы', () => {
    // Мачта с тарелкой стоит в северо-западном углу, то есть на экране
    // выше центра базы. Полоса прочности начинается от гребня и уходит
    // вверх, поэтому гребень обязан быть выше всего сооружения целиком,
    // а не выше его центра.
    const bounds = baseBounds(20, 20);

    expect(baseCrestPoint(20, 20).y).toBeLessThan(bounds.top);
  });

  it('не отрывается от силуэта', () => {
    // Обратная опасность: полоса, забравшаяся в небо, перестаёт читаться
    // как часть базы. Просвет должен быть заметным, но небольшим.
    const bounds = baseBounds(20, 20);
    const gap = bounds.top - baseCrestPoint(20, 20).y;

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
