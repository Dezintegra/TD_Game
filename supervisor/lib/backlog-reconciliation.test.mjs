import { describe, expect, it, vi } from 'vitest';
import {
  collectReconciliation,
  needsReconciliation,
  reconcileTask,
} from './backlog-reconciliation.mjs';
import { scan } from './scan.mjs';
import { resolveConfig } from '../config/defaults.mjs';
const now = '2026-09-12T12:00:00Z';
const task = (over = {}) => ({
  id: '0001-one',
  type: 'feature',
  status: 'failed',
  statusChangedAt: now,
  owner: 'test',
  links: { pr: 42 },
  attempts: { continuations: 2 },
  tokenBudget: { spent: 99 },
  ...over,
});
const proof = { number: 42, state: 'MERGED', mergedAt: now, baseRefName: 'main' };
const config = resolveConfig({ commands: { verify: 'x', deploy: 'x', perf: 'x' } }).config;
const action = {
  taskId: '0001-one',
  expectedStatus: 'failed',
  expectedSince: now,
  pr: 42,
  proof,
  mainBranch: 'main',
};
function ioFor(t, needed = false) {
  return {
    now,
    machine: 'test',
    readTask: () => t,
    reconciliationPr: () => proof,
    deploymentImpact: () => ({ needed }),
    saveTask: vi.fn(async () => ({ ok: true })),
  };
}
describe('сверка фактического результата', () => {
  it.each([
    [false, 'cleanup'],
    [true, 'review'],
  ])('сохраняет правильный оставшийся маршрут %s', async (needed, status) => {
    const io = ioFor(task(), needed);
    expect(await reconcileTask(action, io)).toMatchObject({ result: 'done', status });
    expect(io.saveTask.mock.calls[0][0]).toMatchObject({
      status,
      tokenBudget: { spent: 99 },
      attempts: { continuations: 0 },
    });
  });
  it('не принимает чужую базу и недоступный GitHub за успех', async () => {
    for (const bad of [null, { ...proof, baseRefName: 'other' }]) {
      const io = ioFor(task());
      await reconcileTask({ ...action, proof: bad }, io);
      expect(io.saveTask.mock.calls[0][0].status).toBe('failed');
    }
  });
  it('сверяет карточку и повторно проверяет вливание', async () => {
    for (const t of [
      task({ owner: 'other' }),
      task({ status: 'token-limit' }),
      task({ statusChangedAt: '2026-09-13T00:00:00Z' }),
    ]) {
      const io = ioFor(t);
      expect((await reconcileTask(action, io)).result).toBe('skipped');
      expect(io.saveTask).not.toHaveBeenCalled();
    }
    const io = ioFor(task());
    io.reconciliationPr = () => null;
    expect((await reconcileTask(action, io)).result).toBe('done');
    const saved = io.saveTask.mock.calls[0][0];
    expect(saved.status).toBe('failed');
    expect(saved.reconciliation).toMatchObject({ state: 'unconfirmed', checkedAt: now });
    expect(needsReconciliation(saved, now)).toBe(false);
  });
  it('ограничивает чтения двумя карточками и исключает живой пакет', async () => {
    const tasks = Array.from({ length: 5 }, (_, n) => task({ id: `000${n}-one` }));
    const run = vi.fn(async () => ({ code: 0, stdout: JSON.stringify(proof) }));
    const result = await collectReconciliation({
      tasks,
      running: [{ batch: ['0000-one'] }],
      root: '.',
      run,
      config,
      machine: 'test',
      now,
    });
    expect(Object.keys(result)).toEqual(['0001-one', '0002-one']);
    expect(run).toHaveBeenCalledTimes(2);
    expect(needsReconciliation(task({ reconciliation: { pr: 42, checkedAt: now } }), now)).toBe(
      false,
    );
  });
  it('в одном снимке сверка исключает повторный этап, но не перенос отчёта', () => {
    const state = {
      config,
      now,
      machine: 'test',
      tasks: [task({ status: 'implement' })],
      registry: { entries: [] },
      reconciliationReady: true,
      reconciliationEvidence: { '0001-one': { proof } },
    };
    const actions = scan(state).actions;
    expect(actions.some((a) => a.kind === 'reconcile-task')).toBe(true);
    expect(
      actions.some((a) => ['start-stage', 'continue-stage', 'analyze-delay'].includes(a.kind)),
    ).toBe(false);
    expect(
      scan({ ...state, running: [{ taskId: '0001-one', stage: 'implement' }] }).actions.some(
        (a) => a.kind === 'reconcile-task',
      ),
    ).toBe(false);
    expect(scan({ ...state, paused: true }).actions).toEqual([]);
  });
});
