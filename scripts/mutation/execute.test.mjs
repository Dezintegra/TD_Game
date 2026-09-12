import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executePair, executePhase, projectRoot, readPhaseReport } from './execute.mjs';

const mutation = { id: 'fixture', tuning: { baseHealth: 0.01 }, description: 'Fixture' };
const pair = (name) => ({
  mutationId: 'fixture',
  testFile: 'scripts/mutation/fixtures/behaviour.fixture.ts',
  fullName: ['fixture', ...name.split('/')],
  rationale: 'Fixture',
  probe: 'baseHealth',
});
const options = () => ({
  runId: randomUUID(),
  directory: resolve(projectRoot, '.matchlog/mutation/fixtures'),
  testTimeoutMs: 1000,
  timeoutMs: 20000,
});

describe('isolated mutation adapter', () => {
  it('detects a body assertion, survives a neutral assertion and starts neutral again', async () => {
    const first = await executePair(pair('assertion'), mutation, options());
    expect(first.status, JSON.stringify(first)).toBe('detected');
    const next = await executePair(pair('survives'), mutation, options());
    expect(next.status, JSON.stringify(next)).toBe('survived');
    expect(next.baseline.tuning.baseHealth).toBe(1);
    expect(next.baseline.directory).not.toBe(first.baseline.directory);
  }, 60000);
  it.each([
    'red control',
    'skip',
    'todo',
    'missing',
    'reset',
    'timeout',
    'crash',
    'before hook/assertion',
    'after hook/assertion',
  ])(
    'rejects %s',
    async (name) => {
      const result = await executePair(pair(name), mutation, options());
      expect(result.status, JSON.stringify(result)).toBe('error');
      if (['red control', 'skip', 'todo', 'missing', 'timeout', 'crash'].includes(name))
        expect(result.mutant).toBeNull();
      if (['reset', 'before hook/assertion', 'after hook/assertion'].includes(name)) {
        expect(result.baseline.status).toBe('passed');
        expect(result.mutant).not.toBeNull();
      }
      if (name === 'reset') expect(result.mutant.error).toContain('Tuning');
      if (name === 'before hook/assertion') {
        expect(result.mutant.bodyEntered).toBe(false);
        expect(result.mutant.hookErrors.length).toBeGreaterThan(0);
      }
      if (name === 'after hook/assertion') {
        expect(result.mutant.bodyEntered).toBe(true);
        expect(result.mutant.assertionFailure).toBe(true);
        expect(result.mutant.hookErrors.length).toBeGreaterThan(0);
      }
    },
    60000,
  );
  it('rejects import failures and terminates a process at its deadline', async () => {
    const imported = await executePair(
      { ...pair('missing'), testFile: 'scripts/mutation/fixtures/import.fixture.ts' },
      mutation,
      options(),
    );
    expect(imported.status).toBe('error');
    const result = await executePhase(pair('timeout'), {}, 'baseline', {
      ...options(),
      timeoutMs: 500,
      testTimeoutMs: 60000,
    });
    expect(result.error).toBe('Process timeout');
    const next = await executePair(pair('assertion'), mutation, options());
    expect(next.status, JSON.stringify(next)).toBe('detected');
  }, 60000);
  it('rejects truncated and foreign reports', () => {
    const expected = { pair: pair('assertion'), phase: 'baseline', runId: 'new' };
    expect(readPhaseReport('{', expected, 0).error).toBeTruthy();
    expect(readPhaseReport(JSON.stringify({ runId: 'old' }), expected, 0).error).toBeTruthy();
  });
});
