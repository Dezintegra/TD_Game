import {
  NAV_MIN_INTERVAL_TICKS,
  NUKE_RADIUS,
  PLAYERS_PER_MATCH,
  StructureKind,
  UNIT_CAP,
  asEntityId,
  asPlayerId,
  asTickNumber,
  distanceSquared,
} from '@td/shared';
import type { Command, PlayerId } from '@td/shared';
import { applyCommand } from './apply.js';
import { killGeneral, buildCombatIndices, resolveCombat } from './combat.js';
import { cellCentre } from './map.js';
import { findFreeCellNear, moveGenerals, moveUnits } from './movement.js';
import { buildNavField } from './navigation.js';
import { allPlayerStats, statsOf, structureMaxHealth } from './stats.js';
import type { PlayerStats } from './stats.js';
import {
  findBase,
  findStructure,
  fromWorking,
  invalidateNavigation,
  refreshOccupancy,
  toWorking,
} from './working.js';
import type { Working, WorkingPlayer } from './working.js';
import { PRODUCTION_IDLE, generalSpawnCell } from './world.js';
import type { WorldState } from './world.js';

/**
 * Один шаг симуляции: чистая функция (состояние, команды) -> новое состояние.
 *
 * Три свойства этой функции делают возможным сетевой PvP:
 *
 * 1. Она чистая — входное состояние не мутируется, возвращается новое.
 *    Значит, старые состояния можно хранить и откатываться к ним.
 * 2. Она детерминированная — одинаковые аргументы всегда дают одинаковый
 *    результат. Значит, клиент может считать вперёд, не дожидаясь сервера.
 * 3. Она не знает ни про сеть, ни про рендер. Значит, один и тот же код
 *    исполняется и в браузере, и в Node.js.
 *
 * Порядок этапов внутри тика влияет на исход и потому зафиксирован.
 * Меняете его — обновляйте эталон в determinism.golden.test.ts тем же
 * коммитом, как требует CLAUDE.md.
 */
export const step = (state: WorldState, commands: readonly Command[]): WorldState => {
  const working = toWorking(state);

  // Матч окончен — мир замирает. Тик всё равно растёт: часы идут,
  // даже когда играть уже не во что.
  if (working.winner !== null) return fromWorking(working);

  applyIncome(working, allPlayerStats(working.players));

  for (const command of commands) {
    applyCommand(working, command);
  }

  // Характеристики пересчитываются после команд: покупка улучшения
  // в этом же тике должна подействовать немедленно.
  const stats = allPlayerStats(working.players);

  advanceConstruction(working, stats);
  respawnGenerals(working, stats);
  runProduction(working, stats);
  refreshNavigation(working);

  moveUnits(working, stats);
  moveGenerals(working, stats);

  resolveCombat(working, stats, buildCombatIndices(working));
  detonateNukes(working, stats);

  if (working.structuresDirty) {
    refreshOccupancy(working);
    invalidateNavigation(working);
    working.structuresDirty = false;
  }

  resolveVictory(working);

  return fromWorking(working);
};

/**
 * Доход.
 *
 * Начисляется каждый тик независимо от действий игрока. Пассивный доход
 * задаёт нижнюю границу темпа и не даёт игре превратиться в сбор ресурсов:
 * внимание игрока должно уходить на позиционную борьбу.
 */
const applyIncome = (working: Working, stats: readonly PlayerStats[]): void => {
  for (const player of working.players) {
    player.energy += statsOf(stats, player.id).incomePerTick;
  }
};

/** Доля здоровья, с которой постройка появляется на карте. См. apply.ts. */
const BUILD_START_HEALTH_PERCENT = 20;

/**
 * Достройка возводимых построек.
 *
 * Здоровье растёт линейно от стартовой доли до максимума. Пока идёт
 * возведение, постройка уже перекрывает проход, но ещё не стреляет
 * и легко разрушается — в этом и смысл времени постройки.
 */
const advanceConstruction = (working: Working, stats: readonly PlayerStats[]): void => {
  for (const structure of working.structures) {
    if (!structure.alive || working.tick >= structure.builtAtTick) continue;

    const baseline = statsOf(stats, structure.owner).structures[structure.kind];
    const maxHealth = structureMaxHealth(baseline, structure.growthPpm);
    if (baseline.buildTicks <= 0) continue;

    const gain = Math.ceil(
      (maxHealth * (100 - BUILD_START_HEALTH_PERCENT)) / 100 / baseline.buildTicks,
    );

    structure.health = Math.min(maxHealth, structure.health + gain);
  }
};

/**
 * Возвращение генералов в игру.
 *
 * Смерть генерала не окончательна: наказание — потерянная позиция
 * и время, а не проигрыш.
 */
const respawnGenerals = (working: Working, stats: readonly PlayerStats[]): void => {
  for (const general of working.generals) {
    if (general.alive || working.tick < general.respawnAtTick) continue;

    const base = findBase(working.structures, general.owner);
    if (base === undefined) continue;

    const spawn = findFreeCellNear(working, generalSpawnCell(base.cell), 6);
    if (spawn < 0) continue;

    const centre = cellCentre(spawn);

    general.alive = true;
    general.health = statsOf(stats, general.owner).general.health;
    general.x = centre.x;
    general.y = centre.y;
    general.direction = 0;
  }
};

/**
 * Производство юнитов.
 *
 * Очередь на базе, по одному за раз. Энергия за заказ уже списана
 * в момент постановки в очередь, поэтому здесь остаётся только отсчитать
 * время и найти место для появления.
 */
const runProduction = (working: Working, stats: readonly PlayerStats[]): void => {
  for (const player of working.players) {
    const head = player.queue[0];

    if (head === undefined) {
      player.produceReadyAtTick = PRODUCTION_IDLE;
      continue;
    }

    const baseline = statsOf(stats, player.id).units[head];

    if (player.produceReadyAtTick === PRODUCTION_IDLE) {
      player.produceReadyAtTick = asTickNumber(working.tick + baseline.produceTicks);
      continue;
    }

    if (working.tick < player.produceReadyAtTick) continue;

    // Потолок численности: производство встаёт на паузу, а очередь
    // сохраняется. Энергия за неё уже уплачена, терять её игрок не должен.
    if (livingUnitCount(working, player.id) >= UNIT_CAP) continue;

    if (!spawnUnit(working, player, stats)) continue;

    player.queue.shift();
    player.produceReadyAtTick = PRODUCTION_IDLE;
  }
};

const livingUnitCount = (working: Working, owner: PlayerId): number => {
  let count = 0;
  for (const unit of working.units) {
    if (unit.alive && unit.owner === owner) count += 1;
  }
  return count;
};

const spawnUnit = (
  working: Working,
  player: WorkingPlayer,
  stats: readonly PlayerStats[],
): boolean => {
  const head = player.queue[0];
  if (head === undefined) return false;

  const base = findBase(working.structures, player.id);
  if (base === undefined) return false;

  const cell = findFreeCellNear(working, base.cell, 8);
  if (cell < 0) return false;

  const centre = cellCentre(cell);

  working.units.push({
    id: asEntityId(working.nextEntityId),
    owner: player.id,
    unitType: head,
    x: centre.x,
    y: centre.y,
    health: statsOf(stats, player.id).units[head].health,
    readyAtTick: working.tick,
    alive: true,
    blockedBy: -1,
  });

  working.nextEntityId += 1;
  return true;
};

const otherPlayer = (id: PlayerId): PlayerId => asPlayerId(PLAYERS_PER_MATCH - 1 - id);

/**
 * Пересчёт полей потока.
 *
 * Поле устаревает по двум причинам: сменилась цель или изменился набор
 * построек. Порог по тикам не даёт шквалу построек вызывать пересчёт
 * на каждом тике.
 *
 * Ревизия одна на обоих игроков, а не по игроку. Из-за этого постройка
 * одного игрока заставляет пересчитаться и поле другого. Это осознанное
 * упрощение: раздельные ревизии сэкономили бы половину пересчётов,
 * но потребовали бы отслеживать, чья именно постройка изменилась, —
 * а при пороге в десять тиков экономия того не стоит.
 */
const refreshNavigation = (working: Working): void => {
  working.players.forEach((player, index) => {
    const target = ensureTarget(working, player);
    const current = working.nav[index];

    if (current !== undefined) {
      if (current.revision === working.navRevision) return;
      if (working.tick - current.computedAtTick < NAV_MIN_INTERVAL_TICKS) return;
    }

    working.nav[index] = buildNavField(
      working.occupancy,
      working.structures,
      player.id,
      target,
      working.navRevision,
      working.tick,
    );
  });
};

/**
 * Цель игрока, с подстановкой базы противника вместо разрушенной.
 *
 * Без этого юниты после уничтожения назначенной башни замирали бы
 * на месте, ожидая приказа, которого игрок может и не отдать.
 */
const ensureTarget = (working: Working, player: WorkingPlayer) => {
  const target = findStructure(working.structures, player.targetStructure);
  if (target !== undefined) return target;

  const fallback = findBase(working.structures, otherPlayer(player.id));
  if (fallback !== undefined && player.targetStructure !== fallback.id) {
    player.targetStructure = fallback.id;
    invalidateNavigation(working);
  }

  return fallback;
};

/**
 * Взрывы ядерных ударов.
 *
 * Взрыв не различает стороны: свои юниты и постройки гибнут наравне
 * с чужими. Иначе ядерный удар стал бы бесплатным решением любой
 * позиционной проблемы.
 *
 * Базы и скалы не страдают: базы защищены запретной зоной наведения,
 * скалы неразрушимы по игровому замыслу.
 */
const detonateNukes = (working: Working, stats: readonly PlayerStats[]): void => {
  const detonated = working.nukes.filter((nuke) => working.tick >= nuke.detonateAtTick);
  if (detonated.length === 0) return;

  working.nukes = working.nukes.filter((nuke) => working.tick < nuke.detonateAtTick);

  const reach = NUKE_RADIUS * NUKE_RADIUS;

  for (const nuke of detonated) {
    const epicentre = cellCentre(nuke.cell);

    for (const unit of working.units) {
      if (!unit.alive) continue;
      if (distanceSquared(epicentre, unit) > reach) continue;

      unit.alive = false;
    }

    for (const structure of working.structures) {
      if (!structure.alive || structure.kind === StructureKind.Base) continue;
      if (distanceSquared(epicentre, cellCentre(structure.cell)) > reach) continue;

      structure.alive = false;
      working.structuresDirty = true;
    }

    for (const general of working.generals) {
      if (!general.alive) continue;
      if (distanceSquared(epicentre, general) > reach) continue;

      killGeneral(working, stats, general);
    }
  }
};

/**
 * Условие победы: разрушенная база.
 *
 * Проверяется в самом конце тика, когда все смерти уже случились —
 * иначе исход зависел бы от того, на каком этапе базу добили.
 */
const resolveVictory = (working: Working): void => {
  if (working.winner !== null) return;

  for (const player of working.players) {
    if (findBase(working.structures, player.id) === undefined) {
      working.winner = otherPlayer(player.id);
      return;
    }
  }
};
