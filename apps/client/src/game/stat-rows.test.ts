import { describe, expect, it } from 'vitest';
import {
  NUKE_COOLDOWN_MAX_LEVEL,
  PPM_ONE,
  TICKS_PER_SECOND,
  UPGRADE_BRANCHES,
  UpgradeStat,
  UpgradeTarget,
  upgradeBranchIndex,
} from '@td/shared';
import { createWorld, playerStats, upgradeCosts } from '@td/sim';
import type { PlayerState } from '@td/sim';
import { NUKE_STAT_GROUP, statRowsOf } from './stat-rows.js';

/**
 * Столбец характеристик под плиткой отвечает на один вопрос: стоит ли
 * покупать следующий уровень. Ответ игрок читает по числу, и число обязано
 * расти, когда растёт сила.
 *
 * Особенно это касается скорострельности: внутри она хранится
 * ПЕРЕЗАРЯДКОЙ, и прокачка эту перезарядку уменьшает. Показать убывающее
 * число под стрелкой «вверх» — прямой обман, и заметить его глазами
 * трудно: интерфейс выглядит работающим.
 */

const world = createWorld(777);
const base = world.players[0];
if (base === undefined) throw new Error('В мире нет игрока');

/** Игрок с купленным уровнем одной ветки. Множитель подставляется прямо. */
const withLevel = (player: PlayerState, branch: number, effectPpm: number): PlayerState => ({
  ...player,
  upgrades: player.upgrades.map((entry, index) =>
    index === branch ? { ...entry, level: entry.level + 1, effectPpm } : entry,
  ),
});

const levelsOf = (player: PlayerState): readonly number[] =>
  player.upgrades.map((entry) => entry.level);

const rowsOf = (player: PlayerState, energy = 1_000_000) =>
  statRowsOf(playerStats(player), upgradeCosts(player), energy, levelsOf(player));

const valueOf = (player: PlayerState, target: UpgradeTarget, stat: UpgradeStat): number => {
  const branch = upgradeBranchIndex(target, stat);
  const row = rowsOf(player)[target]?.find((entry) => entry.branch === branch);
  if (row === undefined) throw new Error(`Нет строки для ветки ${String(branch)}`);
  return row.value;
};

describe('характеристики показываются числами, а не уровнями', () => {
  it('скорострельность растёт вместе с прокачкой, а не падает', () => {
    const branch = upgradeBranchIndex(UpgradeTarget.UnitAssault, UpgradeStat.FireRate);

    const before = valueOf(base, UpgradeTarget.UnitAssault, UpgradeStat.FireRate);
    // Прокачка скорострельности УМЕНЬШАЕТ перезарядку: множитель меньше
    // единицы. Показанное же число обязано вырасти.
    const after = valueOf(
      withLevel(base, branch, Math.round(PPM_ONE * 0.94)),
      UpgradeTarget.UnitAssault,
      UpgradeStat.FireRate,
    );

    expect(after).toBeGreaterThan(before);
  });

  it('базовая скорострельность — один выстрел в секунду', () => {
    expect(valueOf(base, UpgradeTarget.UnitAssault, UpgradeStat.FireRate)).toBeCloseTo(1, 6);
  });

  it('атака растёт вместе с прокачкой', () => {
    const branch = upgradeBranchIndex(UpgradeTarget.UnitAssault, UpgradeStat.Attack);

    const before = valueOf(base, UpgradeTarget.UnitAssault, UpgradeStat.Attack);
    const after = valueOf(
      withLevel(base, branch, Math.round(PPM_ONE * 1.1)),
      UpgradeTarget.UnitAssault,
      UpgradeStat.Attack,
    );

    expect(after).toBeGreaterThan(before);
  });

  it('дальность показана клетками, а не внутренними единицами', () => {
    // Базовая дальность снайперской башни — величина в клетках, и число
    // должно быть однозначным, а не тысячным.
    const range = valueOf(base, UpgradeTarget.TowerSniper, UpgradeStat.Range);

    expect(range).toBeGreaterThan(1);
    expect(range).toBeLessThan(50);
  });

  it('скорость показана клетками в секунду', () => {
    const speed = valueOf(base, UpgradeTarget.UnitAssault, UpgradeStat.Speed);

    // Замысел говорит «около двух клеток в секунду».
    expect(speed).toBeGreaterThan(1.5);
    expect(speed).toBeLessThan(2.5);
  });

  it('время возрождения показано секундами', () => {
    // Замысел: десять секунд.
    expect(valueOf(base, UpgradeTarget.General, UpgradeStat.RespawnTime)).toBeCloseTo(10, 6);
  });

  it('добыча энергии показана единицами в секунду', () => {
    // Базовый доход — десять единиц в секунду.
    expect(valueOf(base, UpgradeTarget.Base, UpgradeStat.Income)).toBe(10);
  });
});

describe('состав столбцов', () => {
  const rows = rowsOf(base);

  it('строк ровно столько, сколько у цели веток', () => {
    // База сюда не входит: три её ядерные ветки показываются у плитки
    // удара, и совпадение «группа равна цели» на ней как раз нарушено.
    for (const target of [
      UpgradeTarget.UnitAssault,
      UpgradeTarget.UnitSniper,
      UpgradeTarget.UnitTesla,
      UpgradeTarget.TowerBasic,
      UpgradeTarget.TowerSniper,
      UpgradeTarget.Wall,
      UpgradeTarget.General,
    ]) {
      const branches = UPGRADE_BRANCHES.filter((branch) => branch.target === target).length;
      expect(rows[target]).toHaveLength(branches);
    }
  });

  it('у стены одна строка, у базы одна, у ядерки три, у генерала пять', () => {
    // Ядерные ветки принадлежат цели «база» — пусковая установка стоит
    // на её площадке, — но показываются у плитки удара: игрок ищет
    // прокачку ракеты у ракеты. На маленьком экране плитки базы нет
    // вовсе, и у базы они были бы недоступны на телефоне.
    expect(rows[UpgradeTarget.Wall]).toHaveLength(1);
    expect(rows[UpgradeTarget.Base]).toHaveLength(1);
    expect(rows[NUKE_STAT_GROUP]).toHaveLength(3);
    expect(rows[UpgradeTarget.General]).toHaveLength(5);
  });

  it('у базы осталась только добыча энергии', () => {
    const income = upgradeBranchIndex(UpgradeTarget.Base, UpgradeStat.Income);

    expect(rows[UpgradeTarget.Base]?.map((row) => row.branch)).toEqual([income]);
  });

  it('в ядерной группе ровно три ветки цели «база»', () => {
    expect(rows[NUKE_STAT_GROUP]?.map((row) => row.branch)).toEqual([
      upgradeBranchIndex(UpgradeTarget.Base, UpgradeStat.NukeDamage),
      upgradeBranchIndex(UpgradeTarget.Base, UpgradeStat.NukeRadius),
      upgradeBranchIndex(UpgradeTarget.Base, UpgradeStat.NukeCooldown),
    ]);
  });

  it('дальность стрелка стои́т в группе своего типа, а не в конце', () => {
    // Ветка дописана в самый КОНЕЦ таблицы — иначе поехали бы индексы,
    // а индекс ветки лежит в сохранённых записях матчей. В интерфейсе же
    // она обязана оказаться рядом с прочими ветками своего типа: группы
    // строятся по цели прокачки, а не по порядку в таблице, и вот это
    // свойство здесь и закрепляется.
    for (const target of [UpgradeTarget.UnitSniper, UpgradeTarget.UnitTesla]) {
      const range = upgradeBranchIndex(target, UpgradeStat.Range);

      expect(range).toBeGreaterThan(0);
      expect(rows[target]?.map((row) => row.branch)).toContain(range);
      // Пять строк вместо четырёх: у этих двух типов группа выросла,
      // и от этого зависит, помещается ли панель целиком.
      expect(rows[target]).toHaveLength(5);
    }
  });

  it('у штурмовика строки дальности нет', () => {
    // Две клетки — то, что отличает его от дальнобойных типов, и ветка
    // стёрла бы разницу ролей. Строка без ветки заняла бы место зря.
    expect(upgradeBranchIndex(UpgradeTarget.UnitAssault, UpgradeStat.Range)).toBe(-1);
    expect(rows[UpgradeTarget.UnitAssault]).toHaveLength(4);
  });

  it('ни одна ветка не осталась без места', () => {
    const placed = rows
      .flat()
      .map((row) => row.branch)
      .sort((a, b) => a - b);
    expect(placed).toEqual(UPGRADE_BRANCHES.map((_, index) => index));
  });
});

describe('ветка на потолке', () => {
  const cooldown = upgradeBranchIndex(UpgradeTarget.Base, UpgradeStat.NukeCooldown);

  const atLevel = (level: number): PlayerState => ({
    ...base,
    upgrades: base.upgrades.map((entry, index) =>
      index === cooldown ? { ...entry, level } : entry,
    ),
  });

  const rowFor = (player: PlayerState) =>
    rowsOf(player)[NUKE_STAT_GROUP]?.find((row) => row.branch === cooldown);

  it('откат показан секундами, а не тактами', () => {
    const row = rowFor(base);

    expect(row?.value).toBe(60);
    expect(row?.fraction).toBe(0);
  });

  it('каждый уровень снимает по десять секунд', () => {
    expect(rowFor(atLevel(1))?.value).toBe(50);
    expect(rowFor(atLevel(NUKE_COOLDOWN_MAX_LEVEL))?.value).toBe(30);
  });

  it('до потолка ветка обычная, на потолке — закрытая', () => {
    expect(rowFor(atLevel(NUKE_COOLDOWN_MAX_LEVEL - 1))?.maxed).toBe(false);
    expect(rowFor(atLevel(NUKE_COOLDOWN_MAX_LEVEL))?.maxed).toBe(true);
  });

  it('на потолке покупка недоступна при любом кошельке', () => {
    // Приглушённая стрелка означает «копи», а копить здесь не на что:
    // ядро отклонит покупку при любой энергии.
    const row = rowsOf(atLevel(NUKE_COOLDOWN_MAX_LEVEL), 1_000_000_000)[NUKE_STAT_GROUP]?.find(
      (entry) => entry.branch === cooldown,
    );

    expect(row?.affordable).toBe(false);
  });

  it('строка на потолке из столбца НЕ пропадает', () => {
    // Пропасть она не может: игрок должен видеть, что откат прокачан
    // до предела, а не гадать, куда делась ветка.
    expect(rowsOf(atLevel(NUKE_COOLDOWN_MAX_LEVEL))[NUKE_STAT_GROUP]).toHaveLength(3);
  });
});

describe('доступность покупки', () => {
  it('при нехватке энергии строка помечена недоступной, но остаётся', () => {
    const poor = statRowsOf(playerStats(base), upgradeCosts(base), 0, levelsOf(base));
    const rich = statRowsOf(playerStats(base), upgradeCosts(base), 1_000_000, levelsOf(base));

    expect(poor[UpgradeTarget.UnitAssault]).toHaveLength(
      rich[UpgradeTarget.UnitAssault]?.length ?? 0,
    );
    expect(poor[UpgradeTarget.UnitAssault]?.every((row) => !row.affordable)).toBe(true);
    expect(rich[UpgradeTarget.UnitAssault]?.every((row) => row.affordable)).toBe(true);
  });

  it('цена приведена к видимым единицам', () => {
    const row = rowsOf(base)[UpgradeTarget.UnitAssault]?.[0];
    expect(row).toBeDefined();

    // Ветки штурмовика стоят сорок видимых единиц за первый уровень.
    expect(row?.cost).toBe(40);
  });
});

describe('единицы измерения', () => {
  it('целым числам не приписывается дробная часть', () => {
    const rows = rowsOf(base);
    const attack = rows[UpgradeTarget.UnitAssault]?.find(
      (row) => row.branch === upgradeBranchIndex(UpgradeTarget.UnitAssault, UpgradeStat.Attack),
    );

    expect(attack?.fraction).toBe(0);
  });

  it('дробным — приписывается', () => {
    const rows = rowsOf(base);
    const rate = rows[UpgradeTarget.UnitAssault]?.find(
      (row) => row.branch === upgradeBranchIndex(UpgradeTarget.UnitAssault, UpgradeStat.FireRate),
    );

    expect(rate?.fraction).toBe(1);
  });

  it('секунда игрового времени — тридцать тиков', () => {
    // Проверка не про строки, а про то, что перевод в секунды опирается
    // на ту же константу, что и мир.
    expect(TICKS_PER_SECOND).toBe(30);
  });
});
