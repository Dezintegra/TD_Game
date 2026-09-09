import { describe, expect, it, vi } from 'vitest';
import { prepareReportPlan, transferReport } from './report-plan.mjs';

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
  it('waiting-ci сохраняет возвраты, ссылки и расход и забывает review', async () => {
    const { action, io, report, task } = fixture({
      status: 'review',
      links: { pr: 238 },
      attempts: { rejections: 2, continuations: 4 },
    });
    Object.assign(report, {
      outcome: 'waiting-ci',
      links: task.links,
      findings: [],
      ciWait: {
        pr: 238,
        expectedHead: 'a'.repeat(40),
        observedHead: null,
        state: 'pending',
        exitCode: 2,
        why: 'UNKNOWN',
        mode: 'ordinary',
        runs: [],
        checkpoint: 'entry',
      },
    });
    io.stageEvidence = () => ({ branchOnRemote: true, unpushed: 0 });
    const plan = await prepareReportPlan(action, io);
    expect(plan.operations[0].args[0]).toMatchObject({
      status: 'pr',
      links: { pr: 238 },
      attempts: { rejections: 2, continuations: 0 },
    });
    expect(plan.cleanup).toContainEqual([task.id, 'review']);
    expect(plan.operations[0].args[0].spentUsd).toBe(3);
    expect(await prepareReportPlan(action, {}, plan)).toEqual(plan);
  });
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

describe('приёмка done без отказов', () => {
  const incidental = [{ tool_name: 'PowerShell', tool_input: { command: 'node --version' } }];
  function designFixture(denials) {
    const f = fixture({ status: 'design', links: { pr: 100 } });
    f.report.links = { change: 'check-done-traces-without-denials', pr: 172 };
    f.report.decisions = ['Сохранить строгую мерку'];
    if (denials !== undefined) f.report.denials = denials;
    f.io.stageEvidence = vi.fn(() => ({
      branchOnRemote: true,
      unpushed: 0,
      lastCommitAt: '2026-09-05T09:00:00Z',
      previousPr: f.task.links.pr,
    }));
    f.io.stageStartedAt = vi.fn(() => '2026-09-05T10:00:00Z');
    return f;
  }

  it.each([undefined, [], incidental])(
    'старый коммит останавливает отчёт с denials=%j',
    async (denials) => {
      const { action, io, task, report } = designFixture(denials);
      const plan = await prepareReportPlan(action, io);
      const [stopped, journal] = plan.operations[0].args;
      expect(stopped.status).toBe('postmortem');
      expect(journal).toMatchObject({
        from: 'design',
        to: 'postmortem',
        what: report.summary,
        decisions: report.decisions,
        links: report.links,
        denials: denials ?? [],
      });
      expect(journal.problem).toContain('не появилось ни одного коммита');
      if (!denials?.length) expect(journal.problem).not.toMatch(/отказ/i);
      else expect(journal.problem).toContain('Отказано: PowerShell');
      expect(plan.cleanup).toContainEqual([task.id, 'design']);
      expect(io.stageEvidence).toHaveBeenCalledTimes(1);
      expect(io.stageEvidence).toHaveBeenCalledWith(task);
      expect(io.stageStartedAt).toHaveBeenCalledTimes(1);
      expect(io.stageStartedAt).toHaveBeenCalledWith(task.id, 'design');
      expect(task.links.pr).toBe(100);
    },
  );

  it.each([undefined, [], incidental])(
    'свежий коммит ведёт в аудит с denials=%j',
    async (denials) => {
      const { action, io } = designFixture(denials);
      io.stageEvidence.mockReturnValue({ branchOnRemote: true, unpushed: 0, lastCommitAt: now });
      const plan = await prepareReportPlan(action, io);
      expect(plan.operations[0].args[0].status).toBe('audit');
      expect(plan.operations[0].args[1].denialsNote).toBeUndefined();
    },
  );

  it.each(['design', 'triage', 'unknown'])(
    'неизвестные улики или след %s оставляют диагностику',
    async (stage) => {
      const { action, io, task, report } = designFixture([]);
      task.status = action.stage = report.stage = stage;
      io.stageEvidence.mockReturnValue({});
      const plan = await prepareReportPlan(action, io);
      const journal = plan.operations[0].args[1];
      expect(journal.denialsNote).toContain('проверить след этапа нечем');
      expect(journal.denialsNote).not.toMatch(/отказ/i);
      expect(journal.denials).toEqual([]);
      // Неизвестность следа не отменяет отдельную проверку допустимости этапа.
      expect(plan.operations[0].args[0].status).toBe(stage === 'design' ? 'audit' : 'postmortem');
    },
  );

  it.each(['question', 'failed', 'rejected', 'blocked'])(
    '%s не собирает улики',
    async (outcome) => {
      for (const denials of [undefined, [], incidental]) {
        const { action, io, report } = designFixture(denials);
        report.outcome = outcome;
        if (outcome === 'blocked') {
          await expect(prepareReportPlan(action, io)).rejects.toThrow('не названы блокеры');
        } else {
          await prepareReportPlan(action, io);
        }
        expect(io.stageEvidence).not.toHaveBeenCalled();
        expect(io.stageStartedAt).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['done', 'question'])('обращение к человеку отменяет доверие при %s', async (outcome) => {
    const { action, io, report } = designFixture([{ tool_name: 'AskUserQuestion' }]);
    report.outcome = outcome;
    io.stageEvidence.mockReturnValue({ branchOnRemote: true, unpushed: 0, lastCommitAt: now });
    const plan = await prepareReportPlan(action, io);
    expect(plan.operations[0].args[0].status).toBe('postmortem');
    expect(plan.operations[0].args[1].problem).toContain('AskUserQuestion');
  });

  it('повтор остановки сохраняет решение даже при появившемся свежем коммите', async () => {
    const { action, io } = designFixture([]);
    const saved = JSON.parse(JSON.stringify(await prepareReportPlan(action, io)));
    io.stageEvidence
      .mockClear()
      .mockReturnValue({ branchOnRemote: true, unpushed: 0, lastCommitAt: now });
    io.stageStartedAt.mockClear();
    expect(await prepareReportPlan(action, io, saved)).toEqual(saved);
    expect(saved.operations[0].args[0].status).toBe('postmortem');
    expect(io.stageEvidence).not.toHaveBeenCalled();
    expect(io.stageStartedAt).not.toHaveBeenCalled();
  });

  it('не снимает отчёт и сессию design до удавшейся записи остановки', async () => {
    const { action, io, task, report } = designFixture([]);
    io.saveTask = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, outcome: 'write-failed' })
      .mockResolvedValueOnce({ ok: true });
    io.forgetSession = vi.fn();
    io.removeReport = vi.fn();
    expect(await transferReport(action, io)).toEqual({ result: 'failed', why: 'write-failed' });
    expect(io.forgetSession).not.toHaveBeenCalledWith(task.id, 'design');
    expect(io.removeReport).not.toHaveBeenCalled();
    expect(io.readReport()).toBe(report);
    expect(await transferReport(action, io)).toMatchObject({
      result: 'done',
      status: 'postmortem',
    });
    expect(io.saveTask.mock.calls[0]).toEqual(io.saveTask.mock.calls[1]);
    expect(io.forgetSession).toHaveBeenCalledWith(task.id, 'design');
    expect(io.removeReport).toHaveBeenCalledTimes(1);
    expect(io.removeReport).toHaveBeenCalledWith(task.id, 'design');
    expect(io.removeReport.mock.invocationCallOrder[0]).toBeGreaterThan(
      io.saveTask.mock.invocationCallOrder[1],
    );
  });
});
