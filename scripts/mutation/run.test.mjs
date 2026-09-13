import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { projectRoot } from './execute.mjs';
import { runCanaries } from './run.mjs';

const mutation = { id: 'fixture', tuning: { baseHealth: 0.01 }, description: 'Fixture' };
const pair = {
  mutationId: 'fixture',
  testFile: 'scripts/mutation/fixtures/behaviour.fixture.ts',
  fullName: ['fixture', 'assertion'],
  probe: 'baseHealth',
  rationale: 'Fixture',
};
// `ref` задаётся явно, а не берётся у среды. По умолчанию `runCanaries`
// читает `GITHUB_REF`, и от него зависит шапка отчёта: на `refs/heads/main`
// печатается «Mode: main», в остальных случаях — «Mode: diagnostic».
// Проверка, полагавшаяся на умолчание, была зелёной на pull request
// (`refs/pull/<номер>/merge`) и краснела после вливания, где ref уже
// главная ветка. Режим проверяется ниже отдельно, обеими сторонами.
const options = {
  mutations: [mutation],
  pairs: [pair],
  sha: 'test-sha',
  ref: 'refs/pull/1/merge',
  outputRoot: resolve(projectRoot, '.matchlog/mutation/runner-fixtures'),
};
it.each([
  ['detected', 0],
  ['survived', 1],
  ['error', 2],
])('saves %s with exit %s', async (status, exitCode) => {
  const execute = vi.fn(async (pair, mutation) => ({
    status,
    pair,
    mutation,
    baseline: { status: 'passed' },
    mutant: { status: status === 'detected' ? 'failed' : 'passed' },
  }));
  const report = await runCanaries({ ...options, execute });
  expect(report.exitCode).toBe(exitCode);
  expect(execute).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(resolve(report.directory, 'summary.json'), 'utf8')).sha).toBe(
    'test-sha',
  );
  const markdown = await readFile(resolve(report.directory, 'summary.md'), 'utf8');
  expect(markdown).toContain(pair.fullName.join(' > '));
});
// Режим отчёта решает, пишутся ли Issue, поэтому проверяется с обеих
// сторон условия. Раньше проверялась только одна, да и та — той веткой,
// которая случайно оказалась у среды прогона.
it.each([
  ['refs/heads/main', 'Mode: main'],
  ['refs/pull/1/merge', 'Mode: diagnostic (no Issue writes)'],
  ['local', 'Mode: diagnostic (no Issue writes)'],
])('reports mode for ref %s', async (ref, expected) => {
  const execute = vi.fn(async () => ({ status: 'detected' }));
  const report = await runCanaries({ ...options, ref, execute });
  expect(await readFile(resolve(report.directory, 'summary.md'), 'utf8')).toContain(expected);
});
it('keeps an unpaired mutation visible without executing it', async () => {
  const execute = vi.fn(async () => ({ status: 'detected' }));
  const report = await runCanaries({
    ...options,
    mutations: [mutation, { ...mutation, id: 'unpaired' }],
    execute,
  });
  expect(report.exitCode).toBe(0);
  expect(report.results[1]).toMatchObject({ status: 'uncovered', mutation: { id: 'unpaired' } });
  expect(execute).toHaveBeenCalledOnce();
});
it('continues after adapter failure and rejects empty pairs', async () => {
  const execute = vi
    .fn()
    .mockRejectedValueOnce(new Error('launch failed'))
    .mockResolvedValueOnce({ status: 'detected' });
  const report = await runCanaries({
    ...options,
    pairs: [pair, { ...pair, fullName: ['other'] }],
    execute,
  });
  expect(report.exitCode).toBe(2);
  expect(report.counts).toMatchObject({ error: 1, detected: 1 });
  expect((await runCanaries({ ...options, pairs: [], execute })).exitCode).toBe(2);
  expect(execute).toHaveBeenCalledTimes(2);
});
it('importing the runner does not execute the adapter', async () => {
  const spy = vi.fn(() => {
    throw new Error('Import started a mutation');
  });
  vi.doMock('./execute.mjs', () => ({ executePair: spy, projectRoot }));
  vi.resetModules();
  await import('./run.mjs');
  expect(spy).not.toHaveBeenCalled();
  vi.doUnmock('./execute.mjs');
});
