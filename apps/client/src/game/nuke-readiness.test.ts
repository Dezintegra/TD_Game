import { describe, expect, it } from 'vitest';
import { NUKE_COOLDOWN_TICKS, TICKS_PER_SECOND, asTickNumber } from '@td/shared';
import { createWorld } from '@td/sim';
import type { PlayerState, WorldState } from '@td/sim';
import { isNukeReadyFor, nukeWaitSeconds } from './nuke-readiness.js';

const world = createWorld(777);

const base = world.players[0];
if (base === undefined) throw new Error('В мире нет игрока');

const at = (tick: number, readyAt: number): { world: WorldState; player: PlayerState } => ({
  world: { ...world, tick: asTickNumber(tick) },
  player: { ...base, nukeReadyAtTick: asTickNumber(readyAt) },
});

describe('остаток отката для плитки', () => {
  it('нетронутый матч показывает готовность, а не минуту ожидания', () => {
    const { world: now, player } = at(0, 0);

    expect(nukeWaitSeconds(now, player)).toBe(0);
    expect(isNukeReadyFor(now, player)).toBe(true);
  });

  it('сразу после пуска ждать целую минуту', () => {
    const { world: now, player } = at(0, NUKE_COOLDOWN_TICKS);

    expect(nukeWaitSeconds(now, player)).toBe(60);
    expect(isNukeReadyFor(now, player)).toBe(false);
  });

  it('к середине отката остаётся его половина', () => {
    const { world: now, player } = at(NUKE_COOLDOWN_TICKS / 2, NUKE_COOLDOWN_TICKS);

    expect(nukeWaitSeconds(now, player)).toBe(30);
  });

  it('неполная секунда округляется ВВЕРХ, а не к ближайшему', () => {
    // Ноль при неостывшей установке — обещание, которого интерфейс
    // не сдержит: игрок нажмёт, а ядро откажет. Один тик до готовности
    // обязан показываться как «1 с», а не как «0 с».
    const { world: now, player } = at(0, 1);

    expect(nukeWaitSeconds(now, player)).toBe(1);
    expect(isNukeReadyFor(now, player)).toBe(false);
  });

  it('ровно на тике готовности отсчёт кончается', () => {
    const { world: now, player } = at(NUKE_COOLDOWN_TICKS, NUKE_COOLDOWN_TICKS);

    expect(nukeWaitSeconds(now, player)).toBe(0);
    expect(isNukeReadyFor(now, player)).toBe(true);
  });

  it('давно истёкший откат не уходит в минус', () => {
    const { world: now, player } = at(TICKS_PER_SECOND * 600, 1);

    expect(nukeWaitSeconds(now, player)).toBe(0);
    expect(isNukeReadyFor(now, player)).toBe(true);
  });
});
