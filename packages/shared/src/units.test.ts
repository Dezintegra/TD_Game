import { describe, expect, it } from 'vitest';
import { cellsToUnits, unitsToCells, isWithinRadius, vec2 } from './units.js';
import { FIXED_POINT_SCALE } from './constants.js';

describe('фиксированная точка', () => {
  it('переводит клетки в единицы и обратно без потерь', () => {
    for (const cells of [0, 1, 7, 23.5, 0.25]) {
      expect(unitsToCells(cellsToUnits(cells))).toBe(cells);
    }
  });

  it('всегда возвращает целые единицы', () => {
    expect(Number.isInteger(cellsToUnits(1.2345))).toBe(true);
    expect(cellsToUnits(1.5)).toBe(1.5 * FIXED_POINT_SCALE);
  });
});

describe('проверка радиуса', () => {
  it('засчитывает точку на самой границе радиуса', () => {
    const centre = vec2(0, 0);
    const edge = vec2(cellsToUnits(3), 0);
    expect(isWithinRadius(centre, edge, cellsToUnits(3))).toBe(true);
  });

  it('отсекает точку за границей радиуса', () => {
    const centre = vec2(0, 0);
    const outside = vec2(cellsToUnits(3) + 1, 0);
    expect(isWithinRadius(centre, outside, cellsToUnits(3))).toBe(false);
  });
});
