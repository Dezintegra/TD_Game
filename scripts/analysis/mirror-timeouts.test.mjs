import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { inspectSource, REQUIRED } from './mirror-timeouts.mjs';

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
