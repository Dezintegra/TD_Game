import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
  linkSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  analyzeDatabases,
  MATCH_FIELDS,
  METRICS,
  validateConfig,
  parseArgs,
} from './paired-cutoffs.mjs';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
function removeFixture(path, remove = unlinkSync) {
  try {
    remove(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const source = {
  db: 'unused.sqlite',
  run: 'run-1',
  sha: 'historic',
  profiles: ['baseline', 'siege'],
  seedStart: 1,
  matches: 3,
  ticksPerSecond: 30,
  capSeconds: 1200,
};
const config = () => ({ before: { ...source }, after: { ...source, run: 'run-2', sha: 'new' } });
function fixture(options, prefix) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    `CREATE TABLE match (${MATCH_FIELDS.join(', ')}); CREATE TABLE sample (match_id, tick, player, ${Object.keys(METRICS).join(', ')}); CREATE INDEX sample_by_match ON sample (match_id, player, tick)`,
  );
  const insert = db.prepare(`INSERT INTO match VALUES (${MATCH_FIELDS.map(() => '?').join(', ')})`);
  for (let seed = options.seedStart + options.matches - 1; seed >= options.seedStart; seed--) {
    insert.run(
      `${prefix}${seed}`,
      seed,
      seed + 100,
      seed + 200,
      ...options.profiles,
      options.sha,
      0,
      36000,
      null,
      'timeout',
    );
  }
  return db;
}
function sample(db, id, player, tick, overrides = {}) {
  const values = Object.keys(METRICS).map((key) =>
    Object.hasOwn(overrides, key) ? overrides[key] : 1,
  );
  db.prepare(`INSERT INTO sample VALUES (?, ?, ?, ${values.map(() => '?').join(', ')})`).run(
    id,
    tick,
    player,
    ...values,
  );
}
function withPair(check, cfg = config()) {
  const a = fixture(cfg.before, 'a');
  const b = fixture(cfg.after, 'b');
  try {
    check(a, b, cfg);
  } finally {
    a.close();
    b.close();
  }
}
function reversal(a, b) {
  a.exec("UPDATE match SET ticks=6000, winner=0, end_reason='base-destroyed' WHERE world_seed=3");
  b.exec("UPDATE match SET ticks=6000, winner=1, end_reason='base-destroyed' WHERE world_seed=2");
  sample(a, 'a1', 0, 9000, { towers: 10 });
  sample(a, 'a2', 0, 9000, { towers: 100 });
  sample(b, 'b1', 0, 9000, { towers: 11 });
  sample(b, 'b3', 0, 9000, { towers: 0 });
}
const metric = (result, seconds = 300, name = 'towers', side = 0) =>
  result.cutoffs
    .find((c) => c.seconds === seconds)
    .metrics.find((m) => m.metric === name && m.side === side);

describe('paired cutoff populations', () => {
  it('reverses the independent 55 to 5.5 decline with the actual common world: 10 to 11', () =>
    withPair((a, b, cfg) => {
      reversal(a, b);
      expect(a.prepare('SELECT avg(towers) AS value FROM sample').get().value).toBe(55);
      expect(b.prepare('SELECT avg(towers) AS value FROM sample').get().value).toBe(5.5);
      const result = analyzeDatabases(a, b, cfg);
      expect(result.cutoffs[0]).toMatchObject({
        survivorBefore: 2,
        survivorAfter: 2,
        commonSurvivors: 1,
      });
      expect(metric(result)).toMatchObject({ n: 1, meanA: 10, meanB: 11, meanDelta: 1 });
      expect(metric(result).pairs[0]).toMatchObject({
        world_seed: 1,
        matchIds: { before: 'a1', after: 'b1' },
        ticks: { before: [9000], after: [9000] },
      });
      expect(result.inventory.map((p) => p.world_seed)).toEqual([1, 2, 3]);
    }));
  it('rebuilds intersections and keeps both early-ending reasons', () =>
    withPair((a, b, cfg) => {
      a.exec(
        "UPDATE match SET ticks=9000, winner=0, end_reason='base-destroyed' WHERE world_seed=1",
      );
      b.exec(
        "UPDATE match SET ticks=9000, winner=1, end_reason='base-destroyed' WHERE world_seed=1",
      );
      const result = analyzeDatabases(a, b, cfg);
      expect(result.cutoffs.map((c) => c.commonSurvivors)).toEqual([3, 2]);
      expect(result.cutoffs[1].excluded[0]).toEqual({
        world_seed: 1,
        reasons: ['before-ended-before-cutoff', 'after-ended-before-cutoff'],
      });
    }));
  it('lists unpaired worlds and AI mismatches without matching by row position', () => {
    const cfg = config();
    cfg.after.seedStart = 2;
    withPair((a, b) => {
      b.exec('UPDATE match SET ai_seed_1=999 WHERE world_seed=2');
      const result = analyzeDatabases(a, b, cfg);
      expect(result.inventory.map((p) => [p.world_seed, p.reason])).toEqual([
        [1, 'before-only'],
        [2, 'ai-seed-mismatch'],
        [3, null],
        [4, 'after-only'],
      ]);
      expect(result.cutoffs[0].commonSurvivors).toBe(1);
    }, cfg);
  });
  it('includes footer at cutoff and exactly one-second-old observations, never future rows', () =>
    withPair((a, b, cfg) => {
      for (const [db, id] of [
        [a, 'a1'],
        [b, 'b1'],
      ]) {
        db.exec(
          `UPDATE match SET ticks=9000, winner=0, end_reason='base-destroyed' WHERE match_id='${id}'`,
        );
        sample(db, id, 0, 8970, { towers: 0 });
        sample(db, id, 0, 9001, { towers: 999 });
      }
      expect(metric(analyzeDatabases(a, b, cfg))).toMatchObject({
        n: 1,
        meanA: 0,
        meanB: 0,
        meanDelta: 0,
      });
      a.exec('UPDATE sample SET tick=8969 WHERE tick=8970');
      expect(metric(analyzeDatabases(a, b, cfg))).toMatchObject({
        n: 0,
        meanA: null,
        meanB: null,
        meanDelta: null,
      });
    }));
  it('does not fall back from null, text, infinity or duplicate samples', () =>
    withPair((a, b, cfg) => {
      sample(a, 'a1', 0, 8970, { towers: 100 });
      sample(a, 'a1', 0, 9000, { towers: null });
      sample(b, 'b1', 0, 9000, { towers: 0 });
      expect(metric(analyzeDatabases(a, b, cfg))).toMatchObject({ n: 0 });
      expect(metric(analyzeDatabases(a, b, cfg), 300, 'units_alive').n).toBe(1);
      for (const value of ['bad', Infinity]) {
        a.prepare('UPDATE sample SET towers=? WHERE tick=9000').run(value);
        expect(metric(analyzeDatabases(a, b, cfg)).n).toBe(0);
      }
      sample(b, 'b1', 0, 9000);
      const result = analyzeDatabases(a, b, cfg);
      expect(metric(result, 300, 'units_alive').n).toBe(0);
      expect(result.cutoffs[0].worlds[0].after[0]).toMatchObject({
        tick: 9000,
        selectedRows: 2,
        reason: 'duplicate-sample',
      });
    }));
  it('missing metric columns preserve other measurements', () =>
    withPair((a, b, cfg) => {
      sample(a, 'a1', 0, 9000);
      sample(b, 'b1', 0, 9000);
      b.exec('ALTER TABLE sample DROP COLUMN towers');
      const result = analyzeDatabases(a, b, cfg);
      expect(metric(result).n).toBe(0);
      expect(metric(result).excluded[0].reasons).toContainEqual({
        source: 'after',
        player: 0,
        reason: 'missing-column',
      });
      expect(metric(result, 300, 'units_alive').n).toBe(1);
    }));
  it('both uses equal world weights and requires all four values', () =>
    withPair((a, b, cfg) => {
      for (const [db, prefix, shift] of [
        [a, 'a', 0],
        [b, 'b', 2],
      ]) {
        sample(db, `${prefix}1`, 0, 9000, { towers: shift });
        sample(db, `${prefix}1`, 1, 9000, { towers: 10 + shift });
        sample(db, `${prefix}2`, 0, 9000, { towers: 10 + shift });
        sample(db, `${prefix}2`, 1, 9000, { towers: 30 + shift });
        sample(db, `${prefix}3`, 0, 9000, { towers: 1000 });
      }
      const result = analyzeDatabases(a, b, cfg);
      expect(metric(result, 300, 'towers', 'both')).toMatchObject({
        n: 2,
        meanA: 12.5,
        meanB: 14.5,
        meanDelta: 2,
      });
      expect(metric(result).n).toBe(3);
      expect(metric(result, 300, 'towers', 1).n).toBe(2);
    }));
  it('returns explicit empty results past both caps', () =>
    withPair((a, b, cfg) => {
      cfg.cutoffsSeconds = [1201];
      const result = analyzeDatabases(a, b, cfg);
      expect(result.cutoffs[0]).toMatchObject({
        commonSurvivors: 0,
        survivorBefore: 0,
        survivorAfter: 0,
      });
      expect(metric(result, 1201)).toMatchObject({
        n: 0,
        meanA: null,
        meanB: null,
        meanDelta: null,
        reason: 'нет общих доживших миров',
      });
    }));
});

describe('paired cutoff CLI', () => {
  it.each([
    [],
    ['--config'],
    ['--unknown', 'x'],
    ['--config', 'x', '--config', 'y'],
    ['--config', 'x', '--out', 'x', '--out', 'y'],
  ])('rejects malformed arguments %j', (...args) => {
    expect(() => parseArgs(args)).toThrow();
  });
  it('reports the known pair and n, preserves inputs, rejects aliases and imports without action', () => {
    const root = fileURLToPath(new URL('../../.matchlog/', import.meta.url));
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, '0096-test-'));
    const paths = {
      a: join(dir, 'a.sqlite'),
      b: join(dir, 'b.sqlite'),
      config: join(dir, 'config.json'),
      out: join(dir, 'out.json'),
      importer: join(dir, 'import.mjs'),
      link: join(dir, 'alias'),
      junction: join(dir, 'dir-alias'),
    };
    const script = fileURLToPath(new URL('./paired-cutoffs.mjs', import.meta.url));
    const run = (...args) =>
      spawnSync(process.execPath, [script, '--config', paths.config, ...args], {
        encoding: 'utf8',
      });
    const cfg = config();
    cfg.before.db = 'a.sqlite';
    cfg.after.db = 'b.sqlite';
    const saveConfig = () => writeFileSync(paths.config, JSON.stringify(cfg));
    const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
    try {
      withPair((a, b) => {
        reversal(a, b);
        a.prepare('VACUUM INTO ?').run(paths.a);
        b.prepare('VACUUM INTO ?').run(paths.b);
      }, cfg);
      saveConfig();
      const originals = [paths.a, paths.b, paths.config].map(hash);
      const markdown = run();
      expect(markdown.status).toBe(0);
      expect(markdown.stdout).toContain(
        '| 300 | towers | объекты, включая недострой | 0 | 2 | 2 | 1 | 1 | 10 | 11 | 1 |',
      );
      expect(markdown.stdout).toContain(
        'Внешние сведения (не проверены по SQLite): run, ticksPerSecond, capSeconds',
      );
      expect(markdown.stdout).toContain('Проверены по SQLite: sha, profiles, seedStart, matches');
      expect(markdown.stdout).toContain('before-ended-before-cutoff');
      expect(markdown.stdout).toContain('after/1: missing-or-stale-sample');
      expect(markdown.stdout).toContain('не доказывает причинность');
      expect(run().stdout).toBe(markdown.stdout);
      expect(run('--out', paths.out).status).toBe(0);
      const jsonText = readFileSync(paths.out, 'utf8');
      const result = JSON.parse(jsonText);
      expect(result.interpretationLimits).toContain('только к совместно дожившим мирам');
      expect(result.interpretationLimits).toContain('не ко всей пачке');
      expect(result.interpretationLimits).toContain('сам по себе не доказывает причинность');
      expect(markdown.stdout).toContain(result.interpretationLimits);
      expect(metric(result)).toMatchObject({ n: 1, meanA: 10, meanB: 11, meanDelta: 1 });
      expect(result.sources.before.databaseSha256).toBe(originals[0]);
      expect(result.sources.after.databaseSha256).toBe(originals[1]);
      expect(result.sources.before.db).toBe(paths.a);
      expect(run('--out', paths.out).status).toBe(0);
      expect(readFileSync(paths.out, 'utf8')).toBe(jsonText);
      for (const input of [paths.a, paths.b, paths.config]) {
        for (const target of [input, join(dir, '.', input.slice(dir.length + 1))]) {
          const denied = run('--out', target);
          expect(denied.status).toBe(1);
          expect(denied.stdout).toBe('');
          expect(denied.stderr).toContain('must not overwrite');
        }
        linkSync(input, paths.link);
        expect(run('--out', paths.link).stderr).toContain('must not overwrite');
        unlinkSync(paths.link);
      }
      // Junction на Windows не требует права создания символьных ссылок на файлы.
      symlinkSync(dir, paths.junction, process.platform === 'win32' ? 'junction' : 'dir');
      expect(run('--out', join(paths.junction, 'a.sqlite')).stderr).toContain('must not overwrite');
      if (process.platform === 'win32') rmdirSync(paths.junction);
      else unlinkSync(paths.junction);
      expect([paths.a, paths.b, paths.config].map(hash)).toEqual(originals);
      writeFileSync(
        paths.importer,
        `import ${JSON.stringify(new URL('./paired-cutoffs.mjs', import.meta.url).href)};\n`,
      );
      const imported = spawnSync(
        process.execPath,
        [paths.importer, '--config', 'missing.json', '--out', paths.a],
        { encoding: 'utf8' },
      );
      expect(imported.status).toBe(0);
      expect(imported.stdout).toBe('');
      expect(imported.stderr).not.toContain('paired-cutoffs:');
      expect(hash(paths.a)).toBe(originals[0]);
      cfg.cutoffsSeconds = [1201];
      saveConfig();
      expect(run().stdout).toContain('нет общих доживших миров');
      expect(run('--out', paths.out).status).toBe(0);
      expect(metric(JSON.parse(readFileSync(paths.out, 'utf8')), 1201)).toMatchObject({
        n: 0,
        meanA: null,
        meanB: null,
        meanDelta: null,
      });
      cfg.before.sha = 'unexpected';
      saveConfig();
      const invalid = run();
      expect(invalid.status).toBe(1);
      expect(invalid.stdout).toBe('');
      expect(invalid.stderr).toContain('before:');
      cfg.before.sha = 'historic';
      cfg.cutoffsSeconds = [300];
      cfg.after = { ...cfg.before };
      saveConfig();
      expect(run('--out', paths.out).status).toBe(0);
      expect(metric(JSON.parse(readFileSync(paths.out, 'utf8')))).toMatchObject({
        n: 2,
        meanDelta: 0,
      });
      expect([paths.a, paths.b].map(hash)).toEqual(originals.slice(0, 2));
    } finally {
      removeFixture(paths.junction, process.platform === 'win32' ? rmdirSync : unlinkSync);
      for (const key of ['link', 'a', 'b', 'config', 'out', 'importer']) {
        removeFixture(paths[key]);
      }
      rmdirSync(dir);
    }
  });
});

describe('source validation', () => {
  it.each([
    'UPDATE match SET world_seed=1 WHERE world_seed=3',
    'DELETE FROM match WHERE world_seed=1',
    'UPDATE match SET world_seed=4 WHERE world_seed=3',
    'UPDATE match SET match_id=NULL WHERE world_seed=1',
    'UPDATE match SET ai_seed_0=NULL WHERE world_seed=1',
    'UPDATE match SET ai_seed_1=1.5 WHERE world_seed=1',
    "UPDATE match SET git_sha='wrong'",
    'UPDATE match SET git_dirty=1',
    "UPDATE match SET profile_1='wrong'",
    'UPDATE match SET end_reason=NULL',
    'UPDATE match SET ticks=NULL',
    'UPDATE match SET ticks=0',
    'UPDATE match SET ticks=36001',
    'UPDATE match SET ticks=35999',
    'UPDATE match SET winner=1',
    "UPDATE match SET end_reason='base-destroyed'",
    'ALTER TABLE match DROP COLUMN ai_seed_0',
    'DROP INDEX sample_by_match; ALTER TABLE sample DROP COLUMN player',
  ])('rejects corrupt input with source label: %s', (sql) =>
    withPair((a, b, cfg) => {
      a.exec(sql);
      expect(() => analyzeDatabases(a, b, cfg)).toThrow('before:');
    }),
  );
  it('rejects incompatible and malformed passports', () => {
    for (const patch of [
      { profiles: ['siege', 'baseline'] },
      { ticksPerSecond: 60 },
      { matches: 0 },
      { seedStart: -1 },
      { capSeconds: Number.MAX_SAFE_INTEGER },
      { extra: true },
      { run: '' },
      { profiles: ['baseline'] },
    ]) {
      const cfg = config();
      Object.assign(cfg.after, patch);
      expect(() => validateConfig(cfg)).toThrow();
    }
    for (const cutoffsSeconds of [[], [300, 300], [0], [1.5], [Number.MAX_SAFE_INTEGER], null]) {
      const cfg = { ...config(), cutoffsSeconds };
      expect(() => validateConfig(cfg)).toThrow();
    }
    expect(validateConfig({ ...config(), cutoffsSeconds: [600, 300] }).cutoffsSeconds).toEqual([
      300, 600,
    ]);
    expect(() => validateConfig({ ...config(), unknown: 1 })).toThrow();
  });
});
