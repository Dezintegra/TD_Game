import { describe, it, expect, vi } from 'vitest';
import { deliveryFixture } from './testing/report-delivery-fixture.mjs';
import { settleToolReport } from './report-delivery.mjs';
import { retryToolStage } from './tool-retry.mjs';
import { retainedReportView } from './tool-report-hold.mjs';
import { scan } from './scan.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import {
  deploymentEvidence,
  deploymentMarkerCommand,
  deploymentReadCommand,
} from '../../scripts/deploy-evidence.mjs';

async function ready(options = {}) {
  const f = deliveryFixture({ outcome: 'failed', ...options });
  const first = f.open();
  first.store.acknowledge(f.entry.reportId);
  const deployment = {
    path: '.pipeline/deploy-checkouts/saved',
    revision: 'a'.repeat(40),
    host: 'test-host',
    directory: 'td',
  };
  const batch = f.task.status === 'deploy' ? [f.task, f.member] : [];
  const entry = first.store.retain(
    {
      report: options.noReport ? null : f.report,
      parsedReport: options.noReport ? null : f.report,
      answer: { cost: 0 },
    },
    {
      taskId: f.task.id,
      stage: f.task.status,
      launchId: 'old',
      startedAt: f.now,
      assignment: {
        taskId: f.task.id,
        stage: f.task.status,
        task: f.task,
        batch,
        ...(batch.length
          ? {
              deployment,
              deploymentRevision: deployment.revision,
              path: deployment.path,
              branch: null,
            }
          : {}),
      },
      batch: batch.map((task) => task.id),
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
  const settled = await settleToolReport(action, first.io);
  expect(settled, JSON.stringify(settled)).toMatchObject({ result: 'done' });
  return { ...f, entry, action: { ...action, kind: 'retry-tool-stage' } };
}

describe('durable replacement entitlement', () => {
  it.each([false, true])(
    'preserves original deploy and verified publication, null report %s',
    async (noReport) => {
      const f = await ready({ stage: 'deploy', batch: true, noReport });
      try {
        const opened = f.open();
        const original = opened.store.entries()[0];
        const remote = {
          state: 'known',
          published: true,
          revision: original.assignment.deploymentRevision,
        };
        const spawnStage = vi.fn((assignment) => {
          expect(assignment.batch).toEqual([f.task, f.member]);
          expect(assignment.deployment).toEqual(original.assignment.deployment);
          expect(assignment.toolRecovery.remote).toEqual(remote);
          expect(assignment.sessionId).toBe(noReport ? 'old-session' : null);
          return { ok: true };
        });
        const { config } = resolveConfig({ commands: { verify: 'x', deploy: 'x', perf: 'x' } });
        const registry = {
          entries: [f.task, f.member].map((task) => ({
            taskId: task.id,
            path: 'task-tree',
            branch: 'branch',
          })),
        };
        const selected = scan({
          config,
          now: f.now,
          tasks: [
            f.task,
            f.member,
            { ...f.task, id: '0003-new', priority: 1, statusChangedAt: f.now },
          ],
          registry,
          reports: opened.store.entries().map(retainedReportView),
        }).actions;
        expect(selected).toEqual([
          expect.objectContaining({
            kind: 'retry-tool-stage',
            taskId: f.task.id,
            batch: [f.task.id, f.member.id],
          }),
        ]);
        const result = await retryToolStage(f.action, {
          ...opened.io,
          spawnStage,
          inspectToolDeployment: async () => remote,
          inspectRetryLaunch: () => ({ state: 'born' }),
          lastSession: () => 'old-session',
        });
        expect(result, JSON.stringify(result)).toMatchObject({ result: 'done' });
        expect(spawnStage).toHaveBeenCalledOnce();
        expect(f.open().store.entries()).toEqual([]);
      } finally {
        f.cleanup();
      }
    },
  );
  it('requires matching running containers and health, never just a reported SHA', () => {
    const revision = 'a'.repeat(40),
      server = 'b'.repeat(64),
      web = 'c'.repeat(64);
    const lines = [
      'TD_DEPLOY_EVIDENCE_V1',
      revision,
      server,
      web,
      server,
      web,
      '{"status":"ok"}',
      'TD_DEPLOY_EVIDENCE_END',
    ];
    expect(deploymentEvidence({ code: 0, stdout: lines.join('\n') }, revision).state).toBe('known');
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const wrong = [...lines];
      wrong[index] = 'wrong';
      expect(deploymentEvidence({ code: 0, stdout: wrong.join('\n') }, revision).state).toBe(
        'unknown',
      );
    }
    expect(deploymentEvidence({ code: 1, stdout: lines.join('\n') }, revision).state).toBe(
      'unknown',
    );
    expect(deploymentMarkerCommand(revision)).toContain('docker compose ps -q --status running');
    expect(deploymentReadCommand).not.toMatch(/compose (up|restart)|\bmv\b|\brm\b/);
  });
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
