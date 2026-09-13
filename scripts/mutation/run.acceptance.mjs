import { expect, it } from 'vitest';
import { runCanaries } from './run.mjs';

it('detects all three real mutations twice in fresh processes', async () => {
  const first = await runCanaries();
  expect(first.counts, JSON.stringify(first)).toEqual({
    detected: 3,
    survived: 0,
    uncovered: 0,
    error: 0,
  });
  const second = await runCanaries();
  expect(second.counts, JSON.stringify(second)).toEqual(first.counts);
  expect(second.runId).not.toBe(first.runId);
  expect(second.directory).not.toBe(first.directory);
  for (const result of second.results) {
    expect(result.baseline.tuning).toEqual({
      income: 1,
      speed: 1,
      towerHealth: 1,
      baseHealth: 1,
      unitRadius: 1,
      map: 1,
    });
  }
});
