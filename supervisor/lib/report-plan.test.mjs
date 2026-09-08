import { describe, expect, it } from 'vitest';
import { prepareReportPlan } from './report-plan.mjs';

const now = '2026-09-06T10:00:00Z';
function fixture(over = {}) {
  const task = {
    id: '0001-task',
    type: 'feature',
    title: 'Task',
    status: 'implement',
    statusChangedAt: '2026-09-05T10:00:00Z',
    createdAt: now,
    history: [],
    links: {},
    attempts: { continuations: 2 },
    ...over,
  };
  const report = {
    taskId: task.id,
    stage: task.status,
    outcome: 'done',
    summary: 'finished',
    costUsd: 3,
    links: { pr: 172 },
  };
  return {
    task,
    report,
    action: { taskId: task.id, stage: task.status, reportId: 'launch-one' },
    io: { now, readTask: () => task, readReport: () => report, allTaskIds: () => [task.id] },
  };
}
describe('stable report plan', () => {
  it('freezes accounting, transition, journal and cleanup without writing', async () => {
    const { action, io } = fixture();
    const plan = await prepareReportPlan(action, io);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]).toMatchObject({
      kind: 'saveTask',
      expected: { status: 'implement' },
    });
    expect(plan.operations[0].args[0]).toMatchObject({
      status: 'pr',
      links: { pr: 172 },
      attempts: { continuations: 0 },
    });
    expect(plan.operations[0].args[1]).toMatchObject({
      from: 'implement',
      to: 'pr',
      at: now,
      what: 'finished',
    });
    expect(plan.cleanup).toContainEqual([action.taskId, 'implement']);
    const replay = await prepareReportPlan(
      action,
      {
        readTask: () => {
          throw new Error('new state must not be read');
        },
      },
      JSON.parse(JSON.stringify(plan)),
    );
    expect(replay).toEqual(JSON.parse(JSON.stringify(plan)));
  });
  it('gives two visits to the same stage distinct operation keys', async () => {
    const { action, io } = fixture();
    const first = await prepareReportPlan(action, io);
    const second = await prepareReportPlan({ ...action, reportId: 'launch-two' }, io);
    expect(first.operations[0].key).not.toBe(second.operations[0].key);
  });
  it('keeps requests, amendments and batch members before the lead', async () => {
    const { action, io, report, task } = fixture({ status: 'deploy' });
    const member = { ...task, id: '0002-member' };
    io.readTask = (id) => (id === task.id ? task : member);
    io.allTaskIds = () => [task.id, member.id];
    report.batch = [task.id, member.id];
    report.deployed = [task.id, member.id];
    report.requests = [{ type: 'note', title: 'Follow up', description: 'Reason', priority: 50 }];
    report.amendments = [{ taskId: member.id, facts: 'New evidence' }];
    const plan = await prepareReportPlan(action, io);
    expect(plan.operations.map((op) => op.kind)).toEqual([
      'createTask',
      'amendTask',
      'saveTask',
      'saveTask',
    ]);
    expect(plan.operations.at(-2).args[0]).toMatchObject({ id: member.id, status: 'cleanup' });
    expect(plan.operations.at(-1).args[0].id).toBe(task.id);
    expect(new Set(plan.operations.map((op) => op.key)).size).toBe(4);
  });
  it('records halt delivery when report trust fails', async () => {
    const { action, io, report } = fixture();
    report.denials = [{ tool_name: 'AskUserQuestion', input: {} }];
    const plan = await prepareReportPlan(action, io);
    expect(plan.operations[0].args[0].status).toBe('postmortem');
    expect(plan.operations[0].args[1].denials).toEqual(report.denials);
  });
});
