import { describe, expect, it } from 'vitest';
import { MAP_CELL_COUNT, MAP_WIDTH_CELLS, Terrain } from '@td/shared';
import type { GameMap } from '@td/sim';
import { MAX_ROCK_HEIGHT, rockHeight } from './rocks.js';
import { BASE_ANTENNA_HEIGHT, BASE_FOOTPRINT_CELLS, BASE_PART_COUNT } from './base-structure.js';

const mapWithRockBlock = (left: number, top: number, size: number): GameMap => {
  const cells = new Uint8Array(MAP_CELL_COUNT);

  for (let y = top; y < top + size; y += 1) {
    for (let x = left; x < left + size; x += 1) {
      cells[y * MAP_WIDTH_CELLS + x] = Terrain.Rock;
    }
  }

  return { cells, baseCells: [] };
};

describe('высота скал', () => {
  it('одна и та же клетка всегда одной высоты', () => {
    expect(rockHeight(17, 42)).toBe(rockHeight(17, 42));
    expect(rockHeight(0, 0)).toBe(rockHeight(0, 0));
  });

  it('высота держится в объявленном диапазоне', () => {
    for (let y = 0; y < 40; y += 1) {
      for (let x = 0; x < 40; x += 1) {
        const height = rockHeight(x, y);
        expect(height).toBeGreaterThan(0);
        expect(height).toBeLessThanOrEqual(MAX_ROCK_HEIGHT);
      }
    }
  });

  it('крупный массив содержит клетки минимум трёх разных уровней', () => {
    // Без разброса высот массив читается как коробка, а не как скальный выход.
    const map = mapWithRockBlock(10, 10, 8);
    const levels = new Set<number>();

    for (let index = 0; index < map.cells.length; index += 1) {
      if (map.cells[index] === Terrain.Ground) continue;
      levels.add(rockHeight(index % MAP_WIDTH_CELLS, Math.floor(index / MAP_WIDTH_CELLS)));
    }

    expect(levels.size).toBeGreaterThanOrEqual(3);
  });

  it('соседние клетки не обязаны совпадать по высоте', () => {
    let differences = 0;
    for (let x = 0; x < 50; x += 1) {
      if (rockHeight(x, 5) !== rockHeight(x + 1, 5)) differences += 1;
    }

    expect(differences).toBeGreaterThan(20);
  });
});

describe('командный центр', () => {
  it('собран минимум из четырёх различимых частей', () => {
    expect(BASE_PART_COUNT).toBeGreaterThanOrEqual(4);
  });

  it('антенна выше самой высокой возможной скалы', () => {
    // База — главная цель матча, её положение должно читаться раньше всего.
    expect(BASE_ANTENNA_HEIGHT).toBeGreaterThan(MAX_ROCK_HEIGHT);
  });

  it('занимает площадь не менее девяти клеток', () => {
    expect(BASE_FOOTPRINT_CELLS).toBeGreaterThanOrEqual(9);
  });
});
