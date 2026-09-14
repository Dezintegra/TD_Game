import { setTimeout as tick } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { deliveryFixture } from './testing/report-delivery-fixture.mjs';
import {
  createToolReportHold,
  needsToolDiagnosis,
  retainedReportView,
} from './tool-report-hold.mjs';
import { execute } from './execute.mjs';
import { transferReport } from './report-delivery.mjs';

function retain(f, report = null) {
  const store = f.open().store;
  store.acknowledge(f.entry.reportId);
  const entry = store.retain(
    { accepted: Boolean(report), report, raw: 'original output' },
    {
      taskId: f.task.id,
      stage: f.task.status,
      launchId: 'launch',
      batch: ['0002-member'],
      startedAt: f.now,
      machine: 'test',
    },
  );
  return { store, entry };
}

describe('diagnostic disposition', () => {
  it.each(['healthy', 'inconclusive'])(
    'returns an accepted failed report to ordinary: %s',
    async (verdict) => {
      const f = deliveryFixture({
        outcome: 'failed',
        reportOverrides: { dependencyUpdates: [{ taskId: 'foreign' }] },
      });
      try {
        const { store, entry } = retain(f, f.report);
        const pause = vi.fn();
        const hold = createToolReportHold({ store, diagnose: async () => ({ verdict }), pause });
        hold.restore();
        await tick(0);
        expect(store.get(entry.reportId)).toMatchObject({
          disposition: 'ordinary',
          report: f.report,
        });
        expect(pause).not.toHaveBeenCalled();
      } finally {
        f.cleanup();
      }
    },
  );
  it.each(['healthy', 'inconclusive'])(
    'archives invalid output without ordinary admission: %s',
    async (verdict) => {
      const f = deliveryFixture();
      try {
        const { store, entry } = retain(f);
        const archive = vi.fn((item) => store.archive(item.reportId));
        const hold = createToolReportHold({
          store,
          diagnose: async () => ({ verdict }),
          pause: vi.fn(),
          archive,
        });
        hold.restore();
        await tick(0);
        expect(archive).toHaveBeenCalledWith(
          expect.objectContaining({
            originalResult: { accepted: false, report: null, raw: 'original output' },
          }),
        );
        expect(store.get(entry.reportId)).toBeNull();
      } finally {
        f.cleanup();
      }
    },
  );
  it('keeps the envelope and closes scheduling when archiving fails', async () => {
    const f = deliveryFixture();
    try {
      const { store, entry } = retain(f);
      const hold = createToolReportHold({
        store,
        diagnose: async () => ({ verdict: 'healthy' }),
        pause: vi.fn(),
        archive: () => {
          throw new Error('disk');
        },
      });
      hold.restore();
      await tick(0);
      expect(hold.blocked).toBe(true);
      expect(store.get(entry.reportId).disposition).toBe('diagnosing');
    } finally {
      f.cleanup();
    }
  });
  it('restores the pause after a crash between persisted hold and pause', () => {
    const f = deliveryFixture();
    try {
      const { store, entry } = retain(f);
      store.update(entry.reportId, {
        disposition: 'infrastructure-held',
        evidence: { verdict: 'confirmed' },
      });
      const pause = vi.fn();
      const diagnose = vi.fn();
      createToolReportHold({ store: f.open().store, diagnose, pause }).restore();
      expect(pause).toHaveBeenCalledOnce();
      expect(diagnose).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
  it.each(['transfer-report', 'fail-stage', 'push-tail', 'cleanup', 'continue-stage'])(
    'blocks stale %s for a null-report member',
    async (kind) => {
      const f = deliveryFixture();
      try {
        const { store } = retain(f);
        const saved = vi.fn();
        const result = await execute([{ kind, taskId: '0002-member', stage: 'implement' }], {
          reportStore: store,
          saveTask: saved,
        });
        expect(result[0].result).toBe('skipped');
        expect(saved).not.toHaveBeenCalled();
        const io = f.open().io;
        const direct = await transferReport(
          { ...f.action, reportId: store.entries()[0].reportId },
          { ...io, reportStore: store },
        );
        expect(direct.result).toBe('skipped');
      } finally {
        f.cleanup();
      }
    },
  );
  it('does not classify API errors, foreign stages or denied questions', () => {
    expect(needsToolDiagnosis({ outcome: 'api-error' }, { report: null }, 'implement')).toBe(false);
    expect(
      needsToolDiagnosis(
        { outcome: 'done' },
        { report: { stage: 'review', outcome: 'failed' } },
        'implement',
      ),
    ).toBe(false);
    expect(
      needsToolDiagnosis(
        { outcome: 'done', denials: [{ tool_name: 'AskUserQuestion' }] },
        { report: null },
        'implement',
      ),
    ).toBe(false);
    expect(
      retainedReportView({
        disposition: 'diagnosing',
        report: { dependencyUpdates: ['foreign'] },
        taskId: 'own',
        batch: ['member'],
      }),
    ).toMatchObject({ taskId: 'own', batch: ['member'] });
  });
});
