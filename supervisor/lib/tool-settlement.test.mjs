import { describe, expect, it, vi } from 'vitest';
import { deliveryFixture } from './testing/report-delivery-fixture.mjs';
import { receiptOf } from './report-receipts.mjs';
import { execute } from './execute.mjs';

function fixture(state = 'confirmed') {
  const key = 'continuation:launch';
  const f = deliveryFixture({
    outcome: 'failed',
    taskOverrides: { reportReceipts: state === 'confirmed' ? [receiptOf(key)] : [] },
    reportOverrides: {
      dependencyUpdates: [{ taskId: 'never-write', bad: true }],
      requests: [{ bad: true }],
    },
  });
  const opened = f.open();
  opened.store.acknowledge(f.entry.reportId);
  const entry = opened.store.retain(
    { report: f.report, answer: { cost: 3 } },
    {
      taskId: f.task.id,
      stage: f.task.status,
      launchId: 'launch',
      startedAt: f.now,
      machine: 'test',
      assignment: { task: f.task },
      batch: [f.member.id],
      charge: { launchId: 'launch', state, key },
    },
  );
  opened.store.update(entry.reportId, {
    disposition: 'infrastructure-held',
    evidence: { verdict: 'confirmed', costUsd: 2 },
    retry: { recovery: { verdict: 'healthy', checks: [] }, recoveryCostUsd: 0 },
  });
  return {
    ...f,
    entry,
    action: { ...f.action, kind: 'settle-tool-report', reportId: entry.reportId },
  };
}

describe('receipt-backed infrastructure settlement', () => {
  it.each(['confirmed', 'not-required'])(
    'preserves stage and refunds only its own receipt: %s',
    async (charge) => {
      const f = fixture(charge);
      try {
        const first = f.open();
        const forbidden = vi.fn(() => {
          throw new Error('ordinary effects are forbidden');
        });
        expect(
          (
            await execute([f.action], {
              ...first.io,
              appendTaskDependencies: forbidden,
              createTask: forbidden,
            })
          )[0].result,
        ).toBe('done');
        const again = f.open();
        const saved = again.recipient.store.readTask(f.task.id);
        expect(saved.status).toBe(f.task.status);
        expect(saved.attempts.continuations).toBe(charge === 'confirmed' ? 1 : 2);
        expect(saved.spentUsd).toBe(9);
        expect(again.store.entries()[0]).toMatchObject({
          disposition: 'retry-ready',
          originalResult: { report: f.report },
        });
        expect(forbidden).not.toHaveBeenCalled();
        expect((await execute([f.action], again.io))[0].result).toBe('skipped');
        expect(f.open().recipient.state()).toMatchObject({ puts: 1, posts: 1, deletes: 0 });
      } finally {
        f.cleanup();
      }
    },
  );
  it.each(['before-put', 'after-put', 'after-comment', 'after-progress'])(
    'survives restart at %s without duplicate refund',
    async (point) => {
      const f = fixture();
      try {
        const first = f.open();
        if (point === 'before-put') first.recipient.fail('PUT', 'cards/');
        if (point === 'after-put') first.recipient.fail('PUT', 'cards/', 'after');
        if (point === 'after-comment') first.recipient.fail('POST', '/actions/comments', 'after');
        if (point === 'after-progress')
          first.store.archive = () => {
            throw new Error('archive disk unavailable');
          };
        expect((await execute([f.action], first.io))[0].result).toBe('failed');
        expect(f.open().store.entries()[0].disposition).toBe('infrastructure-held');
        const next = f.open();
        expect((await execute([f.action], next.io))[0].result).toBe('done');
        expect(f.open().recipient.store.readTask(f.task.id)).toMatchObject({
          spentUsd: 9,
          attempts: { continuations: 1 },
        });
        expect(f.open().recipient.state()).toMatchObject({ puts: 1, posts: 1, deletes: 0 });
        expect(f.open().store.entries()[0].originalResult.report.dependencyUpdates).toEqual(
          f.report.dependencyUpdates,
        );
      } finally {
        f.cleanup();
      }
    },
  );
  it('pending cannot refund before the late charge confirmation', async () => {
    const f = fixture('pending');
    try {
      const first = f.open();
      expect((await execute([f.action], first.io))[0].result).toBe('failed');
      expect(first.recipient.state()).toMatchObject({ puts: 0, posts: 0 });
      expect(first.store.entries()[0].plan).toBeNull();
      expect(first.store.entries()[0].charge.state).toBe('pending');
    } finally {
      f.cleanup();
    }
  });
  it('cannot invent proof from the general continuation counter', async () => {
    const f = fixture('not-required');
    try {
      const first = f.open();
      first.store.update(f.entry.reportId, {
        charge: { launchId: 'launch', state: 'confirmed', key: 'absent' },
      });
      expect((await execute([f.action], first.io))[0].result).toBe('failed');
      expect(first.recipient.state()).toMatchObject({ puts: 0, posts: 0 });
    } finally {
      f.cleanup();
    }
  });
});
