import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  inspectSource,
  REQUIRED,
  analyzeSide,
  aggregateRows,
  summary,
  analyzeDatabase,
} from './mirror-timeouts.mjs';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const options = {
  run: '33430184681',
  sha: 'historic',
  profile: 'baseline',
  seedStart: 1,
  matches: 60,
  ticksPerSecond: 30,
  capSeconds: 1200,
};
function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const [table, fields] of Object.entries(REQUIRED)) {
    db.exec(`CREATE TABLE "${table}" (${fields.split(' ').join(', ')})`);
  }
  const insert = db.prepare('INSERT INTO match VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (let seed = 1; seed <= 60; seed++)
    insert.run(
      `m${seed}`,
      seed,
      seed + 100,
      seed + 200,
      'baseline',
      'baseline',
      'historic',
      0,
      seed <= 11 ? 36000 : 10000,
      seed <= 11 ? null : seed % 2,
      seed <= 11 ? 'timeout' : 'base-destroyed',
    );
  return db;
}
function withFixture(check) {
  const db = fixture();
  try {
    check(db);
  } finally {
    db.close();
  }
}
describe('historical source', () => {
  it('checks exact 60-world inventory, censored durations and seeds', () =>
    withFixture((db) => {
      const result = inspectSource(db, options);
      expect(result.groups.timeout).toHaveLength(11);
      expect(result.groups['base-destroyed']).toHaveLength(49);
      expect(result.matches[0]).toMatchObject({
        world_seed: 1,
        ai_seed_0: 101,
        ai_seed_1: 201,
        winner: null,
        censored: true,
        seconds: 1200,
      });
    }));
  it.each([
    'UPDATE match SET world_seed=1 WHERE world_seed=60',
    "UPDATE match SET git_sha='other' WHERE world_seed=1",
    "UPDATE match SET profile_1='other' WHERE world_seed=1",
    'UPDATE match SET git_dirty=1 WHERE world_seed=1',
    'UPDATE match SET ticks=NULL, end_reason=NULL WHERE world_seed=1',
    'UPDATE match SET winner=0 WHERE world_seed=1',
    'UPDATE match SET winner=NULL WHERE world_seed=60',
    'UPDATE match SET ticks=35999 WHERE world_seed=1',
    "UPDATE match SET end_reason='unknown' WHERE world_seed=1",
    'ALTER TABLE sample DROP COLUMN base_hp',
  ])('rejects invalid source: %s', (sql) =>
    withFixture((db) => {
      db.exec(sql);
      expect(() => inspectSource(db, options)).toThrow();
    }),
  );
  it('reports empty comparison without inventing zero averages', () =>
    withFixture((db) => {
      db.exec("UPDATE match SET end_reason='timeout', ticks=36000, winner=NULL");
      expect(inspectSource(db, options).comparisonAvailable).toBe(false);
    }));
  it('permits a destruction at the cap', () =>
    withFixture((db) => {
      db.exec('UPDATE match SET ticks=36000 WHERE world_seed=60');
      expect(inspectSource(db, options).matches[59].censored).toBe(false);
    }));
});

const sample = (tick, values = {}) => ({
  tick,
  base_hp: 100,
  units_alive: 6,
  towers: 5,
  walls: 0,
  structures: 5,
  energy: 20,
  income_per_tick: 1,
  queue_len: 0,
  upgrade_total_level: 0,
  general_alive: 1,
  general_hp: 10,
  general_cell: 4,
  path_to_enemy: 1,
  ...values,
});
const sideData = (samples, decisions = [], attempts = [], commands = []) => ({
  sample: samples,
  decision: decisions,
  attempt: attempts,
  command: commands,
});
const interval = { kind: 'interval', start: 30, end: 90 };
const match = { ticks: 100 };
describe('matched windows and denominators', () => {
  it('keeps signed HP changes, historical first HP and building contraction', () => {
    const side = analyzeSide(
      sideData([sample(30), sample(60, { base_hp: 120 }), sample(90, { base_hp: 110, towers: 1 })]),
      match,
      0,
      interval,
      30,
    );
    expect(side.metrics.base_hp_net.value).toBe(10);
    expect(side.metrics.base_hp_relative_first.value).toBe(0.1);
    expect(side.metrics.towers_below_peak.value).toBe(4);
    expect(side.metrics.hp_decrease_steps.value).toBe(1);
    expect(side.lastHpDecreaseTick).toBe(90);
    expect(side.first).toEqual({ tick: 30, base_hp: 100 });
    expect(Object.keys(side.metrics).some((k) => k.includes('destroyed'))).toBe(false);
  });
  it('does not carry a completed match forward, even within one second', () => {
    const side = analyzeSide(sideData([sample(30), sample(60)]), { ticks: 89 }, 0, interval, 30);
    expect(side.endedEarly).toBe(true);
    expect(side.metrics.base_hp_end.value).toBeNull();
    expect(side.metrics.train_accepted.value).toBeNull();
  });
  it.each([
    [sample(30), sample(90)],
    [sample(30), sample(60), sample(60), sample(90)],
    [sample(30), sample(61), sample(90)],
  ])('makes incomplete or irregular grids unavailable', (...samples) => {
    const side = analyzeSide(sideData(samples), match, 0, interval, 30);
    expect(side.metrics.general_dead.value).toBeNull();
    expect(side.metrics.hp_decrease_steps.value).toBeNull();
    expect(side.metrics.base_hp_net.value).toBe(0);
  });
  it('does not count the shared boundary twice; zero denominator is missing', () => {
    const side = analyzeSide(
      sideData([sample(30, { general_alive: 0 }), sample(60), sample(90)]),
      match,
      0,
      interval,
      30,
    );
    expect(side.metrics.general_dead).toMatchObject({ numerator: 0, denominator: 2, value: 0 });
    expect(side.metrics.far_unescorted).toMatchObject({ denominator: 0, value: null });
  });
  it('does not multiply decisions or samples by attempts; accepted commands are separate', () => {
    const decisions = [30, 60, 90].map((tick) => ({
      tick,
      approach_shortest: 10,
      general_from_home: 6,
      nearby_units: tick === 60 ? 0 : 1,
      live_units: 2,
      impatient: 0,
    }));
    const attempts = [{ tick: 60, spending: 'train', result: 'bought', note: null }];
    const data = sideData([sample(30), sample(60), sample(90)], decisions, attempts, [
      { tick: 61, kind: 2, accepted: 1 },
      { tick: 91, kind: 2, accepted: 1 },
      { tick: 62, kind: 2, accepted: 0 },
    ]);
    const a = analyzeSide(data, match, 0, interval, 30);
    const b = analyzeSide({ ...data, attempt: [...attempts, ...attempts] }, match, 0, interval, 30);
    expect(a.metrics).toEqual(b.metrics);
    expect(a.metrics.bought_decisions.value).toBe(0.5);
    expect(a.metrics.train_accepted.value).toBe(1);
    expect(a.metrics.far_unescorted_with_army).toMatchObject({ numerator: 1, denominator: 2 });
    expect(b.productionAttempts['bought: none']).toBe(2);
  });
  it('weights matches equally, retains asymmetry and uses paired net endpoints', () => {
    const a = analyzeSide(
      sideData([
        sample(30),
        sample(60, { general_alive: 0 }),
        sample(90, { general_alive: 0, units_alive: 0 }),
      ]),
      match,
      0,
      interval,
      30,
    );
    const b = analyzeSide(sideData([sample(30), sample(60), sample(90)]), match, 1, interval, 30);
    const c = analyzeSide(
      sideData([sample(30), sample(60), sample(90), sample(120), sample(150)]),
      { ticks: 150 },
      0,
      { kind: 'lifetime' },
      30,
    );
    const missing = analyzeSide(sideData([sample(90, { base_hp: 20 })]), match, 1, interval, 30);
    const result = aggregateRows([{ sides: [a, b] }, { sides: [c, c] }, { sides: [a, missing] }]);
    expect(result.metrics.general_dead).toMatchObject({ n: 2, mean: 0.25, sides: 5 });
    expect(a.metrics.units_alive_net.value).toBe(-6);
    expect(b.metrics.units_alive_net.value).toBe(0);
    expect(result.metrics.base_hp_net).toMatchObject({ n: 2, mean: 0, excludedMatches: 1 });
    expect(summary([0, 10, 20, 30])).toEqual({ n: 4, mean: 15, q1: 7.5, median: 15, q3: 22.5 });
    expect(summary([]).mean).toBeNull();
  });
  it('requires first-window observations within the first second', () => {
    const side = analyzeSide(
      sideData([sample(60), sample(90)]),
      match,
      0,
      { ...interval, start: null },
      30,
    );
    expect(side.metrics.general_dead.value).toBeNull();
  });
  it('includes every match and requested window even with no samples', () =>
    withFixture((db) => {
      const result = analyzeDatabase(db, options);
      expect(result.rows).toHaveLength(60 * 9);
      expect(result.cohorts.timeout.windows['at-300s'].metrics.base_hp_end.n).toBe(0);
    }));
});
