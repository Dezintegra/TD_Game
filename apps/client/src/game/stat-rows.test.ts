import { describe, expect, it } from 'vitest';
import {
  PPM_ONE,
  TICKS_PER_SECOND,
  UPGRADE_BRANCHES,
  UpgradeStat,
  UpgradeTarget,
  upgradeBranchIndex,
} from '@td/shared';
import { createWorld, playerStats, upgradeCosts } from '@td/sim';
import type { PlayerState } from '@td/sim';
import { statRowsOf } from './stat-rows.js';

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

const rowsOf = (player: PlayerState, energy = 1_000_000) =>
  statRowsOf(playerStats(player), upgradeCosts(player), energy);

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
    for (const target of [
      UpgradeTarget.UnitAssault,
      UpgradeTarget.UnitSniper,
      UpgradeTarget.UnitTesla,
      UpgradeTarget.TowerBasic,
      UpgradeTarget.TowerSniper,
      UpgradeTarget.Wall,
      UpgradeTarget.General,
      UpgradeTarget.Base,
    ]) {
      const branches = UPGRADE_BRANCHES.filter((branch) => branch.target === target).length;
      expect(rows[target]).toHaveLength(branches);
    }
  });

  it('у стены одна строка, у базы три, у генерала пять', () => {
    // У базы к добыче энергии добавились мощность заряда и радиус
    // поражения: пусковая установка стоит на её площадке, и обе ветки
    // ядерного удара принадлежат ей.
    expect(rows[UpgradeTarget.Wall]).toHaveLength(1);
    expect(rows[UpgradeTarget.Base]).toHaveLength(3);
    expect(rows[UpgradeTarget.General]).toHaveLength(5);
  });

  it('ни одна ветка не осталась без места', () => {
    const placed = rows
      .flat()
      .map((row) => row.branch)
      .sort((a, b) => a - b);
    expect(placed).toEqual(UPGRADE_BRANCHES.map((_, index) => index));
  });
});

describe('доступность покупки', () => {
  it('при нехватке энергии строка помечена недоступной, но остаётся', () => {
    const poor = statRowsOf(playerStats(base), upgradeCosts(base), 0);
    const rich = statRowsOf(playerStats(base), upgradeCosts(base), 1_000_000);

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
