import { describe, expect, it } from 'vitest';
import { MAP_CELL_COUNT, MAP_WIDTH_CELLS, Terrain } from '@td/shared';
import type { GameMap } from '@td/sim';
import { forEachBoundaryEdge } from './terrain.js';

/** Пустая карта с одной прямоугольной скальной областью. */
const mapWithRockBlock = (left: number, top: number, size: number): GameMap => {
  const cells = new Uint8Array(MAP_CELL_COUNT);

  for (let y = top; y < top + size; y += 1) {
    for (let x = left; x < left + size; x += 1) {
      cells[y * MAP_WIDTH_CELLS + x] = Terrain.Rock;
    }
  }

  return { cells, baseCells: [] };
};

const countEdges = (map: GameMap): number => {
  let count = 0;
  forEachBoundaryEdge(map, () => {
    count += 1;
  });
  return count;
};

describe('границы скальных массивов', () => {
  it('у монолита 3 × 3 отрисовано 12 рёбер, а не 36', () => {
    // Периметр квадрата 3 × 3 — двенадцать рёбер. Внутренние рёбра
    // не выдаются: их не видно, а вершин они добавляют втрое больше.
    expect(countEdges(mapWithRockBlock(10, 10, 3))).toBe(12);
  });

  it('у одиночной скалы четыре ребра', () => {
    expect(countEdges(mapWithRockBlock(20, 20, 1))).toBe(4);
  });

  it('число рёбер растёт как периметр, а не как площадь', () => {
    expect(countEdges(mapWithRockBlock(10, 10, 5))).toBe(20);
    expect(countEdges(mapWithRockBlock(10, 10, 10))).toBe(40);
  });

  it('на карте без скал рёбер нет', () => {
    expect(countEdges({ cells: new Uint8Array(MAP_CELL_COUNT), baseCells: [] })).toBe(0);
  });

  it('скала у самого края карты не даёт ребра наружу', () => {
    // Клетки за границей карты считаются скалой, поэтому внешнее ребро
    // угловой скалы рисовать не нужно: там всё равно ничего не видно.
    expect(countEdges(mapWithRockBlock(0, 0, 1))).toBe(2);
  });
});
