import {
  DIRECTION_STOP,
  FIXED_POINT_SCALE,
  GENERAL_KILL_REWARD,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  STRUCTURE_STATS,
  StructureKind,
  TOWER_GROWTH_CAP_PPM,
  TOWER_KILL_GROWTH_PERCENT,
  UNIT_STATS,
  asTickNumber,
  clampPpm,
  directionTowards,
  growPpm,
} from '@td/shared';
import type { PlayerId, Vec2 } from '@td/shared';
import { cellAt, cellCentre, squaredDistanceToFootprint } from './map.js';
import { hasLineOfSight } from './sight.js';
import { statsOf, structureAttack, structureMaxHealth } from './stats.js';
import type { PlayerStats } from './stats.js';
import { recordShot } from './working.js';
import type { Working, WorkingGeneral, WorkingStructure, WorkingUnit } from './working.js';

/**
 * Бой.
 *
 * Попадание мгновенное: снаряда в полёте не существует. Альтернатива
 * со снарядами добавила бы сущностей больше, чем самих юнитов — при двухстах
 * стреляющих и секундной перезарядке в воздухе висели бы сотни снарядов, —
 * а взамен принесла бы только промахи по движущейся цели. Промахи в игре
 * с полной информацией и без укрытий это шум, а не тактика.
 */

export const TargetKind = {
  Unit: 0,
  Structure: 1,
  General: 2,
} as const;

export type TargetKind = (typeof TargetKind)[keyof typeof TargetKind];

export interface Target {
  readonly kind: TargetKind;
  /** Индекс в соответствующем массиве рабочего состояния. */
  readonly index: number;
}

/** Кто стреляет. От этого зависят награды и рост силы. */
export const ShooterKind = {
  Unit: 0,
  Structure: 1,
  General: 2,
} as const;

export type ShooterKind = (typeof ShooterKind)[keyof typeof ShooterKind];

// ─────────────────────────────────────────────────────────────────────────
// Пространственный индекс
// ─────────────────────────────────────────────────────────────────────────

/**
 * Размер корзины индекса в клетках.
 *
 * Перебирать всех врагов для каждого стрелка — это двести на двести
 * сравнений за тик только среди юнитов, шесть миллионов проверок
 * расстояния в секунду. Корзины сводят перебор к соседям.
 *
 * Восемь клеток выбраны под самую большую дальность в игре (десять клеток
 * у снайперской башни): при таком размере запрос покрывается сеткой
 * три на три корзины, а сама сетка остаётся маленькой — 12 × 12.
 */
const BUCKET_CELLS = 8;
const BUCKET_UNITS = BUCKET_CELLS * FIXED_POINT_SCALE;
const BUCKET_COLS = Math.ceil(MAP_WIDTH_CELLS / BUCKET_CELLS);
const BUCKET_ROWS = Math.ceil(MAP_HEIGHT_CELLS / BUCKET_CELLS);

export interface SpatialIndex {
  readonly buckets: readonly number[][];
}

const bucketOf = (x: number, y: number): number => {
  const column = Math.min(BUCKET_COLS - 1, Math.max(0, Math.floor(x / BUCKET_UNITS)));
  const row = Math.min(BUCKET_ROWS - 1, Math.max(0, Math.floor(y / BUCKET_UNITS)));
  return row * BUCKET_COLS + column;
};

export const buildSpatialIndex = (
  count: number,
  positionAt: (index: number) => Vec2 | undefined,
): SpatialIndex => {
  const buckets: number[][] = Array.from({ length: BUCKET_COLS * BUCKET_ROWS }, () => []);

  for (let index = 0; index < count; index += 1) {
    const point = positionAt(index);
    if (point === undefined) continue;

    buckets[bucketOf(point.x, point.y)]?.push(index);
  }

  return { buckets };
};

const forEachNear = (
  index: SpatialIndex,
  centre: Vec2,
  radius: number,
  visit: (item: number) => void,
): void => {
  const minColumn = Math.max(0, Math.floor((centre.x - radius) / BUCKET_UNITS));
  const maxColumn = Math.min(BUCKET_COLS - 1, Math.floor((centre.x + radius) / BUCKET_UNITS));
  const minRow = Math.max(0, Math.floor((centre.y - radius) / BUCKET_UNITS));
  const maxRow = Math.min(BUCKET_ROWS - 1, Math.floor((centre.y + radius) / BUCKET_UNITS));

  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const bucket = index.buckets[row * BUCKET_COLS + column];
      if (bucket === undefined) continue;

      for (const item of bucket) visit(item);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Выбор цели
// ─────────────────────────────────────────────────────────────────────────

export interface CombatIndices {
  readonly units: SpatialIndex;
  readonly structures: SpatialIndex;
}

export const buildCombatIndices = (working: Working): CombatIndices => ({
  units: buildSpatialIndex(working.units.length, (index) => {
    const unit = working.units[index];
    return unit === undefined || !unit.alive ? undefined : { x: unit.x, y: unit.y };
  }),
  structures: buildSpatialIndex(working.structures.length, (index) => {
    const structure = working.structures[index];
    return structure === undefined || !structure.alive ? undefined : cellCentre(structure.cell);
  }),
});

const squaredDistance = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

/**
 * Расстояние до постройки — до её основания, а не до центра.
 *
 * Юниты и генералы остаются точками, постройки занимают площадь. Разница
 * решающая для базы: её основание три на три, и мерка до центра означала бы,
 * что до базы нельзя дострелить, стоя к ней вплотную.
 */
const structureDistance = (from: Vec2, structure: WorkingStructure): number =>
  squaredDistanceToFootprint(from, structure.cell, STRUCTURE_STATS[structure.kind].footprintRadius);

/** Самое крупное основание среди построек, во внутренних единицах. */
const LARGEST_FOOTPRINT =
  (STRUCTURE_STATS[StructureKind.Base].footprintRadius + 1) * FIXED_POINT_SCALE;

interface Candidate {
  target: Target | undefined;
  distance: number;
  /** Идентификатор цели. Разрешает ничьи при равном расстоянии. */
  id: number;
}

const consider = (best: Candidate, target: Target, distance: number, id: number): void => {
  if (best.target !== undefined) {
    if (distance > best.distance) return;
    // Ничья по расстоянию разрешается меньшим идентификатором. Правило
    // нужно не игроку, а детерминизму: без него исход зависел бы
    // от порядка элементов в массиве.
    if (distance === best.distance && id >= best.id) return;
  }

  best.target = target;
  best.distance = distance;
  best.id = id;
};

/** Видно ли точку из точки. Обёртка вокруг линии огня для живых целей. */
const seesPoint = (working: Working, elevated: boolean, origin: Vec2, point: Vec2): boolean =>
  hasLineOfSight(working.sight, elevated, origin, point, cellAt(point), 0);

/** Видно ли постройку. Всё её основание для линии огня прозрачно. */
export const seesStructure = (
  working: Working,
  elevated: boolean,
  origin: Vec2,
  structure: WorkingStructure,
): boolean =>
  hasLineOfSight(
    working.sight,
    elevated,
    origin,
    cellCentre(structure.cell),
    structure.cell,
    STRUCTURE_STATS[structure.kind].footprintRadius,
  );

/** Ближайший видимый вражеский генерал. Ничья — по меньшему индексу. */
const nearestGeneral = (
  working: Working,
  owner: PlayerId,
  origin: Vec2,
  reach: number,
  elevated: boolean,
): Target | undefined => {
  const best: Candidate = { target: undefined, distance: Number.POSITIVE_INFINITY, id: 0 };

  working.generals.forEach((general, index) => {
    if (!general.alive || general.owner === owner) return;

    const point = { x: general.x, y: general.y };
    const distance = squaredDistance(origin, point);
    if (distance > reach) return;
    // Проверка линии дороже проверки расстояния, поэтому кандидата,
    // заведомо худшего текущего, отсеиваем до неё.
    if (best.target !== undefined && distance > best.distance) return;
    if (!seesPoint(working, elevated, origin, point)) return;

    consider(best, { kind: TargetKind.General, index }, distance, index);
  });

  return best.target;
};

/** Ближайший видимый вражеский юнит. */
const nearestUnit = (
  working: Working,
  indices: CombatIndices,
  owner: PlayerId,
  origin: Vec2,
  range: number,
  reach: number,
  elevated: boolean,
): Target | undefined => {
  const best: Candidate = { target: undefined, distance: Number.POSITIVE_INFINITY, id: 0 };

  forEachNear(indices.units, origin, range, (index) => {
    const unit = working.units[index];
    if (unit === undefined || !unit.alive || unit.owner === owner) return;

    const distance = squaredDistance(origin, { x: unit.x, y: unit.y });
    if (distance > reach) return;
    if (best.target !== undefined && distance > best.distance) return;
    if (!seesPoint(working, elevated, origin, { x: unit.x, y: unit.y })) return;

    consider(best, { kind: TargetKind.Unit, index }, distance, unit.id);
  });

  return best.target;
};

/** Ближайшая видимая вражеская постройка. */
const nearestStructure = (
  working: Working,
  indices: CombatIndices,
  owner: PlayerId,
  origin: Vec2,
  range: number,
  reach: number,
  elevated: boolean,
): Target | undefined => {
  const best: Candidate = { target: undefined, distance: Number.POSITIVE_INFINITY, id: 0 };

  // Радиус поиска расширен на размер самого крупного основания.
  // Корзины индексируют постройку по её центру, а стреляем мы по краю:
  // база с основанием три на три попадала бы в соседнюю корзину и просто
  // не находилась бы среди кандидатов.
  forEachNear(indices.structures, origin, range + LARGEST_FOOTPRINT, (index) => {
    const structure = working.structures[index];
    if (structure === undefined || !structure.alive || structure.owner === owner) return;

    const distance = structureDistance(origin, structure);
    if (distance > reach) return;
    if (best.target !== undefined && distance > best.distance) return;
    if (!seesStructure(working, elevated, origin, structure)) return;

    consider(best, { kind: TargetKind.Structure, index }, distance, structure.id);
  });

  return best.target;
};

/**
 * Выбор цели по приоритету:
 *   1) назначенная общая цель игрока;
 *   2) вражеский генерал;
 *   3) постройка, перегородившая путь;
 *   4) вражеский юнит;
 *   5) любая вражеская постройка.
 *
 * Ступени перебираются сверху вниз, и первая, на которой нашлась цель
 * в радиусе и на линии огня, останавливает перебор. Внутри ступени
 * выбирается ближайшая цель, ничья разрешается меньшим идентификатором:
 * без этого исход зависел бы от порядка элементов в массиве.
 *
 * Почему генерал выше юнитов. Раньше он участвовал в общем конкурсе
 * наравне с ними и выигрывал, только будучи строго ближе любого юнита
 * в радиусе. А ходит он там, где идёт бой, то есть в окружении своей
 * пехоты, — и кто-нибудь из неё почти всегда оказывался ближе. В итоге
 * по генералу не стреляли вовсе: механика «хочешь укрепить позицию —
 * приди туда лично и подставься» не работала, а награда за убийство
 * вражеского генерала не выплачивалась никогда.
 *
 * Почему генерал выше преграды. Стена никуда не денется и через секунду
 * будет там же, а генерал уйдёт. К тому же за него дают двадцать
 * стоимостей штурмовика, а стена столько не стоит.
 *
 * Почему назначенная цель всё-таки выше генерала. Это единственный
 * прямой приказ игрока в выборе цели, и автоматика перебивать его
 * не должна.
 *
 * На каждой ступени цель обязана быть видимой: расстояния мало, нужна
 * ещё и свободная линия. Проверка стоит обхода нескольких клеток
 * и делается последней — после отсева по расстоянию, который куда дешевле.
 */
export const chooseTarget = (
  working: Working,
  indices: CombatIndices,
  owner: PlayerId,
  origin: Vec2,
  range: number,
  globalTargetIndex: number,
  blockedBy: number,
  /** Стрелок выше стен: башня или база. Юнит и генерал — нет. */
  elevated: boolean,
): Target | undefined => {
  if (range <= 0) return undefined;

  const reach = range * range;

  const structureInReach = (index: number): boolean => {
    const structure = working.structures[index];
    if (structure === undefined || !structure.alive || structure.owner === owner) return false;
    if (structureDistance(origin, structure) > reach) return false;

    return seesStructure(working, elevated, origin, structure);
  };

  if (globalTargetIndex >= 0 && structureInReach(globalTargetIndex)) {
    return { kind: TargetKind.Structure, index: globalTargetIndex };
  }

  const general = nearestGeneral(working, owner, origin, reach, elevated);
  if (general !== undefined) return general;

  if (blockedBy >= 0 && structureInReach(blockedBy)) {
    return { kind: TargetKind.Structure, index: blockedBy };
  }

  return (
    nearestUnit(working, indices, owner, origin, range, reach, elevated) ??
    nearestStructure(working, indices, owner, origin, range, reach, elevated)
  );
};

/**
 * Есть ли в радиусе живой противник, по которому можно стрелять.
 *
 * Нужен движению: юнит останавливается, встретив противника, но только
 * такого, до которого дострелит. Без проверки линии юнит замирал бы перед
 * стеной, за которой стоит недосягаемый враг, и стоял бы там до конца
 * матча.
 *
 * Индекс сюда передаётся построенный ДО движения — по положениям
 * на начало тика. Иначе ответ зависел бы от того, кто в массиве юнитов
 * идёт раньше, а от порядка перебора в детерминированном ядре зависеть
 * не должно ничего.
 */
export const hasHostileInSight = (
  working: Working,
  units: SpatialIndex,
  owner: PlayerId,
  origin: Vec2,
  range: number,
): boolean => {
  if (range <= 0) return false;

  const reach = range * range;
  let found = false;

  forEachNear(units, origin, range, (index) => {
    if (found) return;

    const unit = working.units[index];
    if (unit === undefined || !unit.alive || unit.owner === owner) return;
    if (squaredDistance(origin, { x: unit.x, y: unit.y }) > reach) return;
    if (!seesPoint(working, false, origin, { x: unit.x, y: unit.y })) return;

    found = true;
  });

  if (found) return true;

  for (const general of working.generals) {
    if (!general.alive || general.owner === owner) continue;
    if (squaredDistance(origin, { x: general.x, y: general.y }) > reach) continue;
    if (!seesPoint(working, false, origin, { x: general.x, y: general.y })) continue;

    return true;
  }

  return false;
};

// ─────────────────────────────────────────────────────────────────────────
// Урон
// ─────────────────────────────────────────────────────────────────────────

export const targetPosition = (working: Working, target: Target): Vec2 | undefined => {
  switch (target.kind) {
    case TargetKind.Unit: {
      const unit = working.units[target.index];
      return unit === undefined ? undefined : { x: unit.x, y: unit.y };
    }
    case TargetKind.Structure: {
      const structure = working.structures[target.index];
      return structure === undefined ? undefined : cellCentre(structure.cell);
    }
    case TargetKind.General: {
      const general = working.generals[target.index];
      return general === undefined ? undefined : { x: general.x, y: general.y };
    }
  }
};

/** Базовая стоимость убитого — она же награда генералу за убийство. */
const bounty = (working: Working, target: Target): number => {
  switch (target.kind) {
    case TargetKind.Unit: {
      const unit = working.units[target.index];
      return unit === undefined ? 0 : UNIT_STATS[unit.unitType].cost;
    }
    case TargetKind.Structure: {
      const structure = working.structures[target.index];
      return structure === undefined ? 0 : STRUCTURE_STATS[structure.kind].cost;
    }
    case TargetKind.General:
      return GENERAL_KILL_REWARD;
  }
};

/**
 * Усиление башни за убийство: +5 процентов к атаке и прочности
 * сложным процентом.
 *
 * Прочность растёт и в максимуме, и в текущем значении на ту же величину —
 * иначе награда оборачивалась бы для башни понижением доли здоровья.
 */
const rewardTower = (structure: WorkingStructure, stats: PlayerStats): void => {
  if (structure.kind === StructureKind.Base || structure.kind === StructureKind.Wall) return;

  const baseline = stats.structures[structure.kind];
  const before = structureMaxHealth(baseline, structure.growthPpm);

  structure.growthPpm = clampPpm(
    growPpm(structure.growthPpm, TOWER_KILL_GROWTH_PERCENT),
    TOWER_GROWTH_CAP_PPM,
  );

  structure.health += structureMaxHealth(baseline, structure.growthPpm) - before;
};

export interface Shooter {
  readonly kind: ShooterKind;
  readonly index: number;
  readonly owner: PlayerId;
}

/**
 * Нанесение урона и всё, что за ним следует: гибель цели, награда генералу,
 * усиление башни.
 *
 * Возвращает признак того, что цель погибла — вызывающему коду это нужно
 * для следа выстрела: добивающий выстрел рисуется ярче.
 */
export const dealDamage = (
  working: Working,
  statsTable: readonly PlayerStats[],
  shooter: Shooter,
  target: Target,
  amount: number,
): boolean => {
  if (amount <= 0) return false;

  const killed = subtractHealth(working, statsTable, target, amount);
  if (!killed) return false;

  if (shooter.kind === ShooterKind.General) {
    // Награда за убийство даётся только генералу — это плата за то,
    // что игрок рискнул им лично.
    const player = working.players.find((entry) => entry.id === shooter.owner);
    if (player !== undefined) player.energy += bounty(working, target);
  }

  if (shooter.kind === ShooterKind.Structure) {
    const structure = working.structures[shooter.index];
    if (structure !== undefined) rewardTower(structure, statsOf(statsTable, shooter.owner));
  }

  return true;
};

const subtractHealth = (
  working: Working,
  statsTable: readonly PlayerStats[],
  target: Target,
  amount: number,
): boolean => {
  switch (target.kind) {
    case TargetKind.Unit: {
      const unit = working.units[target.index];
      if (unit === undefined || !unit.alive) return false;

      unit.health -= amount;
      if (unit.health > 0) return false;

      unit.alive = false;
      return true;
    }
    case TargetKind.Structure: {
      const structure = working.structures[target.index];
      if (structure === undefined || !structure.alive) return false;

      structure.health -= amount;
      if (structure.health > 0) return false;

      structure.alive = false;
      working.structuresDirty = true;
      return true;
    }
    case TargetKind.General: {
      const general = working.generals[target.index];
      if (!general?.alive) return false;

      general.health -= amount;
      if (general.health > 0) return false;

      killGeneral(working, statsTable, general);
      return true;
    }
  }
};

/**
 * Гибель генерала.
 *
 * Смерть не окончательна: наказание — потерянная позиция и время,
 * а не проигрыш. Время возрождения берётся из прокачки владельца.
 */
export const killGeneral = (
  working: Working,
  statsTable: readonly PlayerStats[],
  general: WorkingGeneral,
): void => {
  general.alive = false;
  general.health = 0;
  general.direction = 0;
  general.respawnAtTick = asTickNumber(
    working.tick + statsOf(statsTable, general.owner).general.respawnTicks,
  );
};

// ─────────────────────────────────────────────────────────────────────────
// Один тик стрельбы
// ─────────────────────────────────────────────────────────────────────────

const damageAgainst = (
  working: Working,
  target: Target,
  attack: number,
  structureDamagePercent: number,
): number => {
  if (target.kind !== TargetKind.Structure) return attack;

  // Урон по постройкам может отличаться от урона по живым: снайпер бьёт
  // по ним в десятую силу, и это то, что делает его противопехотным.
  return Math.max(1, Math.floor((attack * structureDamagePercent) / 100));
};

const fire = (
  working: Working,
  statsTable: readonly PlayerStats[],
  shooter: Shooter,
  origin: Vec2,
  target: Target,
  attack: number,
  structureDamagePercent: number,
): void => {
  const aim = targetPosition(working, target);
  if (aim === undefined) return;

  const lethal = dealDamage(
    working,
    statsTable,
    shooter,
    target,
    damageAgainst(working, target, attack, structureDamagePercent),
  );

  recordShot(working, shooter.owner, origin, aim, lethal);
};

const globalTargetIndexOf = (working: Working, owner: PlayerId): number => {
  const player = working.players.find((entry) => entry.id === owner);
  if (player === undefined) return -1;

  return working.structures.findIndex(
    (structure) => structure.alive && structure.id === player.targetStructure,
  );
};

/**
 * Стрельба всех, кто может стрелять, за один тик.
 *
 * Порядок фиксирован: сначала постройки, затем юниты, затем генералы.
 * Порядок влияет на исход — кто выстрелил первым, тот может добить цель
 * раньше, — поэтому менять его нельзя без обновления эталона детерминизма.
 */
export const resolveCombat = (
  working: Working,
  statsTable: readonly PlayerStats[],
  indices: CombatIndices,
): void => {
  const globalTargets = working.players.map((player) => globalTargetIndexOf(working, player.id));
  const targetFor = (owner: PlayerId): number =>
    globalTargets[working.players.findIndex((player) => player.id === owner)] ?? -1;

  working.structures.forEach((structure, index) => {
    fireStructure(working, statsTable, indices, structure, index, targetFor(structure.owner));
  });

  working.units.forEach((unit, index) => {
    fireUnit(working, statsTable, indices, unit, index, targetFor(unit.owner));
  });

  working.generals.forEach((general, index) => {
    fireGeneral(working, statsTable, indices, general, index, targetFor(general.owner));
  });
};

const fireStructure = (
  working: Working,
  statsTable: readonly PlayerStats[],
  indices: CombatIndices,
  structure: WorkingStructure,
  index: number,
  globalTarget: number,
): void => {
  if (!structure.alive) return;
  // Недостроенная постройка не стреляет: она уже мешает пройти,
  // но воевать ещё не умеет.
  if (working.tick < structure.builtAtTick) return;
  if (working.tick < structure.readyAtTick) return;

  const baseline = statsOf(statsTable, structure.owner).structures[structure.kind];
  const attack = structureAttack(baseline, structure.growthPpm);
  if (attack <= 0 || baseline.range <= 0) return;

  const origin = cellCentre(structure.cell);
  const target = chooseTarget(
    working,
    indices,
    structure.owner,
    origin,
    baseline.range,
    globalTarget,
    -1,
    // Башня и база выше стены и стреляют поверх неё. Именно это делает
    // стену перед башней укреплением, а не просто занятой клеткой.
    true,
  );
  if (target === undefined) return;

  structure.readyAtTick = asTickNumber(working.tick + baseline.cooldownTicks);
  fire(
    working,
    statsTable,
    { kind: ShooterKind.Structure, index, owner: structure.owner },
    origin,
    target,
    attack,
    100,
  );
};

/**
 * Разворот стрелка на цель.
 *
 * Стрельба идёт после движения, поэтому этот разворот перебивает разворот
 * по ходу шага — и это правильный порядок: доехавший до врага и открывший
 * огонь смотрит на врага, а не на последнюю точку маршрута.
 *
 * На исход выстрела не влияет никак: разворот мгновенный, стрелять можно
 * в любую сторону. Это облик, а не механика.
 */
const aimFacing = (
  working: Working,
  target: Target,
  fromX: number,
  fromY: number,
  current: number,
): number => {
  const aim = targetPosition(working, target);
  if (aim === undefined) return current;

  const heading = directionTowards(aim.x - fromX, aim.y - fromY);
  return heading === DIRECTION_STOP ? current : heading;
};

const fireUnit = (
  working: Working,
  statsTable: readonly PlayerStats[],
  indices: CombatIndices,
  unit: WorkingUnit,
  index: number,
  globalTarget: number,
): void => {
  if (!unit.alive) return;
  if (working.tick < unit.readyAtTick) return;

  const baseline = statsOf(statsTable, unit.owner).units[unit.unitType];
  const origin = { x: unit.x, y: unit.y };

  const target = chooseTarget(
    working,
    indices,
    unit.owner,
    origin,
    baseline.range,
    globalTarget,
    unit.blockedBy,
    false,
  );
  if (target === undefined) return;

  unit.facing = aimFacing(working, target, unit.x, unit.y, unit.facing);
  unit.readyAtTick = asTickNumber(working.tick + baseline.cooldownTicks);
  fire(
    working,
    statsTable,
    { kind: ShooterKind.Unit, index, owner: unit.owner },
    origin,
    target,
    baseline.attack,
    baseline.structureDamagePercent,
  );
};

const fireGeneral = (
  working: Working,
  statsTable: readonly PlayerStats[],
  indices: CombatIndices,
  general: WorkingGeneral,
  index: number,
  globalTarget: number,
): void => {
  if (!general.alive) return;
  if (working.tick < general.readyAtTick) return;

  const baseline = statsOf(statsTable, general.owner).general;
  const origin = { x: general.x, y: general.y };

  const target = chooseTarget(
    working,
    indices,
    general.owner,
    origin,
    baseline.range,
    globalTarget,
    -1,
    false,
  );
  if (target === undefined) return;

  general.facing = aimFacing(working, target, general.x, general.y, general.facing);
  general.readyAtTick = asTickNumber(working.tick + baseline.cooldownTicks);
  fire(
    working,
    statsTable,
    { kind: ShooterKind.General, index, owner: general.owner },
    origin,
    target,
    baseline.attack,
    baseline.structureDamagePercent,
  );
};
