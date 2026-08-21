import { SHOT_LIFETIME_TICKS, asTickNumber } from '@td/shared';
import type { AttackStance } from '@td/shared';
import type {
  CommandKind,
  EntityId,
  PlayerId,
  RejectReason,
  TickNumber,
  UnitType,
  Vec2,
} from '@td/shared';
import { StructureKind } from '@td/shared';
import { cellCentre } from './map.js';
import type { GameMap } from './map.js';
import { buildOccupancy } from './occupancy.js';
import type { Occupancy } from './occupancy.js';
import { buildSightGrid } from './sight.js';
import type { SightGrid } from './sight.js';
import type { RngState } from './prng.js';
import type {
  NavField,
  PlayerState,
  Rejection,
  ShotState,
  UpgradeState,
  WorldState,
} from './world.js';

/**
 * Изменяемая копия мира на время одного тика.
 *
 * Зачем она нужна. Шаг симуляции обязан быть чистой функцией: входное
 * состояние не мутируется. Но внутри одного тика мир меняется десятки
 * раз — приходит доход, применяются команды, двигаются юниты, наносится
 * урон. Пересобирать неизменяемые массивы на каждое такое изменение
 * значило бы создавать сотни промежуточных копий за тик.
 *
 * Поэтому в начале шага делается изменяемая копия, вся работа идёт по ней,
 * а в конце собирается новое неизменяемое состояние. Снаружи функция
 * остаётся чистой: входной объект не тронут, выходной — новый.
 *
 * Позиции здесь хранятся двумя числами вместо объекта Vec2. Причина
 * та же: юнитов сотни, и создавать им по объекту на каждое перемещение
 * каждый тик — заметная нагрузка на сборщик мусора.
 */

export interface WorkingPlayer {
  id: PlayerId;
  energy: number;
  upgrades: UpgradeState[];
  purchasePpm: number[];
  targetStructure: EntityId;
  stance: AttackStance;
  queue: UnitType[];
}

export interface WorkingStructure {
  id: EntityId;
  owner: PlayerId;
  kind: StructureKind;
  cell: number;
  health: number;
  growthPpm: number;
  readyAtTick: TickNumber;
  builtAtTick: TickNumber;
  demolishAtTick: TickNumber;
  alive: boolean;
}

export interface WorkingUnit {
  id: EntityId;
  owner: PlayerId;
  unitType: UnitType;
  x: number;
  y: number;
  health: number;
  /** Румб, в который повёрнута машина. Ноля здесь не бывает — см. UnitState. */
  facing: number;
  readyAtTick: TickNumber;
  alive: boolean;
  /**
   * Постройка, перегородившая юниту следующий шаг, либо -1.
   * Заполняется на этапе движения и используется на этапе стрельбы,
   * поэтому живёт только внутри тика и в состояние мира не попадает.
   */
  blockedBy: number;
}

export interface WorkingGeneral {
  owner: PlayerId;
  x: number;
  y: number;
  health: number;
  direction: number;
  /** Румб, в который развёрнута машина. Ноля не бывает — см. GeneralState. */
  facing: number;
  readyAtTick: TickNumber;
  alive: boolean;
  respawnAtTick: TickNumber;
}

export interface WorkingNuke {
  id: EntityId;
  owner: PlayerId;
  cell: number;
  detonateAtTick: TickNumber;
}

export interface Working {
  tick: TickNumber;
  rng: RngState;
  map: GameMap;
  players: WorkingPlayer[];
  structures: WorkingStructure[];
  units: WorkingUnit[];
  generals: WorkingGeneral[];
  nukes: WorkingNuke[];
  shots: ShotState[];
  /**
   * Отказы этого тика. Начинается пустым всегда — в отличие от следов
   * выстрелов, которые переезжают из прошлого состояния и доживают
   * свой срок. Накапливать отказы между тиками нельзя: показанный
   * дважды отказ выглядит как два разных.
   */
  rejections: Rejection[];
  nav: NavField[];
  navRevision: number;
  nextEntityId: number;
  winner: PlayerId | null;
  /** Сетка занятости. Перестраивается, когда набор построек изменился. */
  occupancy: Occupancy;
  /** Сетки непрозрачности для линии огня. Живут по тем же правилам. */
  sight: SightGrid;
  /**
   * Постройки погибли и сетку занятости пора пересобрать.
   *
   * Флаг, а не немедленная пересборка: за один тик может погибнуть
   * десяток построек, и обходить карту после каждой было бы расточительно.
   * Команды — другое дело, они видят результат друг друга и потому
   * пересобирают сетку сразу.
   */
  structuresDirty: boolean;
}

export const toWorking = (state: WorldState): Working => ({
  tick: asTickNumber(state.tick + 1),
  rng: state.rng,
  map: state.map,
  players: state.players.map((player) => ({
    id: player.id,
    energy: player.energy,
    upgrades: [...player.upgrades],
    purchasePpm: [...player.purchasePpm],
    targetStructure: player.targetStructure,
    stance: player.stance,
    queue: [...player.queue],
  })),
  structures: state.structures.map((structure) => ({
    id: structure.id,
    owner: structure.owner,
    kind: structure.kind,
    cell: structure.cell,
    health: structure.health,
    growthPpm: structure.growthPpm,
    readyAtTick: structure.readyAtTick,
    builtAtTick: structure.builtAtTick,
    demolishAtTick: structure.demolishAtTick,
    alive: true,
  })),
  units: state.units.map((unit) => ({
    id: unit.id,
    owner: unit.owner,
    unitType: unit.unitType,
    x: unit.position.x,
    y: unit.position.y,
    health: unit.health,
    facing: unit.facing,
    readyAtTick: unit.readyAtTick,
    alive: true,
    blockedBy: -1,
  })),
  generals: state.generals.map((general) => ({
    owner: general.owner,
    x: general.position.x,
    y: general.position.y,
    health: general.health,
    direction: general.direction,
    facing: general.facing,
    readyAtTick: general.readyAtTick,
    alive: general.alive,
    respawnAtTick: general.respawnAtTick,
  })),
  nukes: state.nukes.map((nuke) => ({ ...nuke })),
  shots: [...state.shots],
  rejections: [],
  nav: [...state.nav],
  navRevision: state.navRevision,
  nextEntityId: state.nextEntityId,
  winner: state.winner,
  occupancy: buildOccupancy(state.map, state.structures),
  sight: buildSightGrid(state.map, state.structures),
  structuresDirty: false,
});

/**
 * Пересборка сеток, производных от набора построек: занятости и
 * непрозрачности.
 *
 * Вызывается после любого изменения набора построек: постройки,
 * разрушения, ядерного удара. Стоит два обхода карты — дешевле, чем
 * поддерживать сетки инкрементально и аккуратно откатывать.
 */
export const refreshOccupancy = (working: Working): void => {
  const alive = working.structures.filter((structure) => structure.alive);

  working.occupancy = buildOccupancy(working.map, alive);
  working.sight = buildSightGrid(working.map, alive);
};

/**
 * Отметить, что поля потока устарели.
 *
 * Причин ровно две: изменился набор построек или сменилась цель.
 * Всё остальное на путь не влияет — юниты друг другу не мешают.
 */
export const invalidateNavigation = (working: Working): void => {
  working.navRevision += 1;
};

export const position = (entity: { x: number; y: number }): Vec2 => ({ x: entity.x, y: entity.y });

export const structurePosition = (structure: WorkingStructure): Vec2 => cellCentre(structure.cell);

/**
 * Записать отказ.
 *
 * Единственный способ сообщить о непринятой команде. Отдельная функция,
 * а не `push` по месту, — чтобы точку записи было видно поиском: правило
 * «одна проверка, одна причина» проверяется глазами по списку вызовов.
 */
export const recordRejection = (
  working: Working,
  player: PlayerId,
  kind: CommandKind,
  reason: RejectReason,
  index: number,
): void => {
  working.rejections.push({ player, kind, reason, index });
};

export const recordShot = (
  working: Working,
  owner: PlayerId,
  from: Vec2,
  to: Vec2,
  lethal: boolean,
): void => {
  working.shots.push({
    owner,
    from,
    to,
    expiresAtTick: asTickNumber(working.tick + SHOT_LIFETIME_TICKS),
    lethal,
  });
};

const toPlayerState = (player: WorkingPlayer): PlayerState => ({
  id: player.id,
  energy: player.energy,
  upgrades: player.upgrades,
  purchasePpm: player.purchasePpm,
  targetStructure: player.targetStructure,
  stance: player.stance,
  queue: player.queue,
});

/**
 * Сборка неизменяемого состояния из рабочей копии.
 *
 * Здесь же отсеиваются погибшие: до этого момента они остаются в массивах,
 * потому что индексы сущностей используются как ссылки в пределах тика,
 * и удаление элемента посреди тика сдвинуло бы все последующие индексы.
 */
export const fromWorking = (working: Working): WorldState => ({
  tick: working.tick,
  rng: working.rng,
  map: working.map,
  players: working.players.map(toPlayerState),
  structures: working.structures
    .filter((structure) => structure.alive)
    .map((structure) => ({
      id: structure.id,
      owner: structure.owner,
      kind: structure.kind,
      cell: structure.cell,
      health: structure.health,
      growthPpm: structure.growthPpm,
      readyAtTick: structure.readyAtTick,
      builtAtTick: structure.builtAtTick,
      demolishAtTick: structure.demolishAtTick,
    })),
  units: working.units
    .filter((unit) => unit.alive)
    .map((unit) => ({
      id: unit.id,
      owner: unit.owner,
      unitType: unit.unitType,
      position: { x: unit.x, y: unit.y },
      health: unit.health,
      facing: unit.facing,
      readyAtTick: unit.readyAtTick,
    })),
  generals: working.generals.map((general) => ({
    owner: general.owner,
    position: { x: general.x, y: general.y },
    health: general.health,
    direction: general.direction,
    facing: general.facing,
    readyAtTick: general.readyAtTick,
    alive: general.alive,
    respawnAtTick: general.respawnAtTick,
  })),
  nukes: working.nukes.map((nuke) => ({ ...nuke })),
  shots: working.shots.filter((shot) => shot.expiresAtTick > working.tick),
  rejections: working.rejections,
  nav: working.nav,
  navRevision: working.navRevision,
  nextEntityId: working.nextEntityId,
  winner: working.winner,
});

/** Постройка игрока по идентификатору. Нужна для поиска цели и базы. */
export const findStructure = (
  structures: readonly WorkingStructure[],
  id: EntityId,
): WorkingStructure | undefined =>
  structures.find((structure) => structure.alive && structure.id === id);

export const findBase = (
  structures: readonly WorkingStructure[],
  owner: PlayerId,
): WorkingStructure | undefined =>
  structures.find(
    (structure) =>
      structure.alive && structure.owner === owner && structure.kind === StructureKind.Base,
  );
