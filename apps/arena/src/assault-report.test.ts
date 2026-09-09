import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ruleTuning } from '@td/shared';
import { createLogWriter } from './log.js';
import { ingestFile, openDatabase } from './ingest.js';
import type { MatchHeader } from './records.js';
import { compareAssaultDatabases } from './assault-report.js';

const root = fileURLToPath(new URL('../../../.matchlog/report-tests', import.meta.url));
mkdirSync(root, { recursive: true });
const database = (range: number, patch: Partial<MatchHeader> = {}) => {
  const dir = mkdtempSync(join(root, 'report-'));
  const path = join(dir, 'arena.sqlite');
  const log = join(dir, 'log.jsonl.gz');
  const writer = createLogWriter(log);
  writer.write({
    t: 'match',
    matchId: 'one',
    kind: 'arena',
    worldSeed: 1,
    aiSeeds: [1, 2],
    profiles: ['a', 'b'],
    gitSha: 'sha',
    gitDirty: false,
    startedAt: '',
    traceVersion: 1,
    traceEnabled: false,
    tickRate: 30,
    tickCap: 36000,
    effectiveAssaultRange: range * 4000,
    tuning: { ...ruleTuning(), assaultRange: range },
    ...patch,
  });
  writer.write({ t: 'end', ticks: 30, winner: null, endReason: 'timeout', wallMs: 0 });
  writer.close();
  const db = openDatabase(path);
  ingestFile(db, log);
  db.close();
  return path;
};
describe('парный отчёт дальности', () => {
  it('различает отсутствующую трассу и нулевой результат, не пишет в базы', () => {
    const a = database(0.5),
      b = database(1);
    const bytes = readFileSync(a);
    const report = compareAssaultDatabases(a, b);
    expect(report.pairedWorlds).toBe(1);
    expect(report.tracedWorlds).toBe(0);
    expect(report.traceDeltas.demolitionTicks).toMatchObject({ n: 0, mean: null });
    expect(report.cutoffCounts).toEqual([
      { seconds: 300, n: 0 },
      { seconds: 600, n: 0 },
    ]);
    expect(compareAssaultDatabases(a, b)).toEqual(report);
    expect(readFileSync(a)).toEqual(bytes);
  });
  it.each([{ gitSha: 'other' }, { aiSeeds: [9, 2] }, { profiles: ['b', 'a'] }, { tickCap: 10 }])(
    'отвергает несовместимые входы %j',
    (patch) => {
      expect(() => compareAssaultDatabases(database(0.5), database(1, patch))).toThrow(
        'incompatible',
      );
    },
  );
  it('объявленная, но потерянная трасса не даёт успешный отчёт', () => {
    expect(() =>
      compareAssaultDatabases(
        database(0.5, { traceEnabled: true }),
        database(1, { traceEnabled: true }),
      ),
    ).toThrow('trace');
  });
  it('несовпадающие seed не образуют пару', () => {
    expect(() => compareAssaultDatabases(database(0.5), database(1, { worldSeed: 2 }))).toThrow(
      'no paired',
    );
  });
});
