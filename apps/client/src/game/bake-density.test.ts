import { describe, expect, it } from 'vitest';
import {
  MAX_BAKE_DENSITY,
  ROCK_BAKE_BUDGET_MB,
  ROCK_CELL_AREA_PX,
  ZOOM_OVERSAMPLE,
  rockBakeDensity,
  sceneBakeDensity,
} from './bake-density.js';

/** Во что обходится слой скал при такой плотности, в мегабайтах. */
const rockLayerMb = (cells: number, density: number): number =>
  (cells * ROCK_CELL_AREA_PX * density * density * 4 * (4 / 3)) / (1024 * 1024);

describe('плотность запекания сцены', () => {
  it('даёт запас на приближение при обычном экране', () => {
    expect(sceneBakeDensity(1)).toBe(ZOOM_OVERSAMPLE);
  });

  it('не превышает потолка на плотном экране', () => {
    expect(sceneBakeDensity(2)).toBe(MAX_BAKE_DENSITY);
    expect(sceneBakeDensity(3)).toBe(MAX_BAKE_DENSITY);
  });

  it('не опускается ниже единицы при плотности экрана меньше единицы', () => {
    // Такое бывает: браузер отдаёт дробную плотность при масштабировании
    // системы. Запекать реже показа нельзя ни при каких обстоятельствах.
    expect(sceneBakeDensity(0.75)).toBeGreaterThanOrEqual(1);
    expect(sceneBakeDensity(0.5)).toBe(ZOOM_OVERSAMPLE);
  });
});

describe('плотность запекания скал', () => {
  // Карта на двоих: сторона 38, около 13 процентов клеток скальные.
  const smallMapCells = 220;
  // Карта на четверых: сторона 58, площадь вдвое с третью больше.
  const largeMapCells = 512;

  it('укладывается в бюджет на карте для двоих', () => {
    const density = rockBakeDensity(sceneBakeDensity(1), smallMapCells);

    expect(rockLayerMb(smallMapCells, density)).toBeLessThanOrEqual(ROCK_BAKE_BUDGET_MB);
  });

  it('снижает плотность на карте вдвое большей и остаётся в бюджете', () => {
    const scene = sceneBakeDensity(1);
    const small = rockBakeDensity(scene, smallMapCells);
    const large = rockBakeDensity(scene, largeMapCells);

    expect(large).toBeLessThan(small);
    expect(rockLayerMb(largeMapCells, large)).toBeLessThanOrEqual(ROCK_BAKE_BUDGET_MB);
  });

  it('не поднимается выше плотности сцены, когда бюджет позволяет больше', () => {
    const scene = sceneBakeDensity(1);

    expect(rockBakeDensity(scene, 4)).toBe(scene);
  });

  it('не опускается ниже единицы даже на карте, не влезающей в бюджет', () => {
    expect(rockBakeDensity(sceneBakeDensity(1), 100_000)).toBe(1);
  });

  it('на карте без скал возвращает плотность сцены, а не бесконечность', () => {
    const scene = sceneBakeDensity(1);

    expect(rockBakeDensity(scene, 0)).toBe(scene);
    expect(Number.isFinite(rockBakeDensity(scene, 0))).toBe(true);
  });
});
