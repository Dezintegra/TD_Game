import { CommandKind, TICKS_PER_SECOND, UnitType } from '@td/shared';
import type { Command, PlayerId } from '@td/shared';

// Вся историческая выборка, включая неудачные миры: отбор по успеху скрывает регрессию.
export const SIEGE_SEEDS = [4242, 7, 99, 2026, 31337] as const;
export const SIEGE_HORIZON_SECONDS = 960;
export const SIEGE_HORIZON_TICKS = SIEGE_HORIZON_SECONDS * TICKS_PER_SECOND;
export const SIEGE_REQUIRED_ORDERS = 3;

export interface SiegeResult {
  readonly seed: number;
  readonly stopTick: number;
  readonly reason: 'tesla-order' | 'match-ended' | 'horizon';
  readonly winner: PlayerId | null;
  readonly firstOrderTick: number | null;
}

export const siegeStopReason = (
  tick: number,
  winner: PlayerId | null,
  firstOrderTick: number | null,
): SiegeResult['reason'] | null => {
  // Заказ на завершающем шаге остаётся событием, даже если база уже снесена.
  if (firstOrderTick !== null) return 'tesla-order';
  if (winner !== null) return 'match-ended';
  return tick >= SIEGE_HORIZON_TICKS ? 'horizon' : null;
};

export const firstSiegeOrderTick = (
  commands: readonly Command[],
  player: PlayerId,
): number | null =>
  commands.find(
    (command) =>
      command.player === player &&
      command.kind === CommandKind.TrainUnit &&
      command.unitType === UnitType.Tesla,
  )?.tick ?? null;

export const evaluateSiegeCanary = (results: readonly SiegeResult[]) => {
  const seeds = new Set(results.map((result) => result.seed));
  const validSample =
    results.length === SIEGE_SEEDS.length &&
    seeds.size === SIEGE_SEEDS.length &&
    SIEGE_SEEDS.every((seed) => seeds.has(seed));
  const successes = results.filter((result) => result.firstOrderTick !== null).length;
  const diagnostic = [
    `Tesla orders: ${successes}/${SIEGE_SEEDS.length}; required: ${SIEGE_REQUIRED_ORDERS}/${SIEGE_SEEDS.length}; horizon: ${SIEGE_HORIZON_SECONDS}s (${SIEGE_HORIZON_TICKS} ticks)`,
    ...(validSample ? [] : ['Invalid seed sample: expected ' + SIEGE_SEEDS.join(', ')]),
    'seed | stopTick | reason | winner | firstOrderTick',
    ...results.map(
      (result) =>
        `${result.seed} | ${result.stopTick} | ${result.reason} | ${result.winner} | ${result.firstOrderTick}`,
    ),
  ].join('\n');
  return { passed: validSample && successes >= SIEGE_REQUIRED_ORDERS, successes, diagnostic };
};
