import {
  BASE_BUILD_EXCLUSION,
  BUILDABLE_KINDS,
  BlastKind,
  CommandKind,
  DIRECTION_SOUTH,
  DIRECTION_STOP,
  INFLATES_PURCHASE,
  MAP_CELL_COUNT,
  NUKE_DELAY_TICKS,
  PRODUCTION_QUEUE_CAP,
  PURCHASE_INFLATION_PERCENT,
  RejectReason,
  STRUCTURE_STATS,
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
  directionTowards,
  distanceSquared,
  growPpm,
  isValidDirection,
  isValidStance,
  nukeBaseExclusion,
  nukeCost,
} from '@td/shared';
import type { Command, PlayerId, UnitType } from '@td/shared';
import { killGeneral } from './combat.js';
import { cellAt, cellCentre } from './map.js';
import { NO_STRUCTURE, footprintCells } from './occupancy.js';
import {
  allPlayerStats,
  playerStats,
  structureMaxHealth,
  unitMaxHealth,
  upgradeCostOf,
} from './stats.js';
import type { PlayerStats } from './stats.js';
import {
  invalidateNavigation,
  position,
  recordBlast,
  recordRejection,
  refreshOccupancy,
} from './working.js';
import type { Working, WorkingGeneral, WorkingPlayer, WorkingUnit } from './working.js';

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
 * Отказ не приводит к исключению: недопустимая команда — штатная ситуация,
 * а не аварийная. Она приходит от игрока, который нажал не туда,
 * или от устаревшего клиента, и валить из-за неё матч незачем.
 *
 * Но и молчать об отказе нельзя. Каждая проверка возвращает причину,
 * а `applyCommand` кладёт её в состояние мира. Молчаливый отказ отнимал
 * у игрока отклик на неверное действие и делал лог команд лживым:
 * «приказал построить башню» и «приказал, и приказ выбросили» выглядели
 * одинаково.
 *
 * Соглашение о возврате: `null` означает «команда применена», значение
 * `RejectReason` — «отклонена по этой причине». Каждая проверка даёт
 * свою причину; сливать две проверки в одну причину нельзя, если игрок
 * должен реагировать на них по-разному.
 */

/** Доля здоровья, с которой постройка появляется на карте. */
const BUILD_START_HEALTH_PERCENT = 20;

/** Итог применения: причина отказа либо `null`, если команда применена. */
type Outcome = RejectReason | null;

const APPLIED: Outcome = null;

const playerOf = (working: Working, id: PlayerId): WorkingPlayer | undefined =>
  working.players.find((player) => player.id === id);

const isValidCell = (cell: number): boolean =>
  Number.isInteger(cell) && cell >= 0 && cell < MAP_CELL_COUNT;

/**
 * Применить команду.
 *
 * `index` — её номер в списке, поданном на этот тик. Нужен только отказу:
 * без него «шесть отказов» не связать с тем, какие именно шесть команд
 * из десяти не прошли.
 */
export const applyCommand = (working: Working, command: Command, index = 0): void => {
  // Игрока с таким номером в матче нет. Единственный случай, когда отказ
  // не записывается: адресата у сообщения не существует, а приписать
  // отказ кому-то другому значило бы соврать в его логе.
  const player = playerOf(working, command.player);
  if (player === undefined) return;

  // После победы мир замирает: доигрывать нечего, а команды опоздавших
  // пакетов не должны менять итог матча.
  const outcome =
    working.winner !== null ? RejectReason.MatchOver : dispatch(working, player, command);

  if (outcome !== APPLIED) {
    recordRejection(working, command.player, command.kind, outcome, index);
  }
};

const dispatch = (working: Working, player: WorkingPlayer, command: Command): Outcome => {
  switch (command.kind) {
    case CommandKind.MoveGeneral:
      return moveGeneral(working, player, command.direction);
    case CommandKind.Build:
      return build(working, player, command.cell, command.structure);
    case CommandKind.TrainUnit:
      return trainUnit(player, command.unitType);
    case CommandKind.SetTarget:
      return setTarget(working, player, command.cell);
    case CommandKind.BuyUpgrade:
      return buyUpgrade(working, player, command.branch);
    case CommandKind.LaunchNuke:
      return launchNuke(working, player, command.cell);
    case CommandKind.Demolish:
      return demolish(working, player, command.cell);
    case CommandKind.SetStance:
      return setStance(player, command.stance);
  }
};

const moveGeneral = (working: Working, player: WorkingPlayer, direction: number): Outcome => {
  if (!isValidDirection(direction)) return RejectReason.InvalidArgument;

  const general = working.generals.find((entry) => entry.owner === player.id);
  if (general === undefined || !general.alive) return RejectReason.GeneralDead;

  general.direction = direction;

  return APPLIED;
};

/**
 * Клетка внутри защищённого кольца вокруг какой-нибудь базы.
 *
 * Расстояние меряется от центра базы по прямой, как и в запретной зоне
 * ядерного удара: кольцо — это круг, а не квадрат. По углам квадрата
 * запрет выглядел бы произвольным, а игрок читает поле кругами —
 * дальности и радиусы в игре все круглые.
 */
const insideBaseExclusion = (working: Working, cell: number): boolean => {
  const centre = cellCentre(cell);

  return working.map.baseCells.some(
    (base) =>
      distanceSquared(centre, cellCentre(base)) <= BASE_BUILD_EXCLUSION * BASE_BUILD_EXCLUSION,
  );
};

const build = (
  working: Working,
  player: WorkingPlayer,
  cell: number,
  kind: StructureKind,
): Outcome => {
  if (!isValidCell(cell)) return RejectReason.InvalidCell;
  if (!BUILDABLE_KINDS.includes(kind)) return RejectReason.InvalidArgument;

  // Кольцо вокруг базы проверяется ПЕРВЫМ — раньше занятости и живых
  // объектов. Порядок выбран не ради скорости, а ради того, что услышит
  // игрок: клетка у базы, где вдобавок стоит юнит, — это прежде всего
  // клетка у базы. Уйдёт юнит или нет, строить там всё равно нельзя,
  // и советовать «подожди, он уйдёт» было бы враньём.
  //
  // Кольцо защищает обе базы, включая собственную: обстроенная своя база
  // перестаёт выпускать юнитов и возвращать генерала так же надёжно,
  // как обстроенная чужая.
  if (insideBaseExclusion(working, cell)) return RejectReason.TooCloseToBase;

  // Клетка должна быть свободна и по рельефу, и по постройкам. Обе причины
  // для игрока означают одно и то же — «здесь уже что-то есть, целься
  // в другое место», — и потому это одна причина, а не две.
  if (working.map.cells[cell] !== Terrain.Ground) return RejectReason.CellBlocked;
  if (working.occupancy.blocked[cell] === 1) return RejectReason.CellBlocked;

  const footprint = footprintCells(cell, STRUCTURE_STATS[kind].footprintRadius);

  // И по живым — юнитам и генералам, чьим угодно.
  //
  // Причина здесь отдельная от «клетка занята» намеренно: занятость
  // рельефом или постройкой постоянна, и игроку надо выбрать другое место,
  // а живой объект уйдёт сам через секунду, и надо просто подождать.
  // Разные действия — разные причины.
  //
  // Разрешить постройку поверх вражеского юнита значило бы выдать генералу
  // оружие, которое убивает мгновенно, бьёт без промаха и стоит дешевле
  // снайпера. Запрет разворачивает это в обратную сторону: наступающий
  // юнит мешает стройке одним своим присутствием, и его сначала надо
  // прогнать.
  //
  // Генералы в этом правиле не для симметрии. Строитель стоит внутри
  // собственного радиуса строительства, то есть первый кандидат на постройку
  // — клетка под ним самим. Без запрета генерал замуровывал себя же:
  // клетка становилась непроходимой, а он оставался в ней, и ни один шаг
  // из неё уже не проходил проверку занятости. Ровно так противник
  // под управлением компьютера и застревал до конца матча.
  if (livingInside(working, footprint).length > 0) return RejectReason.CellOccupiedByLiving;

  const general = working.generals.find((entry) => entry.owner === player.id);
  if (general === undefined || !general.alive) return RejectReason.GeneralDead;

  const stats = playerStats(player);
  const centre = cellCentre(cell);
  const radius = stats.general.buildRadius;

  // Центральная механика: строить можно только вокруг себя. Чтобы укрепить
  // позицию, надо физически туда прийти и там находиться под ударом.
  if (distanceSquared(centre, { x: general.x, y: general.y }) > radius * radius) {
    return RejectReason.OutsideBuildRadius;
  }

  const baseline = stats.structures[kind];
  if (player.energy < baseline.cost) return RejectReason.NotEnoughEnergy;

  player.energy -= baseline.cost;

  const maxHealth = baseline.health;

  // Свежая постройка уже повёрнута — наружу от своей базы, то есть туда,
  // откуда придут. Первый же выстрел развернёт её на цель, но до него
  // может пройти полматча, и всё это время направление должно быть
  // осмысленным. Запасной юг нужен на вырожденный случай, когда клетка
  // постройки совпала с центром базы; в игре он невозможен — основание
  // базы непроходимо, — но полагаться на это молча не стоит.
  const baseCell = working.map.baseCells[player.id];
  const outward =
    baseCell === undefined
      ? DIRECTION_STOP
      : directionTowards(centre.x - cellCentre(baseCell).x, centre.y - cellCentre(baseCell).y);

  working.structures.push({
    id: asEntityId(working.nextEntityId),
    owner: player.id,
    kind,
    cell,
    facing: outward === DIRECTION_STOP ? DIRECTION_SOUTH : outward,
    // Постройка появляется недостроенной и потому уязвимой: она уже
    // перекрывает проход, но развалить её пока легко.
    health: Math.max(1, Math.floor((maxHealth * BUILD_START_HEALTH_PERCENT) / 100)),
    kills: 0,
    readyAtTick: asTickNumber(working.tick + baseline.buildTicks),
    builtAtTick: asTickNumber(working.tick + baseline.buildTicks),
    demolishAtTick: asTickNumber(0),
    alive: true,
  });

  working.nextEntityId += 1;

  // Страховка инварианта «живое не находится в непроходимой клетке».
  //
  // При выполненной проверке выше сюда попасть нельзя: основание стены
  // и башни равно одной клетке, а её мы и проверили. Правило существует
  // на случай, когда инвариант нарушится по другой причине — появится
  // постройка с основанием крупнее клетки или поменяется порядок этапов
  // тика. Результатом тогда будет гибель, а не запертый в стене навсегда
  // юнит.
  //
  // Генерал в этом случае не гибнет насовсем: он возрождается на базе,
  // так что даже сработавшая страховка стоит ему позиции и времени,
  // а не матча.
  for (const entity of livingInside(working, footprint)) {
    if ('unitType' in entity) {
      entity.alive = false;
      recordBlast(working, BlastKind.Unit, entity.owner, position(entity));
      continue;
    }

    killGeneral(working, allPlayerStats(working.players), entity);
  }

  refreshOccupancy(working);
  invalidateNavigation(working);

  return APPLIED;
};

/** Живые юниты и генералы, стоящие в перечисленных клетках. Чьи угодно. */
const livingInside = (
  working: Working,
  cells: readonly number[],
): readonly (WorkingUnit | WorkingGeneral)[] => {
  const inside = new Set(cells);
  const standing = (entity: { x: number; y: number }): boolean => inside.has(cellAt(entity));

  return [
    ...working.units.filter((unit) => unit.alive && standing(unit)),
    ...working.generals.filter((general) => general.alive && standing(general)),
  ];
};

const trainUnit = (player: WorkingPlayer, unitType: UnitType): Outcome => {
  if (UNIT_STATS[unitType] === undefined) return RejectReason.InvalidArgument;
  if (player.queue.length >= PRODUCTION_QUEUE_CAP) return RejectReason.QueueFull;

  const stats = playerStats(player);
  const cost = stats.units[unitType].cost;
  if (player.energy < cost) return RejectReason.NotEnoughEnergy;

  // Энергия списывается в момент заказа, а не в момент появления юнита.
  // Иначе очередь стала бы бесплатным резервированием: можно было бы
  // заказать двадцать юнитов, не имея на них энергии.
  player.energy -= cost;
  player.queue.push(unitType);

  return APPLIED;
};

const setTarget = (working: Working, player: WorkingPlayer, cell: number): Outcome => {
  if (!isValidCell(cell)) return RejectReason.InvalidCell;

  const index = working.occupancy.structureAt[cell] ?? NO_STRUCTURE;
  if (index === NO_STRUCTURE) return RejectReason.InvalidTarget;

  const structure = working.structures[index];
  if (structure === undefined || !structure.alive) return RejectReason.InvalidTarget;

  // Целью может быть только чужая постройка: приказ бить по своим —
  // почти наверняка промах мимо клетки, а не замысел.
  if (structure.owner === player.id) return RejectReason.InvalidTarget;

  // Цель уже назначена. Это не отказ, а успех: игрок хотел, чтобы целью
  // была эта постройка, и она ею является. Сообщать об отказе здесь
  // значило бы ругаться на повторный щелчок по той же башне.
  if (player.targetStructure === structure.id) return APPLIED;

  player.targetStructure = structure.id;
  invalidateNavigation(working);

  return APPLIED;
};

/**
 * Снос собственной постройки.
 *
 * Занимает столько же времени, сколько её возведение, и энергии
 * не возвращает — ни в начале, ни в конце.
 *
 * Возврата нет не из скупости. Считать его пришлось бы от цены, ПО КОТОРОЙ
 * постройка куплена: цена вида растёт с прокачкой, и возврат по текущей
 * превратил бы снос старых стен в способ зарабатывать на собственной
 * прокачке. Значит цену покупки надо было бы хранить у каждой постройки —
 * а с нею лишнее число в контрольной сумме, в снимке при рассинхроне
 * и в откате предсказания. Заодно исчезает вопрос «когда приходит
 * возврат» и цикл «поставил — снёс — поставил»: полная цена за каждую
 * постановку удерживает перекрытие прохода в статусе обязательства.
 *
 * Время сноса при этом нужно по другой причине, и её стоит помнить,
 * если однажды зайдёт разговор «а давайте ускорим». Постройка уже
 * оплачена, поэтому открывать и закрывать проход было бы БЕСПЛАТНО —
 * стена стала бы воротами с мгновенным приводом. Время заставляет решать
 * заранее, не видя, чем обернутся эти секунды.
 *
 * Начатый снос не отменяется: отмена вернула бы мгновенность через чёрный
 * ход — начал сносить, увидел волну, передумал.
 */
const demolish = (working: Working, player: WorkingPlayer, cell: number): Outcome => {
  if (!isValidCell(cell)) return RejectReason.InvalidCell;

  const index = working.occupancy.structureAt[cell] ?? NO_STRUCTURE;
  if (index === NO_STRUCTURE) return RejectReason.InvalidTarget;

  const structure = working.structures[index];
  if (structure === undefined || !structure.alive) return RejectReason.InvalidTarget;

  // Сносить можно только своё: приказ снести чужую постройку — это
  // не снос, а промах мимо клетки.
  if (structure.owner !== player.id) return RejectReason.InvalidTarget;

  // База — особый случай и особая причина. Игрок целился осмысленно,
  // и «недопустимая цель» ему ничего не объяснит.
  if (structure.kind === StructureKind.Base) return RejectReason.CannotDemolishBase;

  const general = working.generals.find((entry) => entry.owner === player.id);
  if (general === undefined || !general.alive) return RejectReason.GeneralDead;

  const radius = playerStats(player).general.buildRadius;
  if (distanceSquared(cellCentre(cell), { x: general.x, y: general.y }) > radius * radius) {
    return RejectReason.OutsideBuildRadius;
  }

  // Повторная команда по уже сносимой постройке — успех, а не отказ:
  // игрок хотел, чтобы её сносили, и её сносят. Срок при этом
  // не продлевается, иначе снос можно было бы растянуть навсегда.
  if (structure.demolishAtTick > 0) return APPLIED;

  structure.demolishAtTick = asTickNumber(
    working.tick + STRUCTURE_STATS[structure.kind].buildTicks,
  );

  return APPLIED;
};

/**
 * Режим атаки войска.
 *
 * Новой причины отказа не заводится: значение вне диапазона — та же
 * ошибка, что негодное направление или несуществующая ветка прокачки,
 * и действие игрока в ответ то же самое.
 */
const setStance = (player: WorkingPlayer, stance: number): Outcome => {
  if (!isValidStance(stance)) return RejectReason.InvalidArgument;

  player.stance = stance;

  return APPLIED;
};

const buyUpgrade = (working: Working, player: WorkingPlayer, branchIndex: number): Outcome => {
  const branch = UPGRADE_BRANCHES[branchIndex];
  if (branch === undefined) return RejectReason.InvalidArgument;

  const current = player.upgrades[branchIndex];
  if (current === undefined) return RejectReason.InvalidArgument;

  const cost = upgradeCostOf(branchIndex, current);
  if (player.energy < cost) return RejectReason.NotEnoughEnergy;

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

  return APPLIED;
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
        structureMaxHealth(after.structures[kind], structure.kills) -
        structureMaxHealth(before.structures[kind], structure.kills);
    }
  }

  for (const unit of working.units) {
    if (unit.owner !== player.id || !unit.alive) continue;
    if (UNIT_UPGRADE_TARGET[unit.unitType] !== target) continue;

    // Через ранг, а не по базовым числам: максимум ветерана выше
    // базового, и прибавка ему полагается тоже большая. Считай мы
    // по базовым, полная полоса здоровья ветерана после покупки
    // становилась бы неполной — награда за прокачку выглядела
    // повреждением.
    unit.health +=
      unitMaxHealth(after.units[unit.unitType], unit.kills) -
      unitMaxHealth(before.units[unit.unitType], unit.kills);
  }
};

const launchNuke = (working: Working, player: WorkingPlayer, cell: number): Outcome => {
  if (!isValidCell(cell)) return RejectReason.InvalidCell;

  // Радиус и мощность берутся один раз, здесь, и дальше живут в записи
  // об ударе. От радиуса же считаются и цена, и запретная зона: платят
  // за накрытую площадь, а зона обязана расти вместе с кругом, иначе
  // прокачавший радиус накрыл бы базу.
  const nuke = playerStats(player).nuke;
  const cost = nukeCost(nuke.radius);

  if (player.energy < cost) return RejectReason.NotEnoughEnergy;

  const centre = cellCentre(cell);
  const exclusion = nukeBaseExclusion(nuke.radius);

  // Базы всегда остаются вне радиуса поражения — прямое требование
  // игрового замысла. Проверка живёт в ядре, а не только в интерфейсе:
  // правила должны действовать одинаково и для человека, и для противника
  // под управлением компьютера.
  for (const structure of working.structures) {
    if (!structure.alive || structure.kind !== StructureKind.Base) continue;

    const baseCentre = cellCentre(structure.cell);
    if (distanceSquared(centre, baseCentre) < exclusion * exclusion) {
      return RejectReason.NukeNearBase;
    }
  }

  player.energy -= cost;

  working.nukes.push({
    id: asEntityId(working.nextEntityId),
    owner: player.id,
    cell,
    detonateAtTick: asTickNumber(working.tick + NUKE_DELAY_TICKS),
    radius: nuke.radius,
    damage: nuke.damage,
  });

  working.nextEntityId += 1;

  return APPLIED;
};
