import { MAP_CELL_COUNT, STRUCTURE_STATS, StructureKind } from '@td/shared';
import type { PlayerId } from '@td/shared';
import { UNREACHABLE, buildOccupancy, dijkstraField, footprintCells } from '@td/sim';
import type { Occupancy, WorldState } from '@td/sim';

/**
 * Вероятный путь вражеских войск.
 *
 * Первая версия противника ставила башни в свободную клетку, ближайшую
 * к вражеской базе. Звучит наступательно, а на деле башни регулярно
 * оказывались в скальном кармане, куда никто никогда не придёт: «ближе
 * к врагу» по прямой и «на дороге к врагу» — разные вещи, и на карте
 * со скалами они расходятся почти всегда.
 *
 * Правильный признак — лежит ли клетка на маршруте, по которому войска
 * реально пойдут. Считается это без всякой эвристики: два обхода карты,
 * от своей базы и от чужой. Клетка лежит на пути, если сумма расстояний
 * до обеих баз превышает кратчайшее расстояние между ними не больше чем
 * на допуск. При нулевом допуске получилась бы одна нитка кратчайшего
 * пути, при разумном — коридор всех разумных обходов.
 */

/** Другой игрок. Матч на двоих, поэтому арифметики хватает. */
export const otherPlayer = (id: PlayerId): number => 1 - id;

/**
 * Насколько маршрут может быть длиннее кратчайшего, чтобы всё ещё считаться
 * вероятным путём вражеских войск, в клетках.
 *
 * Ноль означал бы одну-единственную нитку, и башня чуть в стороне от неё
 * считалась бы бесполезной. Слишком много — и «вероятным путём» станет
 * половина карты, а вместе с этим исчезнет сам смысл понятия.
 */
const PATH_SLACK_CELLS = 6;

export interface Approach {
  /** Единица — клетка лежит на маршруте, близком к кратчайшему. */
  readonly onPath: Uint8Array;
  /** Расстояние от своей базы по проходимым клеткам. */
  readonly fromHome: Int32Array;
  /** Длина кратчайшего маршрута между базами. */
  readonly shortest: number;
  /** Занятость, посчитанная заодно: она нужна и строительству, и движению. */
  readonly occupancy: Occupancy;
}

/**
 * Расстояния от заданных клеток по проходимой земле.
 *
 * Тот же `dijkstraField`, которым ходят юниты. Второго способа навигации
 * в игре нет и заводить его ради одной сущности незачем: это означало бы
 * второй набор граблей.
 */
export const walkField = (occupancy: Occupancy, seeds: readonly number[]): Int32Array => {
  const cost = new Int32Array(MAP_CELL_COUNT);

  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    cost[cell] = occupancy.blocked[cell] === 1 ? 0 : 1;
  }
  // Клетки-источники проходимы для поля: иначе оно не смогло бы
  // от них начаться. У базы, например, всё основание непроходимо.
  for (const seed of seeds) cost[seed] = 1;

  return dijkstraField(cost, seeds);
};

const baseSeeds = (cell: number): readonly number[] =>
  footprintCells(cell, STRUCTURE_STATS[StructureKind.Base].footprintRadius);

/** Клетки вокруг основания базы: единственные, до которых поле доходит. */
const ringAround = (cell: number): readonly number[] => {
  const radius = STRUCTURE_STATS[StructureKind.Base].footprintRadius + 1;
  const inside = new Set(baseSeeds(cell));

  return footprintCells(cell, radius).filter((entry) => !inside.has(entry));
};

/**
 * Запрёт ли постройка в этой клетке путь между базами.
 *
 * Проверка нужна потому, что запечатывание прохода — законный ход,
 * и ядро его не запрещает. Запечатать проход можно и СЕБЕ: своё войско
 * выходит из своей базы, и стена, закрывшая последнюю щель, останавливает
 * его так же надёжно, как чужое. Прецедент в проекте есть — генерал
 * однажды замуровывал сам себя в одной клетке.
 *
 * Считается ОДИН обход карты и только для уже выбранного места. Проверять
 * каждого кандидата значило бы сотни обходов за решение — цену, которую
 * не окупает ни одна башня.
 *
 * Ошибка проверки односторонняя и безопасная: она смотрит только
 * на проходимость и не знает, что стену можно сломать. Значит, изредка
 * она запретит постройку, которая на деле прошла бы, — и никогда
 * не пропустит ту, что действительно запирает.
 */
export const sealsApproach = (
  world: WorldState,
  me: PlayerId,
  approach: Approach,
  cell: number,
): boolean => {
  const homeCell = world.map.baseCells[me];
  const enemyCell = world.map.baseCells[otherPlayer(me)];
  if (homeCell === undefined || enemyCell === undefined) return false;

  const blocked = Uint8Array.from(approach.occupancy.blocked);
  blocked[cell] = 1;

  const field = walkField({ ...approach.occupancy, blocked }, baseSeeds(homeCell));

  // Достижимость меряется по КОЛЬЦУ вокруг чужой базы, а не по её клеткам.
  // Сами клетки базы непроходимы — их занимает сама база, — и поле
  // до них не доходит никогда. Проверка по ним всегда отвечала бы
  // «заперто», то есть запрещала бы вообще любую постройку.
  return !ringAround(enemyCell).some((cell) => (field[cell] ?? UNREACHABLE) !== UNREACHABLE);
};

export const approachOf = (world: WorldState, me: PlayerId): Approach | undefined => {
  const homeCell = world.map.baseCells[me];
  const enemyCell = world.map.baseCells[otherPlayer(me)];
  if (homeCell === undefined || enemyCell === undefined) return undefined;

  const occupancy = buildOccupancy(world.map, world.structures);
  const fromHome = walkField(occupancy, baseSeeds(homeCell));
  const fromEnemy = walkField(occupancy, baseSeeds(enemyCell));

  // Кратчайший маршрут ищется минимумом суммы, а не расстоянием до чужой
  // базы: клетки самой базы непроходимы, и поле до них не доходит.
  let shortest = UNREACHABLE;
  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    const home = fromHome[cell] ?? UNREACHABLE;
    const enemy = fromEnemy[cell] ?? UNREACHABLE;
    if (home === UNREACHABLE || enemy === UNREACHABLE) continue;

    const total = home + enemy;
    if (total < shortest) shortest = total;
  }

  if (shortest === UNREACHABLE) return undefined;

  const limit = shortest + PATH_SLACK_CELLS;
  const onPath = new Uint8Array(MAP_CELL_COUNT);

  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    if (occupancy.blocked[cell] === 1) continue;

    const home = fromHome[cell] ?? UNREACHABLE;
    const enemy = fromEnemy[cell] ?? UNREACHABLE;
    if (home === UNREACHABLE || enemy === UNREACHABLE) continue;

    if (home + enemy <= limit) onPath[cell] = 1;
  }

  return { onPath, fromHome, shortest, occupancy };
};
