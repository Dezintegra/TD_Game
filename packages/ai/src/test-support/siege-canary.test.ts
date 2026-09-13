import { describe, expect, it, vi } from 'vitest';
import { asPlayerId, asTickNumber, CommandKind, UnitType } from '@td/shared';
import type { Command } from '@td/shared';
import {
  SIEGE_HORIZON_TICKS,
  SIEGE_SEEDS,
  evaluateSiegeCanary,
  firstSiegeOrderTick,
  siegeStopReason,
} from './siege-canary.js';
import type { SiegeResult } from './siege-canary.js';

const AI = asPlayerId(0);
const RIVAL = asPlayerId(1);
const sample = (successes: number): SiegeResult[] =>
  SIEGE_SEEDS.map((seed, index) => ({
    seed,
    stopTick: index < successes ? 11 : SIEGE_HORIZON_TICKS,
    reason: index < successes ? 'tesla-order' : 'horizon',
    winner: null,
    firstOrderTick: index < successes ? 10 : null,
  }));
const order = (tick: number, player = AI): Command => ({
  kind: CommandKind.TrainUnit,
  unitType: UnitType.Tesla,
  player,
  tick: asTickNumber(tick),
});

describe('осадное большинство', () => {
  it.each([
    [3, true],
    [2, false],
    [0, false],
    [5, true],
  ] as const)('%i из пяти: %s', (count, passed) => {
    expect(evaluateSiegeCanary(sample(count))).toMatchObject({ successes: count, passed });
  });

  it('не исключает поражения и исчерпавшие окно миры', () => {
    const results = sample(2);
    results[2] = {
      seed: 99,
      stopTick: 100,
      reason: 'match-ended',
      winner: RIVAL,
      firstOrderTick: null,
    };
    expect(evaluateSiegeCanary(results)).toMatchObject({ passed: false, successes: 2 });
    expect(evaluateSiegeCanary(results).diagnostic).toContain('2/5');
  });

  it('отвергает пропуски, повторы, посторонний seed и лишние результаты', () => {
    const full = sample(5);
    const first = full[0]!;
    for (const results of [
      full.slice(0, 3),
      [],
      [...full.slice(0, 4), first],
      [...full.slice(0, 4), { ...first, seed: 123 }],
      [...full, first],
    ]) {
      expect(evaluateSiegeCanary(results).passed).toBe(false);
      expect(evaluateSiegeCanary(results).diagnostic).toContain('Invalid seed sample');
    }
  });

  it('теряет успех при выключении всех событий', () => {
    const results = sample(3);
    expect(evaluateSiegeCanary(results).passed).toBe(true);
    expect(
      evaluateSiegeCanary(
        results.map((result) => ({
          ...result,
          firstOrderTick: null,
          reason: 'horizon',
          stopTick: SIEGE_HORIZON_TICKS,
        })),
      ).passed,
    ).toBe(false);
  });

  it('показывает все миры, причины, null, тики и порог', () => {
    const results = sample(3);
    results[3] = {
      seed: 2026,
      stopTick: 42,
      reason: 'match-ended',
      winner: RIVAL,
      firstOrderTick: null,
    };
    const { diagnostic } = evaluateSiegeCanary(results);
    expect(diagnostic).toContain(
      `3/5; required: 3/5; horizon: 960s (${SIEGE_HORIZON_TICKS} ticks)`,
    );
    for (const result of results) {
      expect(diagnostic).toContain(
        `${result.seed} | ${result.stopTick} | ${result.reason} | ${result.winner} | ${result.firstOrderTick}`,
      );
    }
  });
});

describe('границы осадного события', () => {
  it('считает только команду Теслы своей стороны, включая тик ноль', () => {
    expect(firstSiegeOrderTick([order(0)], AI)).toBe(0);
    expect(firstSiegeOrderTick([order(1, RIVAL)], AI)).toBeNull();
    expect(
      firstSiegeOrderTick(
        [{ ...order(1), kind: CommandKind.TrainUnit, unitType: UnitType.Assault }],
        AI,
      ),
    ).toBeNull();
    // Намерение observer не попадает в поток команд и не даёт события.
    const observation = { commands: [], intendedUnit: UnitType.Tesla };
    expect(firstSiegeOrderTick(observation.commands, AI)).toBeNull();
    expect(firstSiegeOrderTick([order(2), order(3)], AI)).toBe(2);
  });

  it('засчитывает последнее решение и сохраняет приоритет заказа над концом', () => {
    const tick = SIEGE_HORIZON_TICKS - 1;
    expect(siegeStopReason(tick, null, null)).toBeNull();
    const firstOrderTick = firstSiegeOrderTick([order(tick)], AI);
    const result: SiegeResult = {
      seed: 7,
      stopTick: tick + 1,
      winner: RIVAL,
      firstOrderTick,
      reason: siegeStopReason(tick + 1, RIVAL, firstOrderTick)!,
    };
    expect(result).toMatchObject({
      reason: 'tesla-order',
      winner: RIVAL,
      firstOrderTick: tick,
      stopTick: SIEGE_HORIZON_TICKS,
    });
  });

  it.each([
    [SIEGE_HORIZON_TICKS, null, 'horizon'],
    [SIEGE_HORIZON_TICKS + 1, null, 'horizon'],
    [10, RIVAL, 'match-ended'],
    [10, AI, 'match-ended'],
    [SIEGE_HORIZON_TICKS, RIVAL, 'match-ended'],
  ] as const)('не разрешает решение при остановке %i, %s', (tick, winner, reason) => {
    const decide = vi.fn();
    const stop = siegeStopReason(tick, winner, null);
    if (stop === null) decide();
    expect(stop).toBe(reason);
    expect(decide).not.toHaveBeenCalled();
  });
});
