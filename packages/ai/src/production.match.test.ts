import { describe, expect, it } from 'vitest';
import {
  CommandKind,
  StructureKind,
  TICKS_PER_SECOND,
  UnitType,
  UpgradeStat,
  UpgradeTarget,
  asPlayerId,
  asTickNumber,
  upgradeBranchIndex,
} from '@td/shared';
import { checksum, createWorld, step } from '@td/sim';
import type { WorldState } from '@td/sim';
import { createOpponent } from './opponent.js';
import { BASELINE_PROFILE } from './profile.js';
import type { AiProfile } from './profile.js';

const ME = asPlayerId(0);
const SEED = 4242;
const COUNT = 128;
const MAX_TICKS = 15 * 60 * TICKS_PER_SECOND;
const TYPES = [UnitType.Assault, UnitType.Sniper, UnitType.Tesla] as const;
const MIX = { [UnitType.Assault]: 2, [UnitType.Sniper]: 3, [UnitType.Tesla]: 3 };
const PROFILE: AiProfile = {
  ...BASELINE_PROFILE,
  id: 'test-ordinary-production',
  push: { baseShare: Number.POSITIVE_INFINITY, waveSize: 0 },
  escort: { ...BASELINE_PROFILE.escort, units: 0 },
  phases: [
    {
      untilSecond: Number.POSITIVE_INFINITY,
      upgrades: {},
      mix: MIX,
      spend: ['train'],
      reserve: 'none',
    },
  ],
};

const play = (rich: boolean) => {
  const initial = createWorld(SEED);
  const income = upgradeBranchIndex(UpgradeTarget.Base, UpgradeStat.Income);
  // Это стенд производства: прочные базы исключают преждевременную победу,
  // отсутствующий генерал — стройку. Юниты, очередь, цена и бой остаются живыми.
  // Доход x8 сокращает стоимость теста, но Тесла всё ещё требует нескольких
  // решений накопления. Только контроль получает всю казну заранее.
  let world: WorldState = {
    ...initial,
    structures: initial.structures.map((structure) =>
      structure.kind === StructureKind.Base ? { ...structure, health: 1_000_000_000 } : structure,
    ),
    generals: initial.generals.map((general) =>
      general.owner === ME
        ? { ...general, alive: false, health: 0, respawnAtTick: asTickNumber(MAX_TICKS + 1) }
        : general,
    ),
    players: initial.players.map((player) =>
      player.id === ME
        ? {
            ...player,
            energy: rich ? 10_000_000 : 0,
            upgrades: player.upgrades.map((upgrade, index) =>
              index === income ? { ...upgrade, effectPpm: upgrade.effectPpm * 8 } : upgrade,
            ),
          }
        : player,
    ),
  };
  let waits = 0;
  let waves = 0;
  const opponent = createOpponent(ME, SEED, PROFILE, (record) => {
    if (record.pushed) waves += 1;
    if (
      record.attempts.some((attempt) => attempt.spending === 'train' && attempt.result === 'wait')
    ) {
      waits += 1;
    }
  });
  const orders: UnitType[] = [];
  let ending: 'orders' | 'tick-limit' | 'victory' = 'tick-limit';
  for (let tick = 0; tick < MAX_TICKS; tick += 1) {
    const commands = opponent.decide(world);
    orders.push(
      ...commands
        .filter((command) => command.kind === CommandKind.TrainUnit)
        .map((command) => command.unitType),
    );
    world = step(world, commands);
    if (orders.length >= COUNT) {
      ending = 'orders';
      break;
    }
    if (world.winner !== null) {
      ending = 'victory';
      break;
    }
  }
  return { orders, ending, ticks: world.tick, checksum: checksum(world), waits, waves };
};

describe('обычный состав при разном темпе оплаты', () => {
  it('достигает выборки, исполняет веса и воспроизводится', () => {
    const poor = play(false);
    const rich = play(true);
    for (const result of [poor, rich]) {
      expect(result.ending).toBe('orders');
      expect(result.orders).toHaveLength(COUNT);
      expect(new Set(result.orders)).toEqual(new Set(TYPES));
      expect(result.waves).toBe(0);
    }
    expect(poor.waits).toBeGreaterThan(0);
    expect(rich.waits).toBe(0);
    expect(poor.ticks).toBeGreaterThan(rich.ticks);

    // Неравенство Хёффдинга и объединение шести сравнений дают вероятность
    // ложного отказа не выше 1%. Порог выбран до прогона, а не по его долям.
    const epsilon = Math.sqrt(Math.log(12 / 0.01) / (2 * COUNT));
    for (const type of TYPES) {
      const share = (orders: readonly UnitType[]) =>
        orders.filter((value) => value === type).length / COUNT;
      expect(Math.abs(share(poor.orders) - MIX[type] / 8)).toBeLessThanOrEqual(epsilon);
      expect(Math.abs(share(rich.orders) - MIX[type] / 8)).toBeLessThanOrEqual(epsilon);
      expect(Math.abs(share(poor.orders) - share(rich.orders))).toBeLessThanOrEqual(2 * epsilon);
    }
    // Разные бюджеты расходуют общий PRNG по-разному; точное равенство нужно
    // только повтору того же сценария, включая его окончание и состояние мира.
    expect(play(false)).toEqual(poor);
    expect(play(true)).toEqual(rich);
  }, 300_000);
});
