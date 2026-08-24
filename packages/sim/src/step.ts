import {
  BlastKind,
  DIRECTION_SOUTH,
  DIRECTION_STOP,
  NAV_MIN_INTERVAL_TICKS,
  NUKE_RADIUS,
  PLAYERS_PER_MATCH,
  StructureKind,
  UNIT_CAP,
  asEntityId,
  asPlayerId,
  directionTowards,
  distanceSquared,
} from '@td/shared';
import type { Command, PlayerId } from '@td/shared';
import { applyCommand } from './apply.js';
import { killGeneral, buildCombatIndices, buildSpatialIndex, resolveCombat } from './combat.js';
import { separateUnits } from './crowd.js';
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
  position,
  recordBlast,
  refreshOccupancy,
  structurePosition,
  toWorking,
} from './working.js';
import type { Working, WorkingPlayer } from './working.js';
import { generalSpawnCell } from './world.js';
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
  //
  // Команды при этом всё же проходят через `applyCommand`. Не ради
  // применения — оно немедленно отказывает с причиной «матч окончен», —
  // а ради самого отказа: игрок, щёлкающий по полю после победы, должен
  // получать ответ, а не тишину. Мир от этого не меняется: отказ живёт
  // в отдельном списке и в контрольную сумму не входит.
  if (working.winner !== null) {
    commands.forEach((command, index) => {
      applyCommand(working, command, index);
    });

    return fromWorking(working);
  }

  applyIncome(working, allPlayerStats(working.players));

  commands.forEach((command, index) => {
    applyCommand(working, command, index);
  });

  // Характеристики пересчитываются после команд: покупка улучшения
  // в этом же тике должна подействовать немедленно.
  const stats = allPlayerStats(working.players);

  advanceConstruction(working, stats);
  advanceDemolition(working, stats);
  respawnGenerals(working, stats);
  runProduction(working, stats);
  refreshNavigation(working);

  // Индекс по положениям на начало тика. Движение спрашивает у него,
  // есть ли поблизости противник, и ответ не должен зависеть от того,
  // кто из юнитов успел сдвинуться раньше в этом же тике.
  const beforeMove = buildSpatialIndex(working.units.length, (index) => {
    const unit = working.units[index];
    return unit === undefined || !unit.alive ? undefined : { x: unit.x, y: unit.y };
  });

  moveUnits(working, stats, beforeMove);
  moveGenerals(working, stats);

  // Расталкивание идёт после движения и до боя, и оба соседства заданы
  // намеренно.
  //
  // После движения — потому что расталкивать надо то, что получилось
  // по итогам шага: поле потока сводит машины в одну точку, и разводить
  // их до шага значит разводить вчерашнюю расстановку.
  //
  // До боя — потому что бой обязан видеть окончательные положения.
  // Стреляй он раньше, выстрел уходил бы туда, где машины уже нет,
  // а накрытие считалось бы по строю, которого на поле не осталось.
  separateUnits(working, stats);

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
 * Сколько прочности должно быть набрано к концу `elapsed` тиков возведения.
 *
 * Это расписание, а не прибавка за тик, и разница принципиальна. Прибавка
 * обязана быть целой, а раздать нужно бывает меньше единицы за тик:
 * у снайперской башни это сто двадцать единиц на двести семьдесят тиков.
 * Округление вверх раздавало их вчетверо быстрее срока, и башня стояла
 * целой, но не стреляющей, последние пять секунд возведения.
 */
const gainedByTick = (total: number, elapsed: number, buildTicks: number): number =>
  Math.floor((total * elapsed) / buildTicks);

/**
 * Достройка возводимых построек.
 *
 * Здоровье растёт равномерно от стартовой доли до максимума. Пока идёт
 * возведение, постройка уже перекрывает проход, но ещё не стреляет
 * и легко разрушается — в этом и смысл времени постройки.
 *
 * Прибавка берётся разностью соседних значений расписания, поэтому за тик
 * она равна нулю или единице, а за весь срок набирается ровно то, что нужно.
 *
 * Ничего дополнительного в состоянии мира при этом не хранится: `elapsed`
 * выводится из `builtAtTick` и текущего тика, а оба уже есть. Остаток
 * раздачи, живи он полем в постройке, попал бы и в контрольную сумму,
 * и в откат при рассинхроне.
 *
 * Прибавка не зависит от текущей прочности — значит, подстреленная во время
 * стройки постройка продолжает набирать по расписанию, а не «долечивается»
 * до расчётного значения.
 */
const advanceConstruction = (working: Working, stats: readonly PlayerStats[]): void => {
  for (const structure of working.structures) {
    if (!structure.alive || working.tick >= structure.builtAtTick) continue;

    const baseline = statsOf(stats, structure.owner).structures[structure.kind];
    if (baseline.buildTicks <= 0) continue;

    const maxHealth = structureMaxHealth(baseline, structure.growthPpm);
    const startHealth = Math.max(
      1,
      Math.floor((maxHealth * BUILD_START_HEALTH_PERCENT) / 100),
    );
    const total = maxHealth - startHealth;

    const elapsed = baseline.buildTicks - (structure.builtAtTick - working.tick);
    const gain =
      gainedByTick(total, elapsed + 1, baseline.buildTicks) -
      gainedByTick(total, elapsed, baseline.buildTicks);

    structure.health = Math.min(maxHealth, structure.health + gain);
  }
};

/**
 * Ход сноса.
 *
 * Обратное возведение: здоровье убывает по тому же расписанию, клетка
 * остаётся непроходимой до последнего тика, в конце постройка исчезает.
 *
 * Сносимую постройку можно добить, и это не беда, а свойство: стена,
 * которую разбирают, перестаёт быть надёжной защитой — ровно так
 * и должно быть.
 *
 * Взрыва в конце сноса не записывается, и это не забывчивость. Вспышка
 * означает «по тебе попали», и на разобранной по собственному приказу
 * стене она была бы ложной тревогой. К последнему тику от постройки
 * и так остаётся единица прочности и осевшее до земли тело — взрываться
 * там уже нечему. Добитая посреди сноса стена взрыв, разумеется, даёт:
 * её убивает огонь, а огонь проходит через `dealDamage`.
 */
const advanceDemolition = (working: Working, stats: readonly PlayerStats[]): void => {
  for (const structure of working.structures) {
    if (!structure.alive || structure.demolishAtTick <= 0) continue;

    if (working.tick >= structure.demolishAtTick) {
      structure.alive = false;
      working.structuresDirty = true;
      continue;
    }

    const baseline = statsOf(stats, structure.owner).structures[structure.kind];
    if (baseline.buildTicks <= 0) continue;

    const maxHealth = structureMaxHealth(baseline, structure.growthPpm);
    const left = structure.demolishAtTick - working.tick;

    // То же расписание, что и у возведения, только прочитанное с конца.
    // Разность соседних значений даёт целую убыль в ноль или единицу,
    // а за весь срок разбирается ровно столько, сколько было набрано.
    const gain =
      gainedByTick(maxHealth, left, baseline.buildTicks) -
      gainedByTick(maxHealth, left - 1, baseline.buildTicks);

    structure.health = Math.max(1, structure.health - gain);
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
 * Отката нет: очередь опустошается целиком за один тик. Энергия за заказ
 * уже списана при постановке в очередь, поэтому здесь остаётся только
 * найти каждому место.
 *
 * Очередь при мгновенном производстве всё равно нужна, но уже не как
 * таймер, а как ожидание места: юнит остаётся в ней, пока достигнут
 * потолок численности или вокруг базы нет свободной клетки. Отклонять
 * такой заказ нельзя — энергия за него уже уплачена.
 *
 * Клетки появления не повторяются в пределах тика. Юниты проходят друг
 * сквозь друга, поэтому занятость их не разводит, и без этого десяток
 * заказанных разом встал бы в одну точку и двигался бы дальше идеально
 * слитно — на поле это выглядит как один юнит, а не как отряд.
 */
const runProduction = (working: Working, stats: readonly PlayerStats[]): void => {
  for (const player of working.players) {
    let living = livingUnitCount(working, player.id);
    const taken = new Set<number>();

    while (player.queue.length > 0 && living < UNIT_CAP) {
      if (!spawnUnit(working, player, stats, taken)) break;

      player.queue.shift();
      living += 1;
    }
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
  taken: Set<number>,
): boolean => {
  const head = player.queue[0];
  if (head === undefined) return false;

  const base = findBase(working.structures, player.id);
  if (base === undefined) return false;

  const cell = findFreeCellNear(working, base.cell, 8, taken);
  if (cell < 0) return false;

  taken.add(cell);

  const centre = cellCentre(cell);
  const baseCentre = cellCentre(base.cell);

  // Свежая машина уже повёрнута: она выезжает из базы наружу, туда же
  // и поедет. Запасной юг нужен на вырожденный случай, когда клетка
  // появления совпала с центром базы; в игре он невозможен — основание
  // базы непроходимо, — но полагаться на это молча не стоит.
  const outward = directionTowards(centre.x - baseCentre.x, centre.y - baseCentre.y);

  working.units.push({
    id: asEntityId(working.nextEntityId),
    owner: player.id,
    unitType: head,
    x: centre.x,
    y: centre.y,
    health: statsOf(stats, player.id).units[head].health,
    facing: outward === DIRECTION_STOP ? DIRECTION_SOUTH : outward,
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

    recordBlast(working, BlastKind.Nuke, nuke.owner, epicentre);

    // Каждый погибший получает и свой собственный взрыв, хотя в первые
    // полсекунды его не разглядеть за вспышкой. Разглядеть и не нужно:
    // вспышка гаснет быстрее, чем оседают обломки, и к концу зрелища
    // на земле должно остаться ровно то, что там погибло. Взрыв
    // без обломков читался бы как «здесь ничего и не стояло».
    for (const unit of working.units) {
      if (!unit.alive) continue;
      if (distanceSquared(epicentre, unit) > reach) continue;

      unit.alive = false;
      recordBlast(working, BlastKind.Unit, unit.owner, position(unit));
    }

    for (const structure of working.structures) {
      if (!structure.alive || structure.kind === StructureKind.Base) continue;
      if (distanceSquared(epicentre, cellCentre(structure.cell)) > reach) continue;

      structure.alive = false;
      working.structuresDirty = true;
      recordBlast(working, BlastKind.Structure, structure.owner, structurePosition(structure));
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
