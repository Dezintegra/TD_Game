import { describe, expect, it } from 'vitest';
import {
  BASE_CLEARANCE_CELLS,
  MAP_CELL_COUNT,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  Terrain,
  isPassable,
} from '@td/shared';
import {
  areConnected,
  cellIndex,
  cellX,
  cellY,
  generateMap,
  isInsideMap,
  rockPercent,
  rotatedCell,
} from './map.js';

/** Набор seed для массовых проверок. Фиксированный, чтобы падение воспроизводилось. */
const seeds = (count: number): number[] =>
  Array.from({ length: count }, (_unused, index) => index * 7919 + 13);

describe('генерация карты: детерминизм', () => {
  it('одинаковый seed даёт побитово одинаковую карту', () => {
    const first = generateMap(2024);
    const second = generateMap(2024);

    expect(Array.from(first.cells)).toEqual(Array.from(second.cells));
    expect(first.baseCells).toEqual(second.baseCells);
  });

  it('разные seed дают разные карты', () => {
    const first = generateMap(1);
    const second = generateMap(2);

    expect(Array.from(first.cells)).not.toEqual(Array.from(second.cells));
  });
});

describe('генерация карты: симметрия', () => {
  it('каждая клетка совпадает с парной относительно поворота на 180°', () => {
    for (const seed of seeds(100)) {
      const map = generateMap(seed);

      for (let index = 0; index < MAP_CELL_COUNT; index += 1) {
        if (map.cells[index] !== map.cells[rotatedCell(index)]) {
          throw new Error(
            `seed ${seed}: клетка ${index} (${cellX(index)},${cellY(index)}) ` +
              `не совпадает с парной ${rotatedCell(index)}`,
          );
        }
      }
    }
  });

  it('поворот клетки дважды возвращает исходную', () => {
    // Индексы выводятся из размера карты, а не вписаны числами: карта
    // уже однажды уменьшилась, и вписанные уехали за её край.
    const indices = [0, 1, MAP_WIDTH_CELLS - 1, Math.floor(MAP_CELL_COUNT / 3), MAP_CELL_COUNT - 1];

    for (const index of indices) {
      expect(rotatedCell(rotatedCell(index))).toBe(index);
    }
  });
});

describe('генерация карты: базы', () => {
  it('базы расположены симметрично', () => {
    for (const seed of seeds(20)) {
      const map = generateMap(seed);
      const [first, second] = map.baseCells;

      expect(second).toBe(rotatedCell(first ?? 0));
    }
  });

  it('окрестность базы полностью проходима', () => {
    for (const seed of seeds(20)) {
      const map = generateMap(seed);

      for (const base of map.baseCells) {
        const bx = cellX(base);
        const by = cellY(base);

        for (let dy = -BASE_CLEARANCE_CELLS; dy <= BASE_CLEARANCE_CELLS; dy += 1) {
          for (let dx = -BASE_CLEARANCE_CELLS; dx <= BASE_CLEARANCE_CELLS; dx += 1) {
            const x = bx + dx;
            const y = by + dy;
            if (!isInsideMap(x, y)) continue;

            const terrain = map.cells[cellIndex(x, y)] as Terrain;
            expect(isPassable(terrain)).toBe(true);
          }
        }
      }
    }
  });

  it('базы находятся в противоположных углах', () => {
    const map = generateMap(777);
    const [first, second] = map.baseCells;

    expect(cellX(first ?? 0)).toBeLessThan(MAP_WIDTH_CELLS / 2);
    expect(cellY(first ?? 0)).toBeLessThan(MAP_HEIGHT_CELLS / 2);
    expect(cellX(second ?? 0)).toBeGreaterThan(MAP_WIDTH_CELLS / 2);
    expect(cellY(second ?? 0)).toBeGreaterThan(MAP_HEIGHT_CELLS / 2);
  });
});

describe('генерация карты: связность', () => {
  it('путь между базами существует при любом seed', () => {
    for (const seed of seeds(1000)) {
      const map = generateMap(seed);
      const [from, to] = map.baseCells;

      if (!areConnected(map.cells, from ?? 0, to ?? 0)) {
        throw new Error(`seed ${seed}: базы не связаны`);
      }
    }
  });

  it('обход в ширину видит разрыв на искусственно разрезанной карте', () => {
    // Пустая карта, разрезанная сплошной стеной скал по вертикали.
    const cells = new Uint8Array(MAP_CELL_COUNT);
    for (let y = 0; y < MAP_HEIGHT_CELLS; y += 1) {
      cells[cellIndex(MAP_WIDTH_CELLS / 2, y)] = Terrain.Rock;
    }

    const left = cellIndex(1, 1);
    const right = cellIndex(MAP_WIDTH_CELLS - 2, 1);

    expect(areConnected(cells, left, right)).toBe(false);
    expect(areConnected(cells, left, cellIndex(2, 2))).toBe(true);
  });
});

describe('генерация карты: плотность', () => {
  it('доля скал держится в диапазоне от 8 до 25 процентов', () => {
    for (const seed of seeds(100)) {
      const percent = rockPercent(generateMap(seed));

      if (percent < 8 || percent > 25) {
        throw new Error(`seed ${seed}: доля скал ${percent.toFixed(1)}% вне диапазона 8–25%`);
      }
    }
  });
});
