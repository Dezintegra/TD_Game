import { describe, expect, it, vi } from 'vitest';
import {
  CommandKind,
  StructureKind,
  TICKS_PER_SECOND,
  UnitType,
  UpgradeStat,
  UpgradeTarget,
  asPlayerId,
  asEntityId,
  asTickNumber,
  upgradeBranchIndex,
} from '@td/shared';
import { createWorld, playerStats, upgradeCosts } from '@td/sim';
import type { PlayerState, WorldState } from '@td/sim';
import { createProduction } from './production.js';
import { createOpponent } from './opponent.js';
import { BASELINE_PROFILE } from './profile.js';
import type { AiProfile, PhaseProfile } from './profile.js';
import type { DecisionRecord } from './observer.js';

const A = UnitType.Assault;
const S = UnitType.Sniper;
const T = UnitType.Tesla;
const MIX = { [A]: 2, [S]: 3, [T]: 3 };
const TESLA = { [A]: 0, [S]: 0, [T]: 1 };
const EMPTY = { [A]: 0, [S]: 0, [T]: 0 };
const ME = asPlayerId(0);
const initial = createWorld(4242);
const player = initial.players[0]!;

describe('память обычного производства', () => {
  const orders = (increment: number, reroll: boolean) => {
    const production = createProduction();
    const issued: UnitType[] = [];
    const picks = [7, 0, 3, 5, 1, 4];
    let rolls = 0;
    let energy = 0;
    const costs = playerStats(player).units;
    for (let attempt = 0; issued.length < 60 && attempt < 10_000; attempt += 1) {
      energy += increment;
      // Контрольная порча воспроизводит прежнюю потерю выбора при нехватке денег.
      const state = reroll ? createProduction() : production;
      const chosen = state.choose(MIX, false, () => picks[rolls++ % picks.length]!);
      if (chosen === undefined || energy < costs[chosen].cost) continue;
      energy -= costs[chosen].cost;
      issued.push(chosen);
      state.issued();
    }
    expect(issued).toHaveLength(60);
    return { issued, rolls };
  };

  it('полная оплата и постепенный доход дают те же непустые 60 заказов', () => {
    const rich = orders(100_000, false);
    const poor = orders(100, false);
    expect(new Set(rich.issued)).toEqual(new Set([A, S, T]));
    expect(poor).toEqual(rich);
    expect(poor.rolls).toBe(60);
    expect(orders(100, true).issued).not.toEqual(rich.issued);
  });

  it('полная очередь не выбирает тип и не отменяет прежний выбор', () => {
    const state = createProduction();
    const roll = vi.fn(() => 7);
    expect(state.choose(MIX, true, roll)).toBeUndefined();
    expect(roll).not.toHaveBeenCalled();
    expect(state.choose(MIX, false, roll)).toBe(T);
    expect(state.choose(MIX, true, roll)).toBeUndefined();
    expect(state.choose(MIX, false, roll)).toBe(T);
    expect(roll).toHaveBeenCalledTimes(1);
  });

  it('положительный новый вес сохраняет заказ, нулевой и пустой состав отменяют', () => {
    const state = createProduction();
    const roll = vi.fn(() => 0);
    expect(state.choose(TESLA, false, roll)).toBe(T);
    state.reconcile(MIX);
    expect(state.choose(MIX, false, roll)).toBe(T);
    state.reconcile({ ...MIX, [T]: 0 });
    expect(state.choose(MIX, false, roll)).toBe(A);
    state.reconcile(EMPTY);
    expect(state.choose(EMPTY, false, roll)).toBeUndefined();
    expect(state.choose(TESLA, false, roll)).toBe(T);
    state.issued();
    expect(state.choose(MIX, false, roll)).toBe(A);
    expect(roll).toHaveBeenCalledTimes(4);
  });

  it('новый экземпляр не наследует чужое намерение', () => {
    const first = createProduction();
    expect(first.choose(TESLA, false, () => 0)).toBe(T);
    expect(createProduction().choose(MIX, false, () => 0)).toBe(A);
    expect(first.choose(MIX, false, () => 0)).toBe(T);
  });
});

const phase = (patch: Partial<PhaseProfile> = {}): PhaseProfile => ({
  untilSecond: Number.POSITIVE_INFINITY,
  upgrades: {},
  mix: MIX,
  spend: ['train'],
  reserve: 'none',
  ...patch,
});

const profile = (phases: readonly PhaseProfile[], horizon = 150): AiProfile => ({
  ...BASELINE_PROFILE,
  phases,
  push: { baseShare: Number.POSITIVE_INFINITY, waveSize: 0 },
  escort: { ...BASELINE_PROFILE.escort, units: 0 },
  spending: { ...BASELINE_PROFILE.spending, savingHorizonSeconds: horizon },
});

const worldAt = (second: number, patch: Partial<PlayerState> = {}): WorldState => ({
  ...initial,
  tick: asTickNumber(second * TICKS_PER_SECOND),
  structures: [
    ...initial.structures,
    {
      ...initial.structures.find((structure) => structure.owner === ME)!,
      id: asEntityId(500),
      kind: StructureKind.TowerBasic,
    },
  ],
  players: initial.players.map((value, index) =>
    index === 0 ? { ...value, energy: 0, ...patch } : value,
  ),
});

describe('обычное производство через createOpponent.decide', () => {
  it('пересчитывает цену после прокачки и резерв после смены фазы', () => {
    const upgraded = {
      ...player,
      purchasePpm: player.purchasePpm.map((value, index) =>
        index === UpgradeTarget.UnitTesla ? value * 2 : value,
      ),
    };
    const oldPrice = playerStats(player).units[T].cost;
    const newPrice = playerStats(upgraded).units[T].cost;
    expect(newPrice).toBeGreaterThan(oldPrice);
    const opponent = createOpponent(
      ME,
      42,
      profile([
        phase({ untilSecond: 1, mix: TESLA }),
        phase({ untilSecond: 3, reserve: 'wave' }),
        phase(),
      ]),
    );
    opponent.decide(worldAt(0));
    for (const [second, energy] of [
      [1, oldPrice],
      [2, newPrice],
    ] as const) {
      expect(
        opponent
          .decide(worldAt(second, { purchasePpm: upgraded.purchasePpm, energy }))
          .some((c) => c.kind === CommandKind.TrainUnit),
      ).toBe(false);
    }
    expect(
      opponent.decide(worldAt(3, { purchasePpm: upgraded.purchasePpm, energy: newPrice })),
    ).toContainEqual(expect.objectContaining({ kind: CommandKind.TrainUnit, unitType: T }));
  });

  it('сохраняет цель через заполненную очередь и выдаёт новый выбор после заказа', () => {
    const opponent = createOpponent(
      ME,
      42,
      profile([phase({ untilSecond: 1, mix: TESLA }), phase()]),
    );
    opponent.decide(worldAt(0));
    const queue = Array.from({ length: BASELINE_PROFILE.spending.queueTarget }, () => T);
    expect(
      opponent
        .decide(worldAt(1, { queue, energy: 100_000 }))
        .some((c) => c.kind === CommandKind.TrainUnit),
    ).toBe(false);
    const orders = [];
    for (let second = 2; second < 18; second += 1) {
      orders.push(
        ...opponent
          .decide(worldAt(second, { energy: 100_000 }))
          .filter((c) => c.kind === CommandKind.TrainUnit)
          .map((c) => c.unitType),
      );
    }
    expect(orders[0]).toBe(T);
    expect(new Set(orders)).toEqual(new Set([A, S, T]));
  });

  it('волна не исполняет сохранённый обычный заказ', () => {
    const base = profile([phase({ untilSecond: 1, mix: TESLA }), phase()]);
    const opponent = createOpponent(ME, 42, { ...base, push: { baseShare: 0, waveSize: 20 } });
    opponent.decide(worldAt(0));
    const wave = opponent
      .decide(worldAt(1, { energy: 100_000 }))
      .filter((c) => c.kind === CommandKind.TrainUnit);
    expect(wave.length).toBeGreaterThan(1);
    const ordinary = opponent
      .decide(worldAt(2, { energy: playerStats(player).units[T].cost }))
      .filter((c) => c.kind === CommandKind.TrainUnit);
    expect(ordinary).toHaveLength(1);
    expect(ordinary[0]!.unitType).toBe(T);
  });

  it('исчерпание терпения разрешает прокачку, сохраняя обычную цель', () => {
    const records: DecisionRecord[] = [];
    // Цена Теслы укладывается в горизонт, но неподвижная казна не растёт.
    const base = profile(
      [
        phase({ untilSecond: 1, mix: TESLA }),
        phase({
          spend: ['train', 'upgrade'],
          upgrades: { [UpgradeTarget.Base]: 1 },
          upgradeStats: [UpgradeStat.Income],
        }),
      ],
      30,
    );
    const opponent = createOpponent(ME, 42, base, (record) => records.push(record));
    const commands = [];
    for (let second = 0; second < 70; second += 1) {
      commands.push(
        ...opponent.decide(
          worldAt(second, {
            energy:
              second === 0
                ? 0
                : upgradeCosts(player)[upgradeBranchIndex(UpgradeTarget.Base, UpgradeStat.Income)]!,
          }),
        ),
      );
    }
    expect(records.some((record) => record.impatient)).toBe(true);
    expect(commands.some((c) => c.kind === CommandKind.BuyUpgrade)).toBe(true);
    expect(commands.some((c) => c.kind === CommandKind.TrainUnit)).toBe(false);
    expect(
      opponent.decide(worldAt(70, { energy: playerStats(player).units[T].cost })),
    ).toContainEqual(expect.objectContaining({ kind: CommandKind.TrainUnit, unitType: T }));
  });

  it.each([0, 150])('сохраняет дорогой выбор после wait/pass, горизонт %i', (horizon) => {
    const records: DecisionRecord[] = [];
    const opponent = createOpponent(
      ME,
      42,
      profile([phase({ untilSecond: 1, mix: TESLA }), phase()], horizon),
      (record) => records.push(record),
    );
    expect(opponent.decide(worldAt(0)).some((c) => c.kind === CommandKind.TrainUnit)).toBe(false);
    for (let second = 1; second < 6; second += 1) {
      expect(
        opponent
          .decide(worldAt(second, { energy: playerStats(player).units[S].cost }))
          .some((c) => c.kind === CommandKind.TrainUnit),
      ).toBe(false);
    }
    expect(records[0]!.attempts.find((a) => a.spending === 'train')?.result).toBe(
      horizon === 0 ? 'pass' : 'wait',
    );
    expect(
      opponent.decide(worldAt(6, { energy: playerStats(player).units[T].cost })),
    ).toContainEqual(expect.objectContaining({ kind: CommandKind.TrainUnit, unitType: T }));
  });

  it('переживает чужую покупку и пропуск производства', () => {
    const opponent = createOpponent(
      ME,
      42,
      profile([
        phase({ untilSecond: 1, mix: TESLA }),
        phase({
          untilSecond: 2,
          spend: ['upgrade'],
          upgrades: { [UpgradeTarget.Base]: 1 },
          upgradeStats: [UpgradeStat.Income],
        }),
        phase(),
      ]),
    );
    opponent.decide(worldAt(0));
    expect(opponent.decide(worldAt(1, { energy: 100_000 }))).toContainEqual(
      expect.objectContaining({ kind: CommandKind.BuyUpgrade }),
    );
    expect(
      opponent.decide(worldAt(2, { energy: playerStats(player).units[T].cost })),
    ).toContainEqual(expect.objectContaining({ kind: CommandKind.TrainUnit, unitType: T }));
  });

  it('отменяет исключённый тип даже при пропуске производства', () => {
    const opponent = createOpponent(
      ME,
      42,
      profile([
        phase({ untilSecond: 1, mix: TESLA }),
        phase({ untilSecond: 2, mix: EMPTY, spend: [] }),
        phase({ mix: { [A]: 1, [S]: 0, [T]: 0 } }),
      ]),
    );
    opponent.decide(worldAt(0));
    expect(
      opponent
        .decide(worldAt(1, { energy: 100_000 }))
        .some((c) => c.kind === CommandKind.TrainUnit),
    ).toBe(false);
    expect(
      opponent.decide(worldAt(2, { energy: playerStats(player).units[A].cost })),
    ).toContainEqual(expect.objectContaining({ kind: CommandKind.TrainUnit, unitType: A }));
  });
});
