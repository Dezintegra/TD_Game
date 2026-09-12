import { describe, expect, it } from 'vitest';
import { scan } from './scan.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { reportTaskIds } from './report-targets.mjs';
import { resolveDependents } from './resolve-dependents.mjs';
const now = '2026-09-12T12:00:00Z';
const config = resolveConfig({
  maxConcurrent: 1,
  commands: { verify: 'x', deploy: 'x', perf: 'x' },
}).config;
const task = (id, extra = {}) => ({
  id,
  type: 'feature',
  title: id,
  description: id,
  status: 'new',
  statusChangedAt: now,
  createdAt: now,
  owner: null,
  priority: 50,
  attempts: {},
  links: {},
  ...extra,
});
describe('дыры, найденные отдельным ревью', () => {
  it('не запускает участников неприменённого поглощения', () => {
    const report = {
      taskId: '0001-analysis',
      stage: 'triage',
      consolidations: [{ sourceId: '0002-source', targetId: '0003-target' }],
    };
    expect(reportTaskIds(report)).toEqual(['0001-analysis', '0002-source', '0003-target']);
    const actions = scan({
      config,
      now,
      machine: 'station',
      tasks: [task('0002-source'), task('0003-target')],
      reports: [report],
      registry: { entries: [] },
    }).actions;
    expect(actions.some((a) => ['start-stage', 'continue-stage'].includes(a.kind))).toBe(false);
  });
  it('недоступный PR удерживает только свою задачу и не занимает вычислительный слот', () => {
    const held = task('0001-held', {
      status: 'implement',
      links: { pr: 42 },
      reconciliation: { pr: 42, checkedAt: now, state: 'unconfirmed' },
    });
    const next = task('0002-next', { type: 'note' });
    const actions = scan({
      config,
      now,
      machine: 'station',
      tasks: [held, next],
      registry: { entries: [] },
      reconciliationReady: true,
    }).actions;
    expect(
      actions.some(
        (a) => a.taskId === held.id && ['start-stage', 'continue-stage'].includes(a.kind),
      ),
    ).toBe(false);
    expect(actions.some((a) => a.taskId === next.id && a.kind === 'start-stage')).toBe(true);
  });
  it('снятие закрытого предшественника сохраняет ожидаемый PR и требует проверки', async () => {
    let waiting = task('0001-wait', {
      status: 'blocked',
      dependencyRecheck: {
        edges: [],
        results: [{ taskId: '0003-prior', kind: 'merged-pr', pr: 66 }],
      },
      dependsOn: ['0002-old'],
      dependencyResults: [{ taskId: '0002-old', kind: 'merged-pr', pr: 77 }],
      blockedContext: {
        from: 'implement',
        operation: 'wait',
        reasons: [{ taskId: '0002-old', reason: 'нужна реализация', result: 'PR 77 в main' }],
      },
    });
    const action = {
      taskId: waiting.id,
      edges: [
        {
          dependencyId: '0002-old',
          field: 'dependsOn',
          reason: 'закрыто без реализации',
          what: 'предусловие',
        },
      ],
    };
    await resolveDependents(action, {
      now,
      machine: 'station',
      readTask: () => waiting,
      saveTask: async (next) => {
        waiting = next;
        return { ok: true };
      },
    });
    expect(waiting.dependencyRecheck.results.map((r) => r.pr)).toEqual([66, 77]);
    const actions = scan({
      config,
      now,
      machine: 'station',
      tasks: [waiting],
      registry: { entries: [] },
    }).actions;
    expect(actions).toContainEqual(
      expect.objectContaining({ kind: 'analyze-delay', mode: 'verify', taskId: waiting.id }),
    );
    expect(
      actions.some((a) => ['start-stage', 'continue-stage', 'unblock-task'].includes(a.kind)),
    ).toBe(false);
  });
});
