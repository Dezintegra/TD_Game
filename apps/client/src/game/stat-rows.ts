import {
  STRUCTURE_UPGRADE_TARGET,
  StructureKind,
  TICKS_PER_SECOND,
  UNIT_TYPES,
  UNIT_UPGRADE_TARGET,
  UPGRADE_BRANCHES,
  UPGRADE_TARGET_COUNT,
  UpgradeStat,
  UpgradeTarget,
  energyToVisible,
  isUpgradeMaxed,
  unitsToCells,
} from '@td/shared';
import type { UnitType, UpgradeBranch } from '@td/shared';
import type { PlayerStats } from '@td/sim';
import type { StatRow } from './store.js';

/**
 * Строки характеристик под плитками тулбара.
 *
 * Показывается ДЕЙСТВУЮЩЕЕ значение, а не номер уровня. «Ур. 7» не отвечает
 * на вопрос, ради которого игрок сюда смотрит: решая, покупать ли восьмой,
 * он сравнивает силу, а из ступеньки силу не вывести.
 *
 * Перевод к читаемым величинам делается ЗДЕСЬ, а не в компонентах. Иначе
 * знание о внутреннем представлении — что перезарядка хранится тактами,
 * дальность внутренними единицами, а скорость единицами за тик —
 * размазалось бы по всему интерфейсу, а снимок матча существует ровно
 * затем, чтобы этого не было.
 *
 * Раскладываются строки по ГРУППАМ, а не по целям прокачки, и это
 * не синоним. Группа отвечает на вопрос «у какой плитки эта строка
 * отвечает игроку», цель — на вопрос «чью прокачку она описывает
 * в состоянии мира». Совпадают они везде, кроме ядерных веток.
 */

/**
 * Группа столбца для ядерных веток — своя, не совпадающая ни с одной
 * целью прокачки.
 *
 * Ядерные ветки принадлежат цели `Base`, и вынести их оттуда нельзя:
 * `UPGRADE_TARGET_COUNT` задаёт длину `purchasePpm`, входящего
 * в контрольную сумму КАЖДОГО мира, включая миры без единого удара.
 * Девятая цель сдвинула бы сумму всех сохранённых матчей и вдобавок
 * изменила бы перебор целей у противника под управлением компьютера.
 *
 * А показывать их у базы нельзя по другой причине: игрок ищет прокачку
 * ракеты у ракеты. На маленьком экране плитки базы нет вовсе (прямое
 * требование `match-hud`), и прокачка удара оказывалась доступна только
 * через панель прокачки у объекта, к которому удар отношения не имеет.
 *
 * Разрешается это здесь: группа — понятие интерфейса, и мира она
 * не касается.
 */
export const NUKE_STAT_GROUP = UPGRADE_TARGET_COUNT;

/** Сколько всего групп столбцов. Все цели плюс ядерная. */
export const STAT_GROUP_COUNT = UPGRADE_TARGET_COUNT + 1;

/** Характеристики, описывающие ракету, а не строение базы. */
const NUCLEAR_STATS: readonly UpgradeStat[] = [
  UpgradeStat.NukeDamage,
  UpgradeStat.NukeRadius,
  UpgradeStat.NukeCooldown,
];

/** Группа столбца, в которой показывается ветка. */
const groupOf = (branch: UpgradeBranch): number =>
  NUCLEAR_STATS.includes(branch.stat) ? NUKE_STAT_GROUP : branch.target;

/** Цель прокачки → тип юнита. Обратная сторона `UNIT_UPGRADE_TARGET`. */
const UNIT_BY_TARGET: ReadonlyMap<UpgradeTarget, UnitType> = new Map(
  UNIT_TYPES.map((type) => [UNIT_UPGRADE_TARGET[type], type]),
);

/** Цель прокачки → вид постройки. Обратная сторона `STRUCTURE_UPGRADE_TARGET`. */
const STRUCTURE_BY_TARGET: ReadonlyMap<UpgradeTarget, StructureKind> = new Map(
  ([StructureKind.Wall, StructureKind.TowerBasic, StructureKind.TowerSniper] as const).flatMap(
    (kind) => {
      const target = STRUCTURE_UPGRADE_TARGET[kind];
      return target === undefined ? [] : [[target, kind] as const];
    },
  ),
);

/** Значение характеристики и сколько знаков после запятой ему нужно. */
interface Reading {
  readonly value: number;
  readonly fraction: number;
}

/**
 * Скорострельность: выстрелов в секунду.
 *
 * Внутри она хранится ПЕРЕЗАРЯДКОЙ, и прокачка эту перезарядку уменьшает.
 * Показать убывающее число под стрелкой «вверх» — прямой обман, и это
 * не придирка: игрок читает строку, чтобы решить, покупать ли следующий
 * уровень, и падающая величина отвечает ему «нет».
 */
const shotsPerSecond = (cooldownTicks: number): Reading => ({
  value: TICKS_PER_SECOND / Math.max(1, cooldownTicks),
  fraction: 1,
});

const cells = (units: number): Reading => ({ value: unitsToCells(units), fraction: 1 });

/** Скорость хранится единицами за тик, а читается клетками в секунду. */
const cellsPerSecond = (unitsPerTick: number): Reading => ({
  value: unitsToCells(unitsPerTick) * TICKS_PER_SECOND,
  fraction: 1,
});

const whole = (value: number): Reading => ({ value, fraction: 0 });

const readingOf = (branch: UpgradeBranch, stats: PlayerStats): Reading | undefined => {
  const unitType = UNIT_BY_TARGET.get(branch.target);
  if (unitType !== undefined) {
    const unit = stats.units[unitType];

    switch (branch.stat) {
      case UpgradeStat.Attack:
        return whole(unit.attack);
      case UpgradeStat.Health:
        return whole(unit.health);
      case UpgradeStat.FireRate:
        return shotsPerSecond(unit.cooldownTicks);
      case UpgradeStat.Range:
        return cells(unit.range);
      case UpgradeStat.Speed:
        return cellsPerSecond(unit.speed);
      default:
        return undefined;
    }
  }

  const kind = STRUCTURE_BY_TARGET.get(branch.target);
  if (kind !== undefined) {
    const structure = stats.structures[kind];

    switch (branch.stat) {
      case UpgradeStat.Attack:
        return whole(structure.attack);
      case UpgradeStat.Health:
        return whole(structure.health);
      case UpgradeStat.FireRate:
        return shotsPerSecond(structure.cooldownTicks);
      case UpgradeStat.Range:
        return cells(structure.range);
      default:
        return undefined;
    }
  }

  if (branch.target === UpgradeTarget.General) {
    switch (branch.stat) {
      case UpgradeStat.Attack:
        return whole(stats.general.attack);
      case UpgradeStat.Health:
        return whole(stats.general.health);
      case UpgradeStat.Speed:
        return cellsPerSecond(stats.general.speed);
      case UpgradeStat.BuildRadius:
        return cells(stats.general.buildRadius);
      case UpgradeStat.RespawnTime:
        return { value: stats.general.respawnTicks / TICKS_PER_SECOND, fraction: 1 };
      default:
        return undefined;
    }
  }

  if (branch.target === UpgradeTarget.Base) {
    switch (branch.stat) {
      case UpgradeStat.Income:
        return whole(energyToVisible(stats.incomePerTick * TICKS_PER_SECOND));
      // Ядерный удар прокачивается по цели «база»: пусковая установка
      // стоит на её площадке. Забыть эти две строки нельзя тихо —
      // именно тихо и получилось бы: `undefined` означает «характеристика
      // без ветки», и строка просто не нарисовалась бы.
      case UpgradeStat.NukeDamage:
        return whole(stats.nuke.damage);
      case UpgradeStat.NukeRadius:
        return cells(stats.nuke.radius);
      case UpgradeStat.NukeCooldown:
        return { value: stats.nuke.cooldownTicks / TICKS_PER_SECOND, fraction: 0 };
      default:
        return undefined;
    }
  }

  return undefined;
};

/**
 * Строки по каждой группе столбцов.
 *
 * Строк ровно столько, сколько у группы веток. Характеристики без ветки
 * не показываются: столбец отвечает на вопрос «что можно улучшить»,
 * и строка без ответа занимает место зря.
 *
 * Уровни нужны здесь ради потолка: цена у предельной ветки смысла
 * не имеет, и вместо неё показывается «макс.».
 */
export const statRowsOf = (
  stats: PlayerStats,
  costs: readonly number[],
  energy: number,
  levels: readonly number[],
): readonly (readonly StatRow[])[] => {
  const rows: StatRow[][] = Array.from({ length: STAT_GROUP_COUNT }, () => []);

  UPGRADE_BRANCHES.forEach((branch, index) => {
    const reading = readingOf(branch, stats);
    if (reading === undefined) return;

    const cost = costs[index] ?? Number.POSITIVE_INFINITY;
    const row = rows[groupOf(branch)];
    if (row === undefined) return;

    const maxed = isUpgradeMaxed(branch, levels[index] ?? 0);

    row.push({
      branch: index,
      value: reading.value,
      fraction: reading.fraction,
      cost: energyToVisible(cost),
      // Предельная ветка не «дорогая», а закрытая: приглушённая стрелка
      // означала бы «копи», а копить тут не на что.
      affordable: !maxed && energy >= cost,
      maxed,
    });
  });

  return rows;
};
