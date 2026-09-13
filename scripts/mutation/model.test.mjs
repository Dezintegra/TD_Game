import { describe, expect, it } from 'vitest';
import { classifyPair, pairKey, summarize, validateCatalog } from './model.mjs';

const pair = {
  mutationId: 'base',
  testFile: 'src/check.ts',
  fullName: ['suite', 'test'],
  rationale: 'Health contract',
  probe: 'baseHealth',
};
const mutation = { id: 'base', tuning: { baseHealth: 0.1 }, description: 'Fragile base' };
function report(phase, overrides = {}) {
  return {
    runId: 'run',
    phase,
    pairKey: pairKey(pair),
    testFile: pair.testFile,
    fullName: pair.fullName,
    selectedCount: 1,
    bodyEntered: true,
    bodyExited: true,
    tuningVerified: true,
    sharedVerified: true,
    derivedChanged: true,
    status: 'passed',
    ...overrides,
  };
}
describe('mutation evidence', () => {
  it('requires a green control and a body assertion for detected', () => {
    expect(
      classifyPair(
        pair,
        report('baseline'),
        report('mutant', { status: 'failed', assertionFailure: true }),
        'run',
      ).status,
    ).toBe('detected');
    expect(classifyPair(pair, report('baseline'), report('mutant'), 'run').status).toBe('survived');
  });
  it.each([
    { status: 'skipped' },
    { bodyEntered: false },
    { bodyExited: false },
    { selectedCount: 0 },
    { selectedCount: 2 },
    { fullName: ['other'] },
    { runId: 'old' },
    { pairKey: 'other' },
    { phase: 'baseline' },
    { tuningVerified: false },
    { derivedChanged: false },
    { sharedVerified: false },
    { hookErrors: ['AssertionError'], status: 'failed', assertionFailure: true },
    { runnerErrors: ['import'] },
    { status: 'failed', assertionFailure: false },
    { error: 'timeout' },
  ])('rejects invalid mutant evidence %j', (overrides) => {
    expect(classifyPair(pair, report('baseline'), report('mutant', overrides), 'run').status).toBe(
      'error',
    );
  });
  it('rejects red baseline and missing report', () => {
    expect(
      classifyPair(
        pair,
        report('baseline', { status: 'failed', assertionFailure: true }),
        report('mutant'),
        'run',
      ).status,
    ).toBe('error');
    expect(classifyPair(pair, report('baseline'), null, 'run').status).toBe('error');
  });
  it('validates pairs without hiding lost links as uncovered', () => {
    expect(validateCatalog({ mutations: [mutation], pairs: [pair] })).toEqual([]);
    for (const catalog of [
      { mutations: [mutation], pairs: [] },
      { mutations: [mutation, mutation], pairs: [pair] },
      { mutations: [mutation], pairs: [pair, pair] },
      { mutations: [mutation], pairs: [{ ...pair, mutationId: 'lost' }] },
      ...[{}, { speed: 1 }, { speed: 0 }, { speed: Infinity }, { unknown: 2 }].map((tuning) => ({
        mutations: [{ ...mutation, tuning }],
        pairs: [pair],
      })),
    ])
      expect(validateCatalog(catalog).length).toBeGreaterThan(0);
  });
  it('keeps uncovered neutral and errors dominant in mixed results', () => {
    const result = (status) => ({ status });
    expect(summarize(['detected', 'uncovered'].map(result)).exitCode).toBe(0);
    expect(summarize(['detected', 'survived'].map(result)).exitCode).toBe(1);
    expect(summarize(['detected', 'survived', 'error'].map(result)).exitCode).toBe(2);
    expect(summarize([result('uncovered')]).exitCode).toBe(2);
  });
});
