import {
  BUILDABLE_KINDS,
  CommandKind,
  INFLATES_PURCHASE,
  MAP_CELL_COUNT,
  NUKE_BASE_EXCLUSION,
  NUKE_COST,
  NUKE_DELAY_TICKS,
  PPM_ONE,
  PRODUCTION_QUEUE_CAP,
  PURCHASE_INFLATION_PERCENT,
  STRUCTURE_UPGRADE_TARGET,
  StructureKind,
  Terrain,
  UNIT_STATS,
  UNIT_UPGRADE_TARGET,
  UPGRADE_BRANCHES,
  UpgradeStat,
  UpgradeTarget,
  asEntityId,
  asTickNumber,
  distanceSquared,
  growPpm,
  isValidDirection,
} from '@td/shared';
import type { Command, PlayerId, UnitType } from '@td/shared';
import { cellCentre } from './map.js';
import { NO_STRUCTURE } from './occupancy.js';
import { playerStats, structureMaxHealth, upgradeCostOf } from './stats.js';
import type { PlayerStats } from './stats.js';
import { invalidateNavigation, refreshOccupancy } from './working.js';
import type { Working, WorkingPlayer } from './working.js';

/**
 * Применение команд.
 *
 * Каждая команда проверяется целиком до того, как что-либо изменится.
 * Правило простое: команда либо применяется полностью, либо не применяется
 * вовсе. Половинчатое применение — списали энергию, но не поставили
 * башню — это ошибка, которую игрок не сможет ни понять, ни исправить.
 *
 * Проверки опираются только на состояние мира. Благодаря этому клиент
 * и сервер, получив одну и ту же команду, приходят к одному и тому же
 * решению, и предсказание на клиенте не расходится с сервером.
 *
 * Отказ происходит молча: недопустимая команда — штатная ситуация,
 * а не аварийная. Она приходит от игрока, который нажал не туда,
 * или от устаревшего клиента, и валить из-за неё матч незачем.
 */

/** Доля здоровья, с которой постройка появляется на карте. */
const BUILD_START_HEALTH_PERCENT = 20;

const playerOf = (working: Working, id: PlayerId): WorkingPlayer | undefined =>
  working.players.find((player) => player.id === id);

const isValidCell = (cell: number): boolean =>
  Number.isInteger(cell) && cell >= 0 && cell < MAP_CELL_COUNT;

export const applyCommand = (working: Working, command: Command): void => {
  // После победы мир замирает: доигрывать нечего, а команды опоздавших
  // пакетов не должны менять итог матча.
  if (working.winner !== null) return;

  const player = playerOf(working, command.player);
  if (player === undefined) return;

  switch (command.kind) {
    case CommandKind.MoveGeneral:
      moveGeneral(working, player, command.direction);
      return;
    case CommandKind.Build:
      build(working, player, command.cell, command.structure);
      return;
    case CommandKind.TrainUnit:
      trainUnit(working, player, command.unitType);
      return;
    case CommandKind.SetTarget:
      setTarget(working, player, command.cell);
      return;
    case CommandKind.BuyUpgrade:
      buyUpgrade(working, player, command.branch);
      return;
    case CommandKind.LaunchNuke:
      launchNuke(working, player, command.cell);
      return;
  }
};

const moveGeneral = (working: Working, player: WorkingPlayer, direction: number): void => {
  if (!isValidDirection(direction)) return;

  const general = working.generals.find((entry) => entry.owner === player.id);
  if (general === undefined || !general.alive) return;

  general.direction = direction;
};

const build = (
  working: Working,
  player: WorkingPlayer,
  cell: number,
  kind: StructureKind,
): void => {
  if (!isValidCell(cell)) return;
  if (!BUILDABLE_KINDS.includes(kind)) return;

  // Клетка должна быть свободна и по рельефу, и по постройкам.
  if (working.map.cells[cell] !== Terrain.Ground) return;
  if (working.occupancy.blocked[cell] === 1) return;

  const general = working.generals.find((entry) => entry.owner === player.id);
  if (general === undefined || !general.alive) return;

  const stats = playerStats(player);
  const centre = cellCentre(cell);
  const radius = stats.general.buildRadius;

  // Центральная механика: строить можно только вокруг себя. Чтобы укрепить
  // позицию, надо физически туда прийти и там находиться под ударом.
  if (distanceSquared(centre, { x: general.x, y: general.y }) > radius * radius) return;

  const baseline = stats.structures[kind];
  if (player.energy < baseline.cost) return;

  player.energy -= baseline.cost;

  const maxHealth = baseline.health;

  working.structures.push({
    id: asEntityId(working.nextEntityId),
    owner: player.id,
    kind,
    cell,
    // Постройка появляется недостроенной и потому уязвимой: она уже
    // перекрывает проход, но развалить её пока легко.
    health: Math.max(1, Math.floor((maxHealth * BUILD_START_HEALTH_PERCENT) / 100)),
    growthPpm: PPM_ONE,
    readyAtTick: asTickNumber(working.tick + baseline.buildTicks),
    builtAtTick: asTickNumber(working.tick + baseline.buildTicks),
    alive: true,
  });

  working.nextEntityId += 1;

  refreshOccupancy(working);
  invalidateNavigation(working);
};

const trainUnit = (working: Working, player: WorkingPlayer, unitType: UnitType): void => {
  if (UNIT_STATS[unitType] === undefined) return;
  if (player.queue.length >= PRODUCTION_QUEUE_CAP) return;

  const stats = playerStats(player);
  const cost = stats.units[unitType].cost;
  if (player.energy < cost) return;

  // Энергия списывается в момент заказа, а не в момент появления юнита.
  // Иначе очередь стала бы бесплатным резервированием: можно было бы
  // заказать двадцать юнитов, не имея на них энергии.
  player.energy -= cost;
  player.queue.push(unitType);
};

const setTarget = (working: Working, player: WorkingPlayer, cell: number): void => {
  if (!isValidCell(cell)) return;

  const index = working.occupancy.structureAt[cell] ?? NO_STRUCTURE;
  if (index === NO_STRUCTURE) return;

  const structure = working.structures[index];
  if (structure === undefined || !structure.alive) return;

  // Целью может быть только чужая постройка: приказ бить по своим —
  // почти наверняка промах мимо клетки, а не замысел.
  if (structure.owner === player.id) return;
  if (player.targetStructure === structure.id) return;

  player.targetStructure = structure.id;
  invalidateNavigation(working);
};

const buyUpgrade = (working: Working, player: WorkingPlayer, branchIndex: number): void => {
  const branch = UPGRADE_BRANCHES[branchIndex];
  if (branch === undefined) return;

  const current = player.upgrades[branchIndex];
  if (current === undefined) return;

  const cost = upgradeCostOf(branchIndex, current);
  if (player.energy < cost) return;

  const before = playerStats(player);

  player.energy -= cost;
  player.upgrades[branchIndex] = {
    level: current.level + 1,
    effectPpm: growPpm(current.effectPpm, branch.effectPercent),
    costPpm: growPpm(current.costPpm, branch.costGrowthPercent),
  };

  // Улучшение типа поднимает цену покупки этого типа. У генерала
  // и экономики покупать нечего, поэтому их улучшения цен не двигают.
  if (INFLATES_PURCHASE[branch.target]) {
    const inflated = growPpm(
      player.purchasePpm[branch.target] ?? 1_000_000,
      PURCHASE_INFLATION_PERCENT,
    );
    player.purchasePpm[branch.target] = inflated;
  }

  if (branch.stat === UpgradeStat.Health) {
    healToNewMaximum(working, player, branch.target, before, playerStats(player));
  }
};

/**
 * Прибавка здоровья живым объектам после покупки прочности.
 *
 * Характеристики выводятся из прокачки, поэтому максимум вырастает сам
 * собой. А вот текущее здоровье у объекта своё, и без этой прибавки
 * «улучшение» оборачивалось бы понижением доли здоровья: максимум вырос,
 * текущее осталось прежним.
 */
const healToNewMaximum = (
  working: Working,
  player: WorkingPlayer,
  target: UpgradeTarget,
  before: PlayerStats,
  after: PlayerStats,
): void => {
  if (target === UpgradeTarget.General) {
    const gain = after.general.health - before.general.health;
    for (const general of working.generals) {
      if (general.owner === player.id) general.health += gain;
    }
    return;
  }

  for (const kind of BUILDABLE_KINDS) {
    if (STRUCTURE_UPGRADE_TARGET[kind] !== target) continue;

    for (const structure of working.structures) {
      if (structure.owner !== player.id || structure.kind !== kind || !structure.alive) continue;

      structure.health +=
        structureMaxHealth(after.structures[kind], structure.growthPpm) -
        structureMaxHealth(before.structures[kind], structure.growthPpm);
    }
  }

  for (const unit of working.units) {
    if (unit.owner !== player.id || !unit.alive) continue;
    if (UNIT_UPGRADE_TARGET[unit.unitType] !== target) continue;

    unit.health += after.units[unit.unitType].health - before.units[unit.unitType].health;
  }
};

const launchNuke = (working: Working, player: WorkingPlayer, cell: number): void => {
  if (!isValidCell(cell)) return;
  if (player.energy < NUKE_COST) return;

  const centre = cellCentre(cell);

  // Базы всегда остаются вне радиуса поражения — прямое требование
  // игрового замысла. Проверка живёт в ядре, а не только в интерфейсе:
  // правила должны действовать одинаково и для человека, и для противника
  // под управлением компьютера.
  for (const structure of working.structures) {
    if (!structure.alive || structure.kind !== StructureKind.Base) continue;

    const baseCentre = cellCentre(structure.cell);
    if (distanceSquared(centre, baseCentre) < NUKE_BASE_EXCLUSION * NUKE_BASE_EXCLUSION) return;
  }

  player.energy -= NUKE_COST;

  working.nukes.push({
    id: asEntityId(working.nextEntityId),
    owner: player.id,
    cell,
    detonateAtTick: asTickNumber(working.tick + NUKE_DELAY_TICKS),
  });

  working.nextEntityId += 1;
};
