import { afterEach, expect, it } from 'vitest';
import { applyRuleTuning, resetRuleTuning } from '@td/shared';
import { createWorld, playerStats } from '@td/sim';
import { escortRadius } from '@td/ai';
import { runMatch } from './match.js';
import type { LogRecord } from './records.js';

afterEach(resetRuleTuning);
it.each([0.5, 1])(
  'наблюдение не меняет матч при дальности ×%s',
  (range) => {
    resetRuleTuning();
    applyRuleTuning({ assaultRange: range });
    expect(escortRadius(playerStats(createWorld(1).players[0]!))).toBe(range === 0.5 ? 7000 : 9000);
    const run = (traceAssault: boolean) => {
      const records: LogRecord[] = [];
      const result = runMatch({
        matchId: 'observer',
        worldSeed: 1,
        aiSeeds: [100, 200],
        profiles: ['swarm-2026-08', 'fortress-2026-08'],
        tickCap: 18000,
        traceAssault,
        log: { write: (record) => records.push(record), close: () => undefined },
      });
      return { result, records };
    };
    const off = run(false);
    const on = run(true);
    const repeat = run(true);
    expect(on.result.checksums).toEqual(off.result.checksums);
    expect(on.result.ticks).toBe(off.result.ticks);
    expect(on.result.winner).toBe(off.result.winner);
    const commands = (records: LogRecord[]) => records.filter((r) => r.t === 'command');
    expect(commands(on.records)).toEqual(commands(off.records));
    const events = (records: LogRecord[]) => records.filter((r) => r.t.startsWith('assault-'));
    expect(events(on.records)).toEqual(events(repeat.records));
    expect(on.records.some((r) => r.t === 'assault-shot')).toBe(true);
    expect(on.records.some((r) => r.t === 'assault-motion' && r.witness !== null)).toBe(true);
  },
  180000,
);
