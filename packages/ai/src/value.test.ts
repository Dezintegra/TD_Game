import { describe, expect, it } from 'vitest';
import {
  DIRECTION_SOUTH,
  UPGRADE_BRANCHES,
  UnitType,
  UpgradeStat,
  UpgradeTarget,
  asEntityId,
  asPlayerId,
  asTickNumber,
  compoundPpm,
  upgradeBranchIndex,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { cellCentre, createWorld, playerStats, upgradeCosts } from '@td/sim';
import type { UnitState, WorldState } from '@td/sim';
import { BASELINE_PROFILE } from './profile.js';
import type { PhaseProfile, Spending } from './profile.js';
import { hasComparableUpgrade, orderBySpendGain, unitGain, unitPrice, upgradeGain } from './value.js';

/**
 * Сравнение покупок по прибавке в энергии.
 *
 * Главное свойство, ради которого расчёт заведён: прокачка **умножает
 * то, что уже есть**, а машина приносит свою полную стоимость независимо
 * от того, что уже куплено. Отсюда следует, что при малом войске выгоднее
 * машина, а при большом — прокачка, и это должно быть видно числами,
 * а не подобрано порогом.
 */

const ME: PlayerId = asPlayerId(0);
const SEED = 20260821;

const phaseOf = (index: number): PhaseProfile => {
  const phase = BASELINE_PROFILE.phases[index];
  if (phase === undefined) throw new Error('нет такой фазы');
  return phase;
};

/** Мир с заданным числом штурмовиков у игрока. */
const withAssaults = (count: number): WorldState => {
  const world = createWorld(SEED);

  const units: UnitState[] = Array.from({ length: count }, (_unused, index) => ({
    id: asEntityId(5000 + index),
    owner: ME,
    unitType: UnitType.Assault,
    position: cellCentre(world.map.baseCells[ME] ?? 0),
    health: 100,
    facing: DIRECTION_SOUTH,
    readyAtTick: asTickNumber(0),
  }));

  return { ...world, units };
};

const statsOf = (world: WorldState) => {
  const player = world.players[ME];
  if (player === undefined) throw new Error('нет игрока');
  return { player, stats: playerStats(player) };
};

/** Фаза, где прокачка интересна только у штурмовика: без экономики. */
const ASSAULT_PHASE: PhaseProfile = {
  ...phaseOf(1),
  upgrades: { [UpgradeTarget.UnitAssault]: 1 },
};

describe('прибавка от покупки считается в энергии', () => {
  it('прибавка от машины не зависит от размера войска', () => {
    // В этом весь смысл сравнения: машина приносит своё независимо
    // от того, сколько их уже есть.
    const few = statsOf(withAssaults(5));
    const many = statsOf(withAssaults(50));

    expect(unitGain(few.stats, phaseOf(1), BASELINE_PROFILE)).toBe(
      unitGain(many.stats, phaseOf(1), BASELINE_PROFILE),
    );
  });

  it('прибавка от прокачки растёт с войском примерно в отношении его размера', () => {
    const few = withAssaults(5);
    const many = withAssaults(50);

    const gainOf = (world: WorldState): number => {
      const { player, stats } = statsOf(world);
      return upgradeGain(world, ME, stats, ASSAULT_PHASE, BASELINE_PROFILE, upgradeCosts(player))
        .gain;
    };

    const small = gainOf(few);
    const large = gainOf(many);

    expect(small).toBeGreaterThan(0);
    expect(large / small).toBeCloseTo(10, 1);
  });

  it('при пустом войске прокачка не приносит ничего', () => {
    // Ровно та осечка, ради которой всё затевалось: «прокачка вперёд
    // всего» на первой минуте умножает ноль.
    const world = withAssaults(0);
    const { player, stats } = statsOf(world);

    expect(
      upgradeGain(world, ME, stats, ASSAULT_PHASE, BASELINE_PROFILE, upgradeCosts(player)).gain,
    ).toBe(0);
  });

  it('прибавка от машины растёт с прокачкой её атаки', () => {
    const world = withAssaults(1);
    const before = statsOf(world);

    const branch = upgradeBranchIndex(UpgradeTarget.UnitAssault, UpgradeStat.Attack);
    const effect = UPGRADE_BRANCHES[branch]?.effectPercent ?? 0;

    // Правится множитель, а не только уровень: характеристики считаются
    // из множителя, и уровень сам по себе ни на что не влияет.
    const upgraded: WorldState = {
      ...world,
      players: world.players.map((player, index) =>
        index === ME
          ? {
              ...player,
              upgrades: player.upgrades.map((entry, position) =>
                position === branch
                  ? { ...entry, level: 5, effectPpm: compoundPpm(effect, 5) }
                  : entry,
              ),
            }
          : player,
      ),
    };

    expect(unitGain(statsOf(upgraded).stats, phaseOf(1), BASELINE_PROFILE)).toBeGreaterThan(
      unitGain(before.stats, phaseOf(1), BASELINE_PROFILE),
    );
  });

  it('средняя цена машины положительна при непустом составе', () => {
    expect(unitPrice(statsOf(withAssaults(0)).stats, phaseOf(1))).toBeGreaterThan(0);
  });
});

describe('экономика в сравнении не участвует', () => {
  it('фаза, где интересна одна экономика, сравнению не подлежит', () => {
    expect(hasComparableUpgrade(phaseOf(0))).toBe(false);
  });

  it('фаза с боевыми целями сравнению подлежит', () => {
    expect(hasComparableUpgrade(phaseOf(1))).toBe(true);
  });
});

describe('порядок трат по прибавке', () => {
  const order: readonly Spending[] = ['upgrade', 'build', 'train'];

  it('покупка с большей прибавкой обходит очередь', () => {
    expect(orderBySpendGain(order, { upgrade: 1, build: 2, train: 3 })).toEqual([
      'train',
      'build',
      'upgrade',
    ]);
  });

  it('несравнимая трата остаётся на своём месте', () => {
    // Прокачка без ключа — это фаза, где интересна одна экономика.
    // Двигать её значило бы решать за профиль.
    expect(orderBySpendGain(order, { build: 1, train: 5 })).toEqual(['upgrade', 'train', 'build']);
  });

  it('при единственной сравнимой трате порядок не меняется', () => {
    expect(orderBySpendGain(order, { train: 5 })).toEqual(order);
  });
});
