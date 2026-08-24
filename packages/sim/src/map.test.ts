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

  it('скала не подходит к основанию базы ближе трёх клеток', () => {
    // Мерим не от центра базы, а от края её основания: база занимает три
    // клетки на три, и расстояние до центра завысило бы зазор на клетку —
    // ровно на ту, из-за которой у базы и было тесно.
    const FOOTPRINT_RADIUS = 1;
    const REQUIRED_GAP = 3;

    for (const seed of seeds(100)) {
      const map = generateMap(seed);

      for (const base of map.baseCells) {
        const bx = cellX(base ?? 0);
        const by = cellY(base ?? 0);

        for (let y = 0; y < MAP_HEIGHT_CELLS; y += 1) {
          for (let x = 0; x < MAP_WIDTH_CELLS; x += 1) {
            if (isPassable(map.cells[cellIndex(x, y)] as Terrain)) continue;

            // Расстояние по Чебышёву: диагональ считается за один шаг,
            // иначе скала, приткнувшаяся к углу площадки, прошла бы проверку.
            const gapX = Math.max(Math.abs(x - bx) - FOOTPRINT_RADIUS, 0);
            const gapY = Math.max(Math.abs(y - by) - FOOTPRINT_RADIUS, 0);
            const gap = Math.max(gapX, gapY);

            if (gap < REQUIRED_GAP) {
              throw new Error(
                `seed ${seed}: скала (${x},${y}) в ${gap} клетках от основания базы (${bx},${by})`,
              );
            }
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

describe('генерация карты: форма скал', () => {
  /** Связные скальные массивы карты. Соседство по восьми направлениям. */
  const massifs = (cells: Uint8Array): number[][] => {
    const seen = new Uint8Array(MAP_CELL_COUNT);
    const found: number[][] = [];

    for (let index = 0; index < MAP_CELL_COUNT; index += 1) {
      if (isPassable(cells[index] as Terrain) || seen[index] === 1) continue;

      const queue = [index];
      seen[index] = 1;

      for (let head = 0; head < queue.length; head += 1) {
        const current = queue[head] ?? 0;
        const x = cellX(current);
        const y = cellY(current);

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (!isInsideMap(nx, ny)) continue;

            const next = cellIndex(nx, ny);
            if (seen[next] === 1 || isPassable(cells[next] as Terrain)) continue;

            seen[next] = 1;
            queue.push(next);
          }
        }
      }

      found.push(queue);
    }

    return found;
  };

  it('массивы не срастаются в цепи во всю карту', () => {
    // Гряда — самый крупный из видов: до двадцати шагов толщиной в две
    // клетки, то есть около сорока клеток. Порог вдвое выше: он ловит
    // не «массив великоват», а «массивы слиплись». Прежняя генерация
    // на этой проверке давала 244 клетки.
    const LIMIT = 80;

    for (const seed of seeds(500)) {
      const map = generateMap(seed);

      for (const massif of massifs(map.cells)) {
        if (massif.length > LIMIT) {
          throw new Error(
            `seed ${seed}: скальный массив в ${massif.length} клеток при пороге ${LIMIT}`,
          );
        }
      }
    }
  });

  it('массивы в основном островки, а не гряды', () => {
    // Вид массива по карте не прочесть — он не хранится нигде, — зато
    // видно его форму. Островок вписывается в почти квадратный прямоугольник,
    // гряда — в вытянутый. Считаем долю вытянутых: гряд по настройке
    // пятнадцать процентов, и если бы виды перепутались местами, доля
    // ушла бы к восьмидесяти.
    const ELONGATED = 2.5;
    const LIMIT_PERCENT = 35;

    let total = 0;
    let elongated = 0;

    for (const seed of seeds(100)) {
      const map = generateMap(seed);

      for (const massif of massifs(map.cells)) {
        let minX = MAP_WIDTH_CELLS;
        let maxX = -1;
        let minY = MAP_HEIGHT_CELLS;
        let maxY = -1;

        for (const cell of massif) {
          minX = Math.min(minX, cellX(cell));
          maxX = Math.max(maxX, cellX(cell));
          minY = Math.min(minY, cellY(cell));
          maxY = Math.max(maxY, cellY(cell));
        }

        const width = maxX - minX + 1;
        const height = maxY - minY + 1;

        total += 1;
        if (Math.max(width, height) / Math.min(width, height) >= ELONGATED) elongated += 1;
      }
    }

    const percent = (elongated * 100) / total;
    if (percent > LIMIT_PERCENT) {
      throw new Error(`вытянутых массивов ${percent.toFixed(1)}% при пороге ${LIMIT_PERCENT}%`);
    }
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
