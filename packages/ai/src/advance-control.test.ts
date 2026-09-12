import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttackStance, CommandKind, asPlayerId } from '@td/shared';
import type { PlayerId } from '@td/shared';
import { cellAt, createWorld } from '@td/sim';
import { createOpponent } from './opponent.js';
import type { DecisionRecord } from './observer.js';
import { pickVerdict } from './posture.js';
import type * as Posture from './posture.js';
import {
  ADVANCE_CONTROL_PROFILE,
  BASELINE_PROFILE,
  DEFAULT_PROFILE_ID,
  PROFILES,
  profileByName,
} from './profile.js';
import type { AiProfile } from './profile.js';

// Подменяем только вход выбора режима: потребители порога и траты настоящие.
vi.mock('./posture.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Posture>()),
  pickVerdict: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

const decide = (
  me: PlayerId,
  profile: AiProfile,
  stance: AttackStance,
  fraction: number | undefined,
) => {
  const initial = createWorld(1);
  const world = {
    ...initial,
    players: initial.players.map((player) => ({ ...player, stance, energy: 10000 })),
  };
  const general = world.generals.find((entry) => entry.owner === me);
  if (general === undefined) throw new Error('Для решения нужен живой генерал');
  vi.mocked(pickVerdict).mockReturnValue(
    fraction === undefined
      ? undefined
      : {
          frontier: { fraction, cell: cellAt(general.position), coverage: 0 },
          score: 0,
          gain: 0,
          risk: 0,
          deathChance: 0,
        },
  );
  const records: DecisionRecord[] = [];
  const commands = createOpponent(me, 1, profile, (record) => records.push(record)).decide(world);
  expect(pickVerdict).toHaveBeenCalled();
  expect(records).toHaveLength(1);
  return {
    commands,
    record: records[0]!,
    stances: commands.filter((c) => c.kind === CommandKind.SetStance),
  };
};

describe('контроль общего порога наступления', () => {
  it('отличается от baseline только идентификатором и порогом 2', () => {
    expect(ADVANCE_CONTROL_PROFILE.id).toBe('advance-control-2026-08');
    expect(ADVANCE_CONTROL_PROFILE.movement.advanceFraction).toBe(2);
    expect(ADVANCE_CONTROL_PROFILE.movement.advanceFraction).not.toBe(
      BASELINE_PROFILE.movement.advanceFraction,
    );
    expect({
      ...ADVANCE_CONTROL_PROFILE,
      id: BASELINE_PROFILE.id,
      movement: {
        ...ADVANCE_CONTROL_PROFILE.movement,
        advanceFraction: BASELINE_PROFILE.movement.advanceFraction,
      },
    }).toEqual(BASELINE_PROFILE);
    expect(PROFILES[ADVANCE_CONTROL_PROFILE.id]).toBe(ADVANCE_CONTROL_PROFILE);
    expect(profileByName(ADVANCE_CONTROL_PROFILE.id)).toBe(ADVANCE_CONTROL_PROFILE);
    expect(DEFAULT_PROFILE_ID).toBe('baseline-2026-08');
    expect(profileByName(DEFAULT_PROFILE_ID)).toBe(BASELINE_PROFILE);
  });

  it('глубоко заморожен и не позволяет повредить baseline', () => {
    const before = structuredClone(BASELINE_PROFILE);
    const assertFrozen = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) assertFrozen(child);
    };
    assertFrozen(ADVANCE_CONTROL_PROFILE);
    expect(() => Object.assign(ADVANCE_CONTROL_PROFILE, { id: 'changed' })).toThrow(TypeError);
    expect(() => Object.assign(ADVANCE_CONTROL_PROFILE.movement, { advanceFraction: 0 })).toThrow(
      TypeError,
    );
    expect(ADVANCE_CONTROL_PROFILE.id).toBe('advance-control-2026-08');
    expect(ADVANCE_CONTROL_PROFILE.movement.advanceFraction).toBe(2);
    expect(BASELINE_PROFILE).toEqual(before);
  });

  it('все реальные доли рубежей конечны и ниже порога', () => {
    expect(ADVANCE_CONTROL_PROFILE.posture.frontierFractions.length).toBeGreaterThan(0);
    for (const fraction of ADVANCE_CONTROL_PROFILE.posture.frontierFractions) {
      expect(Number.isFinite(fraction)).toBe(true);
      expect(fraction).toBeLessThan(ADVANCE_CONTROL_PROFILE.movement.advanceFraction);
    }
  });

  describe.each([asPlayerId(0), asPlayerId(1)])('сторона %s', (me) => {
    it.each([...BASELINE_PROFILE.posture.frontierFractions, undefined])(
      'выбирает Бой на рубеже %s',
      (fraction) => {
        const profile = profileByName('advance-control-2026-08');
        const changed = decide(me, profile, AttackStance.Breakthrough, fraction);
        expect(changed.stances).toEqual([
          expect.objectContaining({ player: me, stance: AttackStance.Engage }),
        ]);
        expect(changed.record.escorting).toBe(false);
        const unchanged = decide(me, profile, AttackStance.Engage, fraction);
        expect(unchanged.stances).toHaveLength(0);
        expect(unchanged.record.escorting).toBe(false);
      },
    );

    it('baseline включает Прорыв и сопровождение на 0,75, контроль сохраняет обычные траты', () => {
      const baseline = decide(me, BASELINE_PROFILE, AttackStance.Engage, 0.75);
      const control = decide(me, ADVANCE_CONTROL_PROFILE, AttackStance.Engage, 0.75);
      const home = decide(me, ADVANCE_CONTROL_PROFILE, AttackStance.Engage, 0);
      expect(baseline.stances).toEqual([
        expect.objectContaining({ player: me, stance: AttackStance.Breakthrough }),
      ]);
      expect(baseline.record.nearbyUnits).toBe(0);
      expect(baseline.record.escorting).toBe(true);
      expect(baseline.record.spendOrder).toEqual(BASELINE_PROFILE.escort.spend);
      expect(control.stances).toHaveLength(0);
      expect(control.record.nearbyUnits).toBe(0);
      expect(control.record.escorting).toBe(false);
      expect(control.record.spendOrder).toEqual(home.record.spendOrder);
      expect(control.record.spendOrder).not.toEqual(baseline.record.spendOrder);
      expect(control.record.pushed).toBe(false);
      expect(control.record.struck).toBe(false);
      // Покупка состоялась: пределы проверяются на действующем решении.
      expect(control.record.attempts.some((attempt) => attempt.result === 'bought')).toBe(true);
      expect(baseline.commands.filter((c) => c.kind === CommandKind.TrainUnit)).toHaveLength(1);
      expect(
        control.commands.filter((c) => c.kind === CommandKind.TrainUnit).length,
      ).toBeLessThanOrEqual(1);
      expect(
        control.commands.filter((c) => c.kind === CommandKind.BuyUpgrade).length,
      ).toBeLessThanOrEqual(1);
    });
  });
});
