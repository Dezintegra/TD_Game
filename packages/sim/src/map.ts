import {
  BASE_CLEARANCE_CELLS,
  BASE_INSET_CELLS,
  FIXED_POINT_SCALE,
  MAP_CELL_COUNT,
  MAP_HEIGHT_CELLS,
  MAP_TARGET_ROCK_PERCENT,
  MAP_WIDTH_CELLS,
  ROCK_BLOB_LIMIT,
  ROCK_BLOB_STEPS,
  Terrain,
  isPassable,
} from '@td/shared';
import type { Vec2 } from '@td/shared';
import { createRng, nextRngInt } from './prng.js';
import type { RngState } from './prng.js';

/**
 * Карта мира: плоская сетка клеток.
 *
 * Хранится одномерным типизированным массивом, а не массивом массивов.
 * Причина не в экономии: Uint8Array занимает непрерывный кусок памяти,
 * поэтому обход по нему кратно быстрее, а именно обходы здесь основная
 * работа — сглаживание, поиск пути, построение геометрии.
 *
 * Индекс клетки: `y * ширина + x`.
 */
export interface GameMap {
  readonly cells: Uint8Array;
  /** Позиции баз по индексу игрока. Индекс клетки, не координаты. */
  readonly baseCells: readonly number[];
}

export const cellIndex = (x: number, y: number): number => y * MAP_WIDTH_CELLS + x;
export const cellX = (index: number): number => index % MAP_WIDTH_CELLS;
export const cellY = (index: number): number => Math.floor(index / MAP_WIDTH_CELLS);

export const isInsideMap = (x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < MAP_WIDTH_CELLS && y < MAP_HEIGHT_CELLS;

/** Половина клетки во внутренних единицах. Смещение от угла клетки к её центру. */
const HALF_CELL = FIXED_POINT_SCALE / 2;

/**
 * Центр клетки во внутренних единицах.
 *
 * Именно центр, а не угол. Сущности стоят в центрах клеток, поэтому
 * расстояние между соседями по горизонтали равно ровно одной клетке,
 * а не нулю с одной стороны и двум с другой.
 */
export const cellCentre = (index: number): Vec2 => ({
  x: cellX(index) * FIXED_POINT_SCALE + HALF_CELL,
  y: cellY(index) * FIXED_POINT_SCALE + HALF_CELL,
});

/**
 * Квадрат расстояния от точки до основания постройки.
 *
 * Постройка занимает площадь, а не точку, и мерить до её центра нельзя.
 * У базы основание три на три клетки: её центр отстоит от края на полторы
 * клетки, и юнит с дальностью в две клетки, упёршийся в основание,
 * оказывался бы от центра на 2,8 клетки — то есть не доставал бы
 * до собственной цели вообще никогда. Ровно так и выглядела ошибка:
 * армия доходила до базы и вставала вокруг, не нанося ей урона.
 *
 * Считается классическое расстояние от точки до прямоугольника: по каждой
 * оси берётся выход за границу, внутри границ он равен нулю.
 */
export const squaredDistanceToFootprint = (
  point: Vec2,
  centreCell: number,
  radiusCells: number,
): number => {
  const minX = (cellX(centreCell) - radiusCells) * FIXED_POINT_SCALE;
  const maxX = (cellX(centreCell) + radiusCells + 1) * FIXED_POINT_SCALE;
  const minY = (cellY(centreCell) - radiusCells) * FIXED_POINT_SCALE;
  const maxY = (cellY(centreCell) + radiusCells + 1) * FIXED_POINT_SCALE;

  const dx = Math.max(minX - point.x, 0, point.x - maxX);
  const dy = Math.max(minY - point.y, 0, point.y - maxY);

  return dx * dx + dy * dy;
};

/**
 * Клетка, в которой находится точка.
 *
 * Координаты за пределами карты прижимаются к краю: вызывающий код почти
 * всегда хочет «ближайшую клетку», а не исключение, и загонять эту проверку
 * в каждое место вызова значило бы размазать её по всему ядру.
 */
export const cellAt = (position: Vec2): number => {
  const x = Math.min(Math.max(Math.floor(position.x / FIXED_POINT_SCALE), 0), MAP_WIDTH_CELLS - 1);
  const y = Math.min(Math.max(Math.floor(position.y / FIXED_POINT_SCALE), 0), MAP_HEIGHT_CELLS - 1);
  return cellIndex(x, y);
};

/**
 * Индекс клетки, симметричной данной относительно поворота карты на 180°.
 *
 * Именно поворот, а не зеркало. При зеркальном отражении у игроков
 * различалась бы «рука»: одному удобные подходы слева, другому справа
 * при формально одинаковых расстояниях. Поворот сохраняет и расстояния,
 * и хиральность.
 */
export const rotatedCell = (index: number): number =>
  cellIndex(MAP_WIDTH_CELLS - 1 - cellX(index), MAP_HEIGHT_CELLS - 1 - cellY(index));

/**
 * Генерация карты из seed.
 *
 * Три этапа:
 *   1. разрастание скальных массивов до целевой плотности;
 *   2. очистка одиночных клеток, оставшихся от блужданий;
 *   3. расстановка баз и починка связности, если она нарушилась.
 *
 * Почему разрастание пятен, а не клеточный автомат или шум Перлина.
 *
 * Шум Перлина оперирует дробными значениями, а у нас в состоянии мира их
 * быть не должно.
 *
 * Клеточный автомат — классика генерации пещер, но он рассчитан на мир,
 * где камня около половины: там правило «пять и более соседей» устойчиво.
 * Нам нужны редкие островки на открытом поле, порядка 15 процентов, и при
 * такой плотности автомат схлопывается — одиночные скалы вымирают быстрее,
 * чем массивы успевают обрасти, и карта вычищается почти дочиста.
 *
 * Разрастание пятен даёт ровно то, что нужно: органичные скальные выходы,
 * плотность задаётся напрямую и не требует подбора коэффициентов, а вся
 * арифметика целочисленная.
 */
export const generateMap = (seed: number): GameMap => {
  const cells = growRockBlobs(createRng(seed));

  despeckle(cells);

  const baseCells = placeBases(cells);
  ensureConnected(cells, baseCells);

  return { cells, baseCells };
};

/**
 * Разрастание скальных массивов до достижения целевой плотности.
 *
 * Каждый массив — след случайного блуждания: выбирается стартовая клетка
 * в верхней половине карты, дальше делается фиксированное число шагов
 * в случайных направлениях, и все пройденные клетки становятся скалой.
 * Блуждание петляет и возвращается, поэтому след получается не червяком,
 * а компактной кляксой — как раз то, что нужно.
 *
 * Симметрия обеспечивается на месте: помечая клетку, помечаем и парную ей
 * относительно поворота на 180°. Поэтому неважно, забредёт ли блуждание
 * в нижнюю половину карты — результат останется симметричным.
 *
 * Цикл останавливается по достижении целевой плотности, а не после
 * заранее посчитанного числа массивов. Так плотность не зависит от того,
 * насколько сильно перекрылись отдельные кляксы.
 */
const growRockBlobs = (initialRng: RngState): Uint8Array => {
  const cells = new Uint8Array(MAP_CELL_COUNT);
  let rng = initialRng;

  const targetRockCells = Math.round((MAP_CELL_COUNT * MAP_TARGET_ROCK_PERCENT) / 100);
  let rockCells = 0;

  for (let blob = 0; blob < ROCK_BLOB_LIMIT && rockCells < targetRockCells; blob += 1) {
    const [rngAfterX, startX] = nextRngInt(rng, MAP_WIDTH_CELLS);
    const [rngAfterY, startY] = nextRngInt(rngAfterX, MAP_HEIGHT_CELLS / 2);
    rng = rngAfterY;

    let x = startX;
    let y = startY;

    for (let step = 0; step < ROCK_BLOB_STEPS; step += 1) {
      const index = cellIndex(x, y);
      const pair = rotatedCell(index);

      // Считаем только реально добавленные клетки: блуждание постоянно
      // возвращается на уже пройденные, и без этой проверки счётчик
      // разошёлся бы с фактической плотностью.
      if (cells[index] === Terrain.Ground) {
        cells[index] = Terrain.Rock;
        rockCells += 1;
      }
      if (cells[pair] === Terrain.Ground) {
        cells[pair] = Terrain.Rock;
        rockCells += 1;
      }

      const [rngAfterStep, direction] = nextRngInt(rng, 4);
      rng = rngAfterStep;

      const offset = ORTHOGONAL_NEIGHBOURS[direction] ?? ORTHOGONAL_NEIGHBOURS[0];
      const nextX = x + (offset?.[0] ?? 0);
      const nextY = y + (offset?.[1] ?? 0);

      // За край карты не выходим: там блуждание залипло бы у границы
      // и вдоль неё образовалась бы скальная кайма.
      if (isInsideMap(nextX, nextY)) {
        x = nextX;
        y = nextY;
      }
    }
  }

  return cells;
};

/**
 * Очистка одиночных скал.
 *
 * Блуждание иногда оставляет за собой отдельные клетки, оторванные от
 * основной кляксы. На каркасном рендере они выглядят как мусор, а на
 * геймплей не влияют никак. Убираем всё, у чего меньше двух соседей-скал.
 *
 * Правило симметрично: оно локально, не зависит от направления и потому
 * переводит симметричную карту в симметричную.
 */
const despeckle = (cells: Uint8Array): void => {
  // Читаем из копии, пишем в оригинал: если читать и писать в один массив,
  // уже обработанные клетки повлияют на ещё не обработанные, и результат
  // станет зависеть от порядка обхода.
  const source = cells.slice();

  for (let y = 0; y < MAP_HEIGHT_CELLS; y += 1) {
    for (let x = 0; x < MAP_WIDTH_CELLS; x += 1) {
      const index = cellIndex(x, y);
      if (source[index] === Terrain.Ground) continue;

      if (countRockNeighbours(source, x, y) < 2) {
        cells[index] = Terrain.Ground;
      }
    }
  }
};

const countRockNeighbours = (cells: Uint8Array, x: number, y: number): number => {
  let count = 0;

  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;

      const nx = x + dx;
      const ny = y + dy;
      if (!isInsideMap(nx, ny)) continue;

      if (cells[cellIndex(nx, ny)] !== Terrain.Ground) {
        count += 1;
      }
    }
  }

  return count;
};

/**
 * Расстановка баз в противоположных углах и расчистка площадок под них.
 *
 * Позиция второй базы получается поворотом первой, поэтому симметрия
 * соблюдается автоматически. Расчистка тоже симметрична: очищая клетку,
 * очищаем и парную.
 */
const placeBases = (cells: Uint8Array): readonly number[] => {
  const first = cellIndex(BASE_INSET_CELLS, BASE_INSET_CELLS);
  const second = rotatedCell(first);

  clearAround(cells, first);

  return [first, second];
};

const clearAround = (cells: Uint8Array, centre: number): void => {
  const cx = cellX(centre);
  const cy = cellY(centre);

  for (let dy = -BASE_CLEARANCE_CELLS; dy <= BASE_CLEARANCE_CELLS; dy += 1) {
    for (let dx = -BASE_CLEARANCE_CELLS; dx <= BASE_CLEARANCE_CELLS; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (!isInsideMap(x, y)) continue;

      const index = cellIndex(x, y);
      cells[index] = Terrain.Ground;
      cells[rotatedCell(index)] = Terrain.Ground;
    }
  }
};

/**
 * Проверка связности баз и починка при её отсутствии.
 *
 * Сглаживание может отрезать базу от остальной карты. Обнаруживаем это
 * обходом в ширину, а чиним прорубанием коридора по прямой между базами.
 *
 * Эта прямая проходит через центр карты, а значит сама по себе симметрична
 * относительно поворота: прорубив её, мы не нарушаем симметрию и не должны
 * отдельно чинить вторую половину.
 *
 * Альтернатива — перегенерировать карту с другим seed до тех пор, пока она
 * не окажется связной — отброшена: число попыток стало бы зависящим от удачи,
 * а seed перестал бы однозначно определять карту.
 */
const ensureConnected = (cells: Uint8Array, baseCells: readonly number[]): void => {
  const [from, to] = baseCells;
  if (from === undefined || to === undefined) return;

  if (areConnected(cells, from, to)) return;

  carveCorridor(cells, from, to);
};

export const areConnected = (cells: Uint8Array, from: number, to: number): boolean => {
  const visited = new Uint8Array(MAP_CELL_COUNT);
  // Очередь на типизированном массиве вместо обычного: shift() у массива
  // сдвигает все элементы, то есть стоит O(n) на каждом шаге. Здесь шагов
  // до девяти тысяч, и разница уже заметна.
  const queue = new Int32Array(MAP_CELL_COUNT);
  let head = 0;
  let tail = 0;

  queue[tail] = from;
  tail += 1;
  visited[from] = 1;

  while (head < tail) {
    const current = queue[head] ?? 0;
    head += 1;

    if (current === to) return true;

    const x = cellX(current);
    const y = cellY(current);

    for (const [dx, dy] of ORTHOGONAL_NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!isInsideMap(nx, ny)) continue;

      const next = cellIndex(nx, ny);
      if (visited[next] === 1) continue;
      if (!isPassable((cells[next] ?? Terrain.Rock) as Terrain)) continue;

      visited[next] = 1;
      queue[tail] = next;
      tail += 1;
    }
  }

  return false;
};

const ORTHOGONAL_NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const CORRIDOR_HALF_WIDTH = 1;

/**
 * Прорубание коридора шириной три клетки по прямой между двумя точками.
 *
 * Линия строится алгоритмом Брезенхэма на целых числах — без единого
 * деления и округления, то есть детерминированно на любой платформе.
 */
const carveCorridor = (cells: Uint8Array, from: number, to: number): void => {
  let x = cellX(from);
  let y = cellY(from);
  const targetX = cellX(to);
  const targetY = cellY(to);

  const stepX = Math.sign(targetX - x);
  const stepY = Math.sign(targetY - y);
  const deltaX = Math.abs(targetX - x);
  const deltaY = -Math.abs(targetY - y);

  let error = deltaX + deltaY;

  for (;;) {
    carveAround(cells, x, y);

    if (x === targetX && y === targetY) break;

    const doubledError = 2 * error;
    if (doubledError >= deltaY) {
      error += deltaY;
      x += stepX;
    }
    if (doubledError <= deltaX) {
      error += deltaX;
      y += stepY;
    }
  }
};

const carveAround = (cells: Uint8Array, cx: number, cy: number): void => {
  for (let dy = -CORRIDOR_HALF_WIDTH; dy <= CORRIDOR_HALF_WIDTH; dy += 1) {
    for (let dx = -CORRIDOR_HALF_WIDTH; dx <= CORRIDOR_HALF_WIDTH; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (!isInsideMap(x, y)) continue;

      const index = cellIndex(x, y);
      cells[index] = Terrain.Ground;
      // Парная клетка очищается явно. На квадратной карте с одинаковым
      // отступом баз линия между ними идеально диагональна и симметрична
      // сама по себе, но полагаться на это свойство хрупко: стоит поменять
      // отступ или сделать карту прямоугольной, и симметрия молча сломается.
      cells[rotatedCell(index)] = Terrain.Ground;
    }
  }
};

/** Доля непроходимых клеток в процентах. Нужна тестам и диагностике. */
export const rockPercent = (map: GameMap): number => {
  let rocks = 0;
  for (const cell of map.cells) {
    if (cell !== Terrain.Ground) rocks += 1;
  }
  return (rocks * 100) / MAP_CELL_COUNT;
};
