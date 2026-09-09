import { afterEach, describe, expect, it } from 'vitest';
import { AttackStance, applyRuleTuning, resetRuleTuning, UNIT_STATS, UnitType } from '@td/shared';
import { step } from './step.js';
import type { CombatObservation } from './combat-observer.js';
import { ASSAULT_SCENE_CAP, assaultSceneWorld } from './assault-range-fixtures.js';
import type { AssaultScene } from './assault-range-fixtures.js';

afterEach(resetRuleTuning);
const basic: AssaultScene = {
  name: 'cadence',
  assigned: true,
  stance: AttackStance.Engage,
  reply: false,
  count: 1,
  start: 19,
  expected: 'tower-destroyed',
};
const scenes: AssaultScene[] = [
  basic,
  ...[AttackStance.Engage, AttackStance.Breakthrough].flatMap((stance) => [
    { ...basic, name: `approach-${stance}`, stance, start: 12 },
    {
      ...basic,
      name: `encounter-${stance}`,
      stance,
      assigned: false,
      start: 12,
      expected: stance === AttackStance.Engage ? ('tower-destroyed' as const) : ('cap' as const),
    },
  ]),
  { ...basic, name: 'reply-single', start: 12, reply: true, expected: 'attacker-died' },
  { ...basic, name: 'reply-eight', start: 12, reply: true, count: 8 },
  { ...basic, name: 'distraction', assigned: false, distraction: true, start: 17, expected: 'cap' },
  { ...basic, name: 'distraction-assigned', distraction: true, start: 19 },
  { ...basic, name: 'wall-bypass', start: 17, wall: 'bypass' },
  { ...basic, name: 'wall-breach', start: 17, wall: 'breach' },
  { ...basic, name: 'crowd', start: 17, count: 8, crowd: true },
];

const validateCadence = (hits: number[], outcome: string, cooldown: number) => {
  expect(outcome).toBe('tower-destroyed');
  expect(hits).toHaveLength(20);
  expect(hits.at(-1)! - hits[0]!).toBe(19 * cooldown);
};

describe('парные микросцены дальности Assault', () => {
  it.each(scenes)('$name', (scene) => {
    for (const range of [0.5, 1]) {
      resetRuleTuning();
      applyRuleTuning({ assaultRange: range });
      let world = assaultSceneWorld(scene);
      const events: CombatObservation[] = [];
      let outcome = 'cap';
      for (let i = 0; i < ASSAULT_SCENE_CAP; i++) {
        world = step(world, [], (e) => events.push(e));
        if (!world.structures.some((s) => s.id === 10)) {
          outcome = 'tower-destroyed';
          break;
        }
        if (!world.units.some((u) => u.owner === 0)) {
          outcome = 'attacker-died';
          break;
        }
      }
      expect(outcome).toBe(scene.expected);
      const shots = events.filter((e) => e.type === 'assault-shot' && e.shooter.owner === 0);
      const hits = shots
        .filter((e) => e.target.kind === 'structure' && e.target.id === 10)
        .map((e) => e.tick);
      const stops = events.filter(
        (e) => e.type === 'assault-motion' && e.unit.owner === 0 && e.witness?.id === 10,
      );
      expect(shots.length).toBeGreaterThan(0);
      if (scene.name === 'cadence')
        validateCadence(hits, outcome, UNIT_STATS[UnitType.Assault].cooldownTicks);
      if (scene.name.startsWith('approach-')) {
        expect(stops.length).toBeGreaterThan(0);
        const distance = stops[0]!.distanceSquared!;
        const stats = UNIT_STATS[UnitType.Assault];
        expect(distance).toBeLessThanOrEqual(stats.range ** 2);
        expect(distance).toBeGreaterThanOrEqual((stats.range - stats.speed) ** 2);
      }
      if (scene.name === 'distraction') expect(hits).toHaveLength(0);
      if (scene.name === 'distraction-assigned') expect(hits.length).toBeGreaterThan(0);
      console.log(
        JSON.stringify({
          scene: scene.name,
          rangeCells: range * 4,
          outcome,
          ticks: world.tick,
          firstHit: hits[0] ?? null,
          firstStop: stops[0]?.tick ?? null,
          hits: hits.length,
          otherShots: shots.length - hits.length,
          demolitionTicks:
            outcome === 'tower-destroyed' && hits.length ? hits.at(-1)! - hits[0]! : null,
        }),
      );
    }
  });
  it('контроль отвергает пропуск попадания и подмену исхода', () => {
    const hits = Array.from({ length: 20 }, (_, i) => 1 + i * 30);
    validateCadence(hits, 'tower-destroyed', 30);
    expect(() => validateCadence(hits.slice(1), 'tower-destroyed', 30)).toThrow();
    expect(() => validateCadence(hits, 'cap', 30)).toThrow();
    expect(() =>
      validateCadence(
        hits.filter((_t, i) => i !== 5),
        'tower-destroyed',
        30,
      ),
    ).toThrow();
  });
});
