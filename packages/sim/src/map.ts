import {
  BASE_CLEARANCE_CELLS,
  BASE_INSET_CELLS,
  FIXED_POINT_SCALE,
  MAP_CELL_COUNT,
  MAP_HEIGHT_CELLS,
  MAP_ROCK_GAP_CELLS,
  MAP_TARGET_ROCK_PERCENT,
  MAP_WIDTH_CELLS,
  ROCK_ATTEMPT_LIMIT,
  ROCK_ISLAND_MIN_CELLS,
  ROCK_ISLAND_SPAN_CELLS,
  ROCK_MASSIF_MIN_CELLS,
  ROCK_RIDGE_MIN_STEPS,
  ROCK_RIDGE_PERCENT,
  ROCK_RIDGE_SPAN_STEPS,
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
 *   1. посадка скальных массивов с обязательным зазором между ними;
 *   2. расстановка баз с расчисткой площадок;
 *   3. проверка связности и аварийный коридор, если она нарушилась.
 *
 * Почему посадка массивов, а не клеточный автомат и не шум Перлина.
 *
 * Шум Перлина оперирует дробными значениями, а у нас в состоянии мира их
 * быть не должно.
 *
 * Клеточный автомат — классика генерации пещер, но он рассчитан на мир,
 * где камня около половины: там правило «пять и более соседей» устойчиво.
 * Нам нужны редкие островки на открытом поле, и при такой плотности автомат
 * схлопывается — одиночные скалы вымирают быстрее, чем массивы успевают
 * обрасти, и карта вычищается почти дочиста.
 *
 * Третий довод появился вместе с требованием зазора и весит больше первых
 * двух: ни автомат, ни шум не умеют держать расстояние между массивами,
 * потому что не знают, где кончается один массив и начинается другой.
 * Посадка массивов целиком знает это по построению.
 */
export const generateMap = (seed: number): GameMap => {
  const cells = growRockMassifs(createRng(seed));

  const baseCells = placeBases(cells);
  ensureConnected(cells, baseCells);

  return { cells, baseCells };
};

/**
 * Ширина ореола вокруг клетки массива, в клетках.
 *
 * Ореол — это запретная для соседних массивов зона. Зазор между массивами
 * в `MAP_ROCK_GAP_CELLS` клеток означает, что клетки ближе этого расстояния
 * заняты, то есть ореол на единицу уже самого зазора.
 */
const ROCK_HALO_CELLS = MAP_ROCK_GAP_CELLS - 1;

/**
 * Посадка скальных массивов до достижения целевой плотности.
 *
 * Массив собирается целиком в списке и только потом переносится на карту:
 * пока он растёт, его ещё можно отбросить, если получился огрызок.
 *
 * Занятость держится второй маской — `blocked`. В неё вписывается не сама
 * клетка массива, а квадрат вокруг неё: так расстояние до соседей
 * проверяется одним чтением вместо обхода окрестности.
 *
 * Симметрия обеспечивается на месте: ставя клетку, ставим и парную ей
 * относительно поворота на 180°. Поэтому неважно, дорастёт ли массив
 * до нижней половины карты — результат останется симметричным.
 *
 * Цикл считает попытки, а не поставленные массивы: попытка может кончиться
 * ничем, если семя выпало в чужую зону.
 */
const growRockMassifs = (initialRng: RngState): Uint8Array => {
  const cells = new Uint8Array(MAP_CELL_COUNT);
  const blocked = new Uint8Array(MAP_CELL_COUNT);
  // Принадлежность растущему массиву. Массив, а не Set: маска читается
  // за одно обращение, а очищается по списку поставленных клеток.
  const taken = new Uint8Array(MAP_CELL_COUNT);
  const massif: number[] = [];

  let rng = initialRng;

  const targetRockCells = Math.round((MAP_CELL_COUNT * MAP_TARGET_ROCK_PERCENT) / 100);
  let rockCells = 0;

  for (let attempt = 0; attempt < ROCK_ATTEMPT_LIMIT && rockCells < targetRockCells; attempt += 1) {
    // Все случайные величины берутся до роста и в неизменном порядке.
    // Иначе последовательность генератора зависела бы от того, куда завела
    // массив форма соседей, и одна и та же карта перестала бы собираться
    // одинаково при малейшей правке проверок.
    const [rngAfterX, startX] = nextRngInt(rng, MAP_WIDTH_CELLS);
    const [rngAfterY, startY] = nextRngInt(rngAfterX, Math.floor(MAP_HEIGHT_CELLS / 2));
    const [rngAfterKind, kindRoll] = nextRngInt(rngAfterY, 100);
    const isRidge = kindRoll < ROCK_RIDGE_PERCENT;
    const [rngAfterSize, extra] = nextRngInt(
      rngAfterKind,
      isRidge ? ROCK_RIDGE_SPAN_STEPS : ROCK_ISLAND_SPAN_CELLS,
    );
    const [rngAfterDirection, direction] = nextRngInt(rngAfterSize, 4);
    rng = rngAfterDirection;

    const start = cellIndex(startX, startY);
    // Семя проверяется и по себе, и по своей паре: массив, начатый вплотную
    // к отражению чужого, слипся бы с ним после поворота.
    if (blocked[start] === 1 || blocked[rotatedCell(start)] === 1) continue;

    massif.length = 0;
    take(taken, massif, start);

    if (isRidge) {
      rng = growRidge(blocked, taken, massif, {
        rng,
        startX,
        startY,
        steps: ROCK_RIDGE_MIN_STEPS + extra,
        direction,
      });
    } else {
      rng = growIsland(blocked, taken, massif, {
        rng,
        start,
        size: ROCK_ISLAND_MIN_CELLS + extra,
      });
    }

    if (massif.length >= ROCK_MASSIF_MIN_CELLS) {
      for (const cell of massif) {
        const pair = rotatedCell(cell);

        // Счётчик двигают только реально занятые клетки: массив и его пара
        // могут перекрыться у центра карты, и без проверки счётчик разошёлся
        // бы с фактической плотностью.
        if (cells[cell] === Terrain.Ground) {
          cells[cell] = Terrain.Rock;
          rockCells += 1;
        }
        if (cells[pair] === Terrain.Ground) {
          cells[pair] = Terrain.Rock;
          rockCells += 1;
        }
      }

      for (const cell of massif) {
        blockAround(blocked, cell);
        blockAround(blocked, rotatedCell(cell));
      }
    }

    for (const cell of massif) taken[cell] = 0;
  }

  return cells;
};

const take = (taken: Uint8Array, massif: number[], cell: number): void => {
  taken[cell] = 1;
  massif.push(cell);
};

/** Вписывает в маску занятости ореол вокруг клетки. */
const blockAround = (blocked: Uint8Array, cell: number): void => {
  const cx = cellX(cell);
  const cy = cellY(cell);

  for (let dy = -ROCK_HALO_CELLS; dy <= ROCK_HALO_CELLS; dy += 1) {
    for (let dx = -ROCK_HALO_CELLS; dx <= ROCK_HALO_CELLS; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (!isInsideMap(x, y)) continue;

      blocked[cellIndex(x, y)] = 1;
    }
  }
};

/**
 * Годится ли клетка растущему массиву.
 *
 * Три условия: не занята чужим ореолом, не взята уже своим массивом и
 * не подходит вплотную к отражению своего же массива.
 *
 * Последнее приходится проверять обходом окрестности, а не чтением маски:
 * ореол своих клеток в `blocked` не вписан — он появится там только когда
 * массив состоится, — а до тех пор массив, дошедший до центра карты, должен
 * как-то узнать, что упёрся в собственное отражение.
 */
const fitsMassif = (blocked: Uint8Array, taken: Uint8Array, cell: number): boolean => {
  if (blocked[cell] === 1 || taken[cell] === 1) return false;

  const pair = rotatedCell(cell);
  const px = cellX(pair);
  const py = cellY(pair);

  for (let dy = -ROCK_HALO_CELLS; dy <= ROCK_HALO_CELLS; dy += 1) {
    for (let dx = -ROCK_HALO_CELLS; dx <= ROCK_HALO_CELLS; dx += 1) {
      const x = px + dx;
      const y = py + dy;
      if (!isInsideMap(x, y)) continue;

      if (taken[cellIndex(x, y)] === 1) return false;
    }
  }

  return true;
};

interface IslandGrowth {
  readonly rng: RngState;
  readonly start: number;
  readonly size: number;
}

/**
 * Островок: рост присоединением случайной клетки с края.
 *
 * Список кандидатов — соседи уже занятых клеток. Каждый шаг из него
 * вынимается случайная клетка, и если она всё ещё годится, то становится
 * частью массива. Форма выходит округлой с рваным краем — то, что и нужно.
 *
 * Выбранный кандидат вынимается перестановкой с последним и усечением,
 * а не сдвигом: порядок при этом меняется, но меняется детерминированно,
 * одинаково на клиенте и на сервере, а стоит перестановка одного действия
 * вместо сдвига всего хвоста.
 */
const growIsland = (
  blocked: Uint8Array,
  taken: Uint8Array,
  massif: number[],
  growth: IslandGrowth,
): RngState => {
  let rng = growth.rng;
  const frontier: number[] = [];

  pushNeighbours(frontier, growth.start);

  while (massif.length < growth.size && frontier.length > 0) {
    const [nextRngState, pick] = nextRngInt(rng, frontier.length);
    rng = nextRngState;

    const cell = frontier[pick] ?? 0;
    frontier[pick] = frontier[frontier.length - 1] ?? 0;
    frontier.pop();

    // Годность проверяется в момент выбора, а не в момент добавления
    // в список: пока кандидат ждал очереди, массив мог дорасти до него сам
    // или упереться рядом в собственное отражение.
    if (!fitsMassif(blocked, taken, cell)) continue;

    take(taken, massif, cell);
    pushNeighbours(frontier, cell);
  }

  return rng;
};

const pushNeighbours = (frontier: number[], cell: number): void => {
  const x = cellX(cell);
  const y = cellY(cell);

  for (const [dx, dy] of ORTHOGONAL_NEIGHBOURS) {
    const nx = x + dx;
    const ny = y + dy;
    if (!isInsideMap(nx, ny)) continue;

    frontier.push(cellIndex(nx, ny));
  }
};

interface RidgeGrowth {
  readonly rng: RngState;
  readonly startX: number;
  readonly startY: number;
  readonly steps: number;
  readonly direction: number;
}

/**
 * Гряда: направленное блуждание толщиной в две клетки.
 *
 * Направление выбирается один раз, и семь шагов из десяти идут в него,
 * три — поперёк. Без виляния получилась бы линейка, с равновероятными
 * направлениями — тот же островок.
 *
 * Упёршись в чужую зону, гряда останавливается: оборванная гряда честнее
 * петляющей вокруг препятствия — та превратилась бы в кляксу, и разница
 * между двумя видами массивов исчезла бы.
 */
const growRidge = (
  blocked: Uint8Array,
  taken: Uint8Array,
  massif: number[],
  growth: RidgeGrowth,
): RngState => {
  let rng = growth.rng;

  const offset = ORTHOGONAL_NEIGHBOURS[growth.direction] ?? ORTHOGONAL_NEIGHBOURS[0];
  const stepX = offset?.[0] ?? 0;
  const stepY = offset?.[1] ?? 0;

  let x = growth.startX;
  let y = growth.startY;

  for (let step = 1; step < growth.steps; step += 1) {
    const [nextRngState, wobble] = nextRngInt(rng, 10);
    rng = nextRngState;

    // Поперечный ход — это тот же вектор, повёрнутый на 90°: меняем оси
    // местами. Отдельного списка направлений для этого не нужно.
    const asideX = wobble < 3;
    const nextX = x + (asideX ? stepY : stepX);
    const nextY = y + (asideX ? stepX : stepY);
    if (!isInsideMap(nextX, nextY)) break;

    const cell = cellIndex(nextX, nextY);
    if (!fitsMassif(blocked, taken, cell)) break;

    take(taken, massif, cell);

    // Толщина: сосед поперёк хода. Он необязателен — упёршись в чужую зону
    // боком, гряда продолжает идти, просто становясь на клетку тоньше.
    const sideX = nextX + stepY;
    const sideY = nextY + stepX;
    if (isInsideMap(sideX, sideY)) {
      const side = cellIndex(sideX, sideY);
      if (fitsMassif(blocked, taken, side)) take(taken, massif, side);
    }

    x = nextX;
    y = nextY;
  }

  return rng;
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
