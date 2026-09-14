import { describe, expect, it, vi } from 'vitest';
import {
  collectReconciliation,
  needsReconciliation,
  reconciliationHeld,
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
const incidentSource = (fixedBy, over = {}) =>
  task({
    id: '0000-source',
    pipelineIncident: {
      id: 'incident',
      evidence: 'сломана проверка',
      openedAt: now,
      fixedBy,
      affectedStages: ['implement'],
      check: { stage: 'implement', expectation: 'проверка проходит' },
    },
    ...over,
  });
const openPr = vi.fn(async (args) => ({
  code: 0,
  stdout: JSON.stringify({ number: Number(args[2]), state: 'OPEN', baseRefName: 'main' }),
}));
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
  it.each([false, true, undefined])(
    'бюджет не удерживает только доказанную служебную уборку: %s',
    async (needed) => {
      const current = task({
        status: 'token-limit',
        tokenHold: { spent: 26795899, limit: 25000000, resumeStatus: 'implement' },
      });
      const io = ioFor(current);
      io.deploymentImpact = () => (needed === undefined ? undefined : { needed });
      expect(needsReconciliation(current, now)).toBe(true);
      await reconcileTask({ ...action, expectedStatus: 'token-limit' }, io);
      const saved = io.saveTask.mock.calls[0][0];
      expect(saved.status).toBe(needed === false ? 'cleanup' : 'token-limit');
      expect(saved.tokenBudget).toEqual(current.tokenBudget);
      if (needed !== false) expect(saved.tokenHold).toEqual(current.tokenHold);
    },
  );
  it.each([false, true])(
    'сверяет review без сброса оставшихся игровых обязательств %s',
    async (needed) => {
      const current = task({ status: 'review', question: { text: 'pending' } });
      const io = ioFor(current, needed);
      expect(needsReconciliation(current, now)).toBe(true);
      expect(await reconcileTask({ ...action, expectedStatus: 'review' }, io)).toMatchObject({
        result: 'done',
        status: needed ? 'review' : 'cleanup',
      });
      const saved = io.saveTask.mock.calls[0][0];
      expect(saved.reconciliation.state).toBe('merged');
      if (needed) {
        expect(saved.attempts).toEqual(current.attempts);
        expect(saved.statusChangedAt).toBe(current.statusChangedAt);
        expect(saved.question).toEqual(current.question);
      }
    },
  );
  it('закрытый без вливания PR не становится вечным неизвестным ответом', async () => {
    const io = ioFor(task());
    await reconcileTask({ ...action, proof: { ...proof, state: 'CLOSED', mergedAt: null } }, io);
    const saved = io.saveTask.mock.calls[0][0];
    expect(saved.status).toBe('failed');
    expect(saved.reconciliation.state).toBe('closed');
    expect(reconciliationHeld(saved, now)).toBe(false);
  });
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
  it('выбирает применимый ремонт до старых карточек и допускает его бюджетный анализ', async () => {
    const repair = task({ id: '0337-repair', status: 'revise', priority: 42 });
    const state = {
      config: {
        ...config,
        provider: 'codex',
        codexTaskReanalysisTokens: 150,
        codexMaxTaskTokens: 250,
      },
      now,
      machine: 'test',
      tasks: [
        incidentSource([repair.id]),
        task({ id: '0002-old', status: 'audit' }),
        task({ id: '0003-old', status: 'audit' }),
        repair,
      ],
      registry: { entries: [{ taskId: repair.id, path: 'tree', branch: 'worktree-repair' }] },
      codexUsage: {
        version: 2,
        tasks: {
          [repair.id]: {
            sessions: {
              old: {
                knownTokens: 190,
                snapshot: { input_tokens: 190, output_tokens: 0 },
                reasons: [],
              },
            },
            launches: {},
          },
        },
      },
      reconciliationReady: true,
    };
    const evidence = await collectReconciliation({ ...state, run: openPr });
    expect(Object.keys(evidence)).toEqual([repair.id, '0002-old']);
    const actions = scan({ ...state, reconciliationEvidence: evidence }).actions;
    expect(actions.some((a) => a.kind === 'analyze-token-budget')).toBe(false);
    for (const a of actions.filter((a) => a.kind === 'reconcile-task')) {
      expect(
        (
          await reconcileTask(a, {
            ...ioFor(null),
            readTask: (id) => state.tasks.find((t) => t.id === id),
            saveTask: async (saved) => {
              state.tasks = state.tasks.map((t) => (t.id === saved.id ? saved : t));
              return { ok: true };
            },
          })
        ).result,
      ).toBe('done');
    }
    const restarted = JSON.parse(JSON.stringify(state));
    expect(scan(restarted).actions).toContainEqual(
      expect.objectContaining({ kind: 'analyze-token-budget', taskId: repair.id }),
    );
    expect(restarted.tasks.find((t) => t.id === repair.id).status).toBe('revise');
  });
  it('сверяет весь хвост даже если первая пара устаревает к следующему циклу', async () => {
    let tasks = Array.from({ length: 8 }, (_, n) => task({ id: `task-${n}` }));
    const selected = [];
    for (let cycle = 0; cycle < 5; cycle++) {
      const at = new Date(Date.parse(now) + cycle * 16 * 60 * 1000).toISOString();
      const evidence = await collectReconciliation({
        tasks,
        run: openPr,
        now: at,
        config,
        machine: 'test',
      });
      selected.push(Object.keys(evidence));
      for (const [taskId, value] of Object.entries(evidence)) {
        const t = tasks.find((t) => t.id === taskId);
        await reconcileTask(
          { ...action, taskId, proof: value.proof },
          {
            ...ioFor(t),
            now: at,
            saveTask: async (saved) => {
              tasks = JSON.parse(JSON.stringify(tasks.map((t) => (t.id === saved.id ? saved : t))));
              return { ok: true };
            },
          },
        );
      }
    }
    expect(selected).toEqual([
      ['task-0', 'task-1'],
      ['task-2', 'task-3'],
      ['task-4', 'task-5'],
      ['task-6', 'task-7'],
      ['task-0', 'task-1'],
    ]);
  });
  it('учитывает архивный диагноз и зависимости ремонта, сохраняя защиту недоступных карточек', async () => {
    const tasks = [
      task({ id: 'ordinary' }),
      task({ id: 'foreign', owner: 'other' }),
      task({ id: 'live' }),
      task({ id: 'reported' }),
      task({ id: 'delayed', delayJournal: { phase: 'pending' } }),
      task({ id: 'prerequisite' }),
      task({ id: 'part' }),
    ];
    const run = vi.fn(openPr);
    const evidence = await collectReconciliation({
      tasks,
      config,
      now,
      machine: 'test',
      run,
      dependencyRecords: [
        incidentSource(['fix']),
        task({
          id: 'fix',
          dependsOn: ['foreign', 'live', 'reported', 'delayed', 'prerequisite'],
          splitInto: ['part'],
        }),
      ],
      running: [{ batch: ['live'] }],
      reports: [{ taskId: 'reported', stage: 'implement', outcome: 'done' }],
    });
    expect(Object.keys(evidence)).toEqual(['prerequisite', 'part']);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('не считает проверкой нового PR старую отметку другого PR', async () => {
    const tasks = [
      task({ id: 'old', reconciliation: { pr: 42, checkedAt: '2026-09-01T00:00:00Z' } }),
      task({ id: 'changed', reconciliation: { pr: 41, checkedAt: now } }),
      task({ id: 'invalid', reconciliation: { pr: 42, checkedAt: 'broken' } }),
    ];
    const evidence = await collectReconciliation({
      tasks,
      config,
      now,
      machine: 'test',
      run: openPr,
    });
    expect(Object.keys(evidence)).toEqual(['changed', 'invalid']);
  });
});
