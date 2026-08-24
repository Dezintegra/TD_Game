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
  widenPassages,
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

describe('генерация карты: ширина проходов', () => {
  /**
   * Влезает ли в клетку квадрат три на три целиком проходимых клеток.
   *
   * Именно так и определяется «проход не уже трёх»: клетка годится, если
   * её накрывает хоть один свободный квадрат — неважно, каким углом.
   * Пространство за краем карты считается непроходимым.
   */
  const fitsSquare = (cells: Uint8Array, cx: number, cy: number): boolean => {
    for (let originY = cy - 2; originY <= cy; originY += 1) {
      for (let originX = cx - 2; originX <= cx; originX += 1) {
        let clear = true;

        for (let dy = 0; dy < 3 && clear; dy += 1) {
          for (let dx = 0; dx < 3; dx += 1) {
            const x = originX + dx;
            const y = originY + dy;

            if (!isInsideMap(x, y) || !isPassable(cells[cellIndex(x, y)] as Terrain)) {
              clear = false;
              break;
            }
          }
        }

        if (clear) return true;
      }
    }

    return false;
  };

  it('ни одной проходимой клетки в проходе уже трёх', () => {
    // Прежняя генерация давала такие клетки на КАЖДОЙ карте — в среднем
    // 89 штук. Это и есть то, ради чего заведено раскрытие проходов:
    // проход в клетку ломает строй войска, а правила игры уже опираются
    // на то, что таких мест не бывает.
    for (const seed of seeds(500)) {
      const map = generateMap(seed);

      for (let y = 0; y < MAP_HEIGHT_CELLS; y += 1) {
        for (let x = 0; x < MAP_WIDTH_CELLS; x += 1) {
          if (!isPassable(map.cells[cellIndex(x, y)] as Terrain)) continue;

          if (!fitsSquare(map.cells, x, y)) {
            throw new Error(`seed ${seed}: клетка (${x},${y}) в проходе уже трёх клеток`);
          }
        }
      }
    }
  });

  it('между скалами по прямой не остаётся полосы уже трёх клеток', () => {
    // Та же беда с другой стороны и без хитрости с квадратом: скала,
    // одна-две клетки земли, снова скала. Проверка избыточна намеренно —
    // она читается без объяснений и потому переживёт правку, которая
    // однажды подпортит определение через квадрат.
    for (const seed of seeds(100)) {
      const map = generateMap(seed);
      const blocked = (x: number, y: number): boolean =>
        !isPassable(map.cells[cellIndex(x, y)] as Terrain);

      for (let y = 0; y < MAP_HEIGHT_CELLS; y += 1) {
        for (let x = 0; x < MAP_WIDTH_CELLS; x += 1) {
          for (let width = 1; width <= 2; width += 1) {
            if (x + width + 1 >= MAP_WIDTH_CELLS) continue;
            if (!blocked(x, y) || !blocked(x + width + 1, y)) continue;

            let clear = true;
            for (let step = 1; step <= width; step += 1) {
              if (blocked(x + step, y)) clear = false;
            }

            if (clear) {
              throw new Error(
                `seed ${seed}: полоса земли шириной ${width} между скалами, строка ${y}, столбец ${x}`,
              );
            }
          }
        }
      }
    }
  });

  it('щель между скалой и краем карты зарастает', () => {
    // Собранный вручную случай: массив в двух клетках от края. Зазор
    // между массивами до него не достаёт — край не массив, — и без
    // раскрытия проходов эти две клетки остались бы полосой, в которую
    // не войти.
    const cells = new Uint8Array(MAP_CELL_COUNT);
    for (let y = 5; y < 15; y += 1) {
      for (let x = 2; x < 8; x += 1) {
        cells[cellIndex(x, y)] = Terrain.Rock;
      }
    }

    widenPassages(cells);

    for (let y = 6; y < 14; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        expect(isPassable(cells[cellIndex(x, y)] as Terrain)).toBe(false);
      }
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
