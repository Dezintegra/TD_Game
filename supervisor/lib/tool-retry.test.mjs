import { describe, it, expect, vi } from 'vitest';
import { deliveryFixture } from './testing/report-delivery-fixture.mjs';
import { settleToolReport } from './report-delivery.mjs';
import { retryToolStage } from './tool-retry.mjs';
import { retainedReportView } from './tool-report-hold.mjs';
import { scan } from './scan.mjs';
import { resolveConfig } from '../config/defaults.mjs';

async function ready(options = {}) {
  const f = deliveryFixture({ outcome: 'failed', ...options });
  const first = f.open();
  first.store.acknowledge(f.entry.reportId);
  const entry = first.store.retain(
    { report: f.report, parsedReport: f.report, answer: { cost: 0 } },
    {
      taskId: f.task.id,
      stage: f.task.status,
      launchId: 'old',
      startedAt: f.now,
      assignment: { taskId: f.task.id, stage: f.task.status, task: f.task },
      batch: [],
      charge: { launchId: 'old', state: 'not-required' },
    },
  );
  first.store.update(entry.reportId, {
    disposition: 'infrastructure-held',
    evidence: { verdict: 'confirmed' },
    retry: { pauseRecorded: true, recovery: { verdict: 'healthy', checks: [] } },
  });
  const action = {
    kind: 'settle-tool-report',
    taskId: f.task.id,
    stage: f.task.status,
    reportId: entry.reportId,
  };
  expect((await settleToolReport(action, first.io)).result).toBe('done');
  return { ...f, entry, action: { ...action, kind: 'retry-tool-stage' } };
}

describe('durable replacement entitlement', () => {
  it.each(['busy', 'availability-held', 'not-born'])(
    'preserves entitlement after %s',
    async (reason) => {
      const f = await ready();
      try {
        const opened = f.open();
        const result = await retryToolStage(f.action, {
          ...opened.io,
          registryEntry: () => null,
          spawnStage: () => ({ ok: false, reason, why: reason }),
        });
        expect(result, JSON.stringify(result)).toMatchObject({
          result: reason === 'not-born' ? 'failed' : 'skipped',
        });
        expect(result.why).toContain(reason === 'not-born' ? 'replacement did not start' : reason);
        const next = f.open();
        expect(next.store.entries()[0]).toMatchObject({
          disposition: 'retry-ready',
          retry: { state: 'available', newLaunchId: null },
        });
        expect(next.recipient.store.readTask(f.task.id).attempts.continuations).toBe(2);
        expect(next.recipient.store.readTask(f.task.id).attempts.spawnFailures ?? 0).toBe(
          reason === 'not-born' ? 1 : 0,
        );
      } finally {
        f.cleanup();
      }
    },
  );
  it('claims before spawn and survives a crash after birth without a second child', async () => {
    const f = await ready();
    try {
      const opened = f.open();
      const spawnStage = vi.fn((assignment) => {
        expect(f.open().store.entries()[0].retry.newLaunchId).toBe(assignment.launchId);
        expect(assignment.sessionId).toBeNull();
        expect(assignment.charge.state).toBe('not-required');
        expect(assignment.toolRecovery.originalReport).toEqual(f.report);
        throw new Error('lost response after birth');
      });
      expect(
        (await retryToolStage(f.action, { ...opened.io, registryEntry: () => null, spawnStage }))
          .result,
      ).toBe('failed');
      const next = f.open();
      expect(
        (
          await retryToolStage(f.action, {
            ...next.io,
            spawnStage,
            inspectRetryLaunch: () => ({ state: 'born' }),
          })
        ).result,
      ).toBe('done');
      expect(spawnStage).toHaveBeenCalledOnce();
      expect(f.open().store.entries()).toEqual([]);
      expect(f.open().recipient.store.readTask(f.task.id).attempts.continuations).toBe(2);
    } finally {
      f.cleanup();
    }
  });
  it.each(['absent', 'unknown'])('reconciles an interrupted claim: %s', async (state) => {
    const f = await ready();
    try {
      const opened = f.open();
      const entry = opened.store.get(f.entry.reportId);
      opened.store.update(entry.reportId, {
        disposition: 'retry-claimed',
        retry: { ...entry.retry, state: 'claimed', newLaunchId: 'new', spawnState: 'prepared' },
      });
      const spawnStage = vi.fn();
      await retryToolStage(f.action, {
        ...f.open().io,
        spawnStage,
        inspectRetryLaunch: () => ({ state }),
      });
      expect(spawnStage).not.toHaveBeenCalled();
      expect(f.open().store.entries()[0].disposition).toBe(
        state === 'absent' ? 'retry-ready' : 'retry-claimed',
      );
    } finally {
      f.cleanup();
    }
  });
  it.each(['tokens', 'availability', 'ownership', 'dependency', 'deploy'])(
    'does not bypass %s',
    async (hold) => {
      const f = await ready(hold === 'deploy' ? { stage: 'deploy', batch: true } : {});
      try {
        const opened = f.open();
        const spawnStage = vi.fn();
        const io = {
          ...opened.io,
          spawnStage,
          registryEntry: () => null,
          tokenAdmission: () => hold === 'tokens',
          mayLaunch: () => ({ allowed: hold !== 'availability' }),
          requiresFreshStart: hold === 'dependency',
          readStartTask: async () => ({ ok: false, why: 'dependency' }),
        };
        if (hold === 'ownership') io.readTask = () => ({ ...f.task, owner: 'foreign' });
        expect((await retryToolStage(f.action, io)).result).toBe('skipped');
        expect(spawnStage).not.toHaveBeenCalled();
        expect(opened.store.entries()[0].disposition).toBe('retry-ready');
      } finally {
        f.cleanup();
      }
    },
  );
  it('bypasses only continuation limit while entitlement exists and obeys capacity', async () => {
    const f = await ready();
    try {
      const { config } = resolveConfig({
        commands: { verify: 'x', deploy: 'x', perf: 'x' },
        maxContinuations: 2,
      });
      const state = {
        config,
        now: f.task.statusChangedAt,
        tasks: [f.task],
        registry: { entries: [{ taskId: f.task.id, path: 'tree', branch: 'branch' }] },
        reports: f.open().store.entries().map(retainedReportView),
      };
      expect(scan(state).actions).toContainEqual(
        expect.objectContaining({ kind: 'retry-tool-stage' }),
      );
      expect(
        scan({ ...state, running: [{ taskId: 'other', stage: 'implement' }] }).actions,
      ).toEqual([]);
      expect(scan({ ...state, reports: [] }).actions).toContainEqual(
        expect.objectContaining({ kind: 'fail-stage' }),
      );
    } finally {
      f.cleanup();
    }
  });
});
