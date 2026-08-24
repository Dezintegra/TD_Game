import {
  BASE_INCOME_PER_TICK,
  GENERAL_STATS,
  MIN_COOLDOWN_TICKS,
  MIN_RESPAWN_TICKS,
  PPM_ONE,
  STRUCTURE_STATS,
  STRUCTURE_UPGRADE_TARGET,
  StructureKind,
  UNIT_STATS,
  UNIT_UPGRADE_TARGET,
  UPGRADE_BRANCHES,
  UPGRADE_TARGET_COUNT,
  UnitType,
  UpgradeStat,
  UpgradeTarget,
  applyPpm,
  veteranStructurePpmOf,
  veteranUnitPpmOf,
} from '@td/shared';
import type { UpgradeBranch } from '@td/shared';
import type { PlayerState, UpgradeState } from './world.js';

/**
 * Характеристики выводятся из базовой таблицы и уровней прокачки,
 * а не хранятся в объектах.
 *
 * Так требование «улучшение действует на все объекты вида, включая уже
 * построенные» выполняется само собой: покупка меняет один множитель
 * у игрока, и все его объекты немедленно считаются по-новому. Хранить
 * характеристики в объектах значило бы обходить их все при каждой покупке.
 *
 * Исключение ровно одно — текущее здоровье. Оно у объекта своё, поэтому
 * при повышении ветки прочности живым объектам добавляется разница,
 * на которую вырос максимум. Этим занимается обработчик покупки.
 */

const STAT_COUNT = 8;

/**
 * Таблица «цель прокачки и характеристика → индекс ветки».
 *
 * Строится один раз при загрузке модуля. Альтернатива — искать ветку
 * перебором при каждом обращении — стоила бы двадцати семи сравнений
 * на каждую характеристику каждой сущности каждый тик.
 */
const BRANCH_LOOKUP = ((): Int32Array => {
  const lookup = new Int32Array(UPGRADE_TARGET_COUNT * STAT_COUNT).fill(-1);

  UPGRADE_BRANCHES.forEach((branch: UpgradeBranch, index: number) => {
    lookup[branch.target * STAT_COUNT + branch.stat] = index;
  });

  return lookup;
})();

export const branchIndexOf = (target: UpgradeTarget, stat: UpgradeStat): number =>
  BRANCH_LOOKUP[target * STAT_COUNT + stat] ?? -1;

/** Множитель эффекта прокачки. Единица, если такой ветки не существует. */
const effectPpm = (player: PlayerState, target: UpgradeTarget, stat: UpgradeStat): number => {
  const index = branchIndexOf(target, stat);
  if (index < 0) return PPM_ONE;

  return player.upgrades[index]?.effectPpm ?? PPM_ONE;
};

/** Цена покупки объекта с учётом подорожания от прокачки этого типа. */
export const purchaseCost = (
  player: PlayerState,
  target: UpgradeTarget,
  baseCost: number,
): number => applyPpm(baseCost, player.purchasePpm[target] ?? PPM_ONE);

/** Цена следующего уровня ветки прокачки. */
export const upgradeCostOf = (branchIndex: number, state: UpgradeState): number => {
  const branch = UPGRADE_BRANCHES[branchIndex];
  if (branch === undefined) return Number.POSITIVE_INFINITY;

  return applyPpm(branch.baseCost, state.costPpm);
};

/** Цены всех веток прокачки игрока. Нужна интерфейсу и противнику. */
export const upgradeCosts = (player: PlayerState): readonly number[] =>
  player.upgrades.map((state, index) => upgradeCostOf(index, state));

export interface UnitBaseline {
  readonly health: number;
  readonly attack: number;
  readonly cooldownTicks: number;
  readonly range: number;
  readonly speed: number;
  readonly structureDamagePercent: number;
  readonly cost: number;
}

export interface StructureBaseline {
  readonly health: number;
  readonly attack: number;
  readonly cooldownTicks: number;
  readonly range: number;
  readonly cost: number;
  readonly buildTicks: number;
}

export interface GeneralBaseline {
  readonly health: number;
  readonly attack: number;
  readonly cooldownTicks: number;
  readonly range: number;
  readonly speed: number;
  readonly buildRadius: number;
  readonly respawnTicks: number;
  readonly structureDamagePercent: number;
}

/**
 * Все характеристики одного игрока, посчитанные один раз на тик.
 *
 * Считать их заново для каждой из сотен сущностей означало бы сотни
 * одинаковых вычислений за тик. Таблица строится один раз в начале шага
 * и передаётся дальше.
 */
export interface PlayerStats {
  readonly units: Readonly<Record<UnitType, UnitBaseline>>;
  readonly structures: Readonly<Record<StructureKind, StructureBaseline>>;
  readonly general: GeneralBaseline;
  readonly incomePerTick: number;
}

const unitBaseline = (player: PlayerState, type: UnitType): UnitBaseline => {
  const base = UNIT_STATS[type];
  const target = UNIT_UPGRADE_TARGET[type];

  return {
    health: applyPpm(base.health, effectPpm(player, target, UpgradeStat.Health)),
    attack: applyPpm(base.attack, effectPpm(player, target, UpgradeStat.Attack)),
    cooldownTicks: Math.max(
      MIN_COOLDOWN_TICKS,
      applyPpm(base.cooldownTicks, effectPpm(player, target, UpgradeStat.FireRate)),
    ),
    // Дальность юнита прокачивается — у снайпера и Теслы.
    //
    // Прежде ветки не было, и запрет обосновывался так: «снайпер
    // с прокачанной дальностью перекрыл бы любую башню и обесценил
    // Теслу». Причина отмены записана здесь, а не удалена вместе
    // со старым комментарием, иначе запрет вернут обратно.
    //
    // Опасение не сбылось по арифметике. Ветки дальности всех типов растут
    // одинаково — на десять процентов за уровень, — поэтому при равном
    // числе уровней порядок сохраняется: снайперская башня остаётся дальше
    // Теслы, а Тесла — дальше базовой башни. Обогнать
    // соседа можно только вложив в дальность заметно больше, чем он,
    // и это уже не перекос, а осознанный размен, оплаченный вчетверо
    // более дорогой веткой.
    //
    // У штурмовика ветки нет, и множитель для него остаётся единичным:
    // `effectPpm` возвращает единицу, когда ветки не существует.
    range: applyPpm(base.range, effectPpm(player, target, UpgradeStat.Range)),
    speed: applyPpm(base.speed, effectPpm(player, target, UpgradeStat.Speed)),
    structureDamagePercent: base.structureDamagePercent,
    cost: purchaseCost(player, target, base.cost),
  };
};

const structureBaseline = (player: PlayerState, kind: StructureKind): StructureBaseline => {
  const base = STRUCTURE_STATS[kind];
  const target = STRUCTURE_UPGRADE_TARGET[kind];

  // База не прокачивается: у неё нет цели прокачки, и множители к ней
  // не применяются вовсе.
  //
  // ⚠️ Здесь мина на будущее, и она уже заряжена. Цель `UpgradeTarget.Base`
  // существует и держит ветку добычи энергии; появятся у базы прочность
  // или атака — их припишут туда же, к цели 7. А этот ранний выход
  // останется, и ветка будет ПРОДАВАТЬСЯ И НЕ РАБОТАТЬ: энергия спишется,
  // уровень вырастет, множитель посчитается — и будет отброшен здесь.
  //
  // Молча. Ни ошибки, ни отказа, ни признака: игрок просто не поймёт,
  // почему база не крепчает. Заводите ветку базы — снимайте выход
  // и заводите `STRUCTURE_UPGRADE_TARGET[Base]`.
  if (target === undefined) {
    return {
      health: base.health,
      attack: base.attack,
      cooldownTicks: base.cooldownTicks,
      range: base.range,
      cost: base.cost,
      buildTicks: base.buildTicks,
    };
  }

  return {
    health: applyPpm(base.health, effectPpm(player, target, UpgradeStat.Health)),
    attack: applyPpm(base.attack, effectPpm(player, target, UpgradeStat.Attack)),
    cooldownTicks: Math.max(
      MIN_COOLDOWN_TICKS,
      applyPpm(base.cooldownTicks, effectPpm(player, target, UpgradeStat.FireRate)),
    ),
    range: applyPpm(base.range, effectPpm(player, target, UpgradeStat.Range)),
    cost: purchaseCost(player, target, base.cost),
    buildTicks: base.buildTicks,
  };
};

const generalBaseline = (player: PlayerState): GeneralBaseline => {
  const target = UpgradeTarget.General;

  return {
    health: applyPpm(GENERAL_STATS.health, effectPpm(player, target, UpgradeStat.Health)),
    attack: applyPpm(GENERAL_STATS.attack, effectPpm(player, target, UpgradeStat.Attack)),
    cooldownTicks: Math.max(
      MIN_COOLDOWN_TICKS,
      applyPpm(GENERAL_STATS.cooldownTicks, effectPpm(player, target, UpgradeStat.FireRate)),
    ),
    range: GENERAL_STATS.range,
    speed: applyPpm(GENERAL_STATS.speed, effectPpm(player, target, UpgradeStat.Speed)),
    buildRadius: applyPpm(
      GENERAL_STATS.buildRadius,
      effectPpm(player, target, UpgradeStat.BuildRadius),
    ),
    respawnTicks: Math.max(
      MIN_RESPAWN_TICKS,
      applyPpm(GENERAL_STATS.respawnTicks, effectPpm(player, target, UpgradeStat.RespawnTime)),
    ),
    structureDamagePercent: GENERAL_STATS.structureDamagePercent,
  };
};

export const playerStats = (player: PlayerState): PlayerStats => ({
  units: {
    [UnitType.Assault]: unitBaseline(player, UnitType.Assault),
    [UnitType.Sniper]: unitBaseline(player, UnitType.Sniper),
    [UnitType.Tesla]: unitBaseline(player, UnitType.Tesla),
  },
  structures: {
    [StructureKind.Base]: structureBaseline(player, StructureKind.Base),
    [StructureKind.Wall]: structureBaseline(player, StructureKind.Wall),
    [StructureKind.TowerBasic]: structureBaseline(player, StructureKind.TowerBasic),
    [StructureKind.TowerSniper]: structureBaseline(player, StructureKind.TowerSniper),
  },
  general: generalBaseline(player),
  incomePerTick: applyPpm(
    BASE_INCOME_PER_TICK,
    effectPpm(player, UpgradeTarget.Base, UpgradeStat.Income),
  ),
});

export const allPlayerStats = (players: readonly PlayerState[]): readonly PlayerStats[] =>
  players.map(playerStats);

/** Характеристики нужного игрока, с запасным вариантом на случай пустой таблицы. */
export const statsOf = (table: readonly PlayerStats[], player: number): PlayerStats => {
  const entry = table[player];
  if (entry === undefined) {
    throw new Error(`Нет таблицы характеристик для игрока ${String(player)}`);
  }
  return entry;
};

/**
 * Характеристики с учётом ветеранского ранга объекта.
 *
 * На вход идёт число убийств, а не готовый множитель: в состоянии мира
 * хранится именно оно, а множитель выводится таблицей рангов. Так
 * не остаётся места, где можно передать множитель, не соответствующий
 * рангу.
 *
 * Ранг и прокачка перемножаются, а не складываются: и то и другое —
 * множители, и объект пятого ранга у игрока с двукратной прокачкой
 * должен быть вчетверо крепче базового.
 *
 * Ранг трогает только атаку и максимальное здоровье. Дальности, скорости
 * и перезарядки здесь нет намеренно: вся расстановка стрелков держится
 * на дальности, и ветеранская дальность выдавала бы клетку бесплатно,
 * в обход цены, за которую эту клетку берут прокачкой.
 */
export const structureMaxHealth = (baseline: StructureBaseline, kills: number): number =>
  applyPpm(baseline.health, veteranStructurePpmOf(kills));

export const structureAttack = (baseline: StructureBaseline, kills: number): number =>
  applyPpm(baseline.attack, veteranStructurePpmOf(kills));

export const unitMaxHealth = (baseline: UnitBaseline, kills: number): number =>
  applyPpm(baseline.health, veteranUnitPpmOf(kills));

export const unitAttack = (baseline: UnitBaseline, kills: number): number =>
  applyPpm(baseline.attack, veteranUnitPpmOf(kills));
