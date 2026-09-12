import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { seedRecipient, openRecipient } from './report-recipient.mjs';
import { openReportStore } from '../report-store.mjs';

export function deliveryFixture({
  stage = 'implement',
  batch = false,
  outcome = 'done',
  requests = false,
  denials = [],
  taskOverrides = {},
  memberOverrides = {},
  reportOverrides = {},
} = {}) {
  const base = join(import.meta.dirname, '../../../.matchlog');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'delivery-'));
  const boardPath = join(root, 'board.json');
  const queuePath = join(root, 'pending.json');
  const diskEvents = [];
  const disk = new Proxy(fs, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      return (...args) => {
        const event = { operation: key, path: args[0] };
        diskEvents.push(event);
        try {
          return value(...args);
        } catch (error) {
          event.error = {
            message: error.message,
            code: error.code,
            syscall: error.syscall,
            path: error.path,
          };
          throw error;
        }
      };
    },
  });
  const now = '2026-09-06T10:00:00Z';
  const task = {
    id: '0001-task',
    title: 'Task',
    type: 'feature',
    status: stage,
    spentUsd: 4,
    createdAt: '2026-09-05T00:00:00Z',
    statusChangedAt: '2026-09-05T00:00:00Z',
    attempts: { continuations: 2, cycleFailures: 0 },
    ...taskOverrides,
  };
  const member = { ...task, id: '0002-member', title: 'Member', ...memberOverrides };
  seedRecipient(boardPath, [task, member]);
  const report = {
    taskId: task.id,
    stage,
    outcome,
    costUsd: 3,
    summary: 'completed stage',
    denials,
    links: { pr: 172 },
    ...(batch ? { batch: [task.id, member.id], deployed: [task.id, member.id] } : {}),
    ...(requests
      ? {
          requests: [{ type: 'note', title: 'Follow up', description: 'Reason', priority: 50 }],
          amendments: [{ taskId: member.id, facts: 'Useful evidence' }],
        }
      : {}),
    ...reportOverrides,
  };
  const entry = openReportStore(queuePath).accept(report, {
    launchId: 'launch',
    startedAt: now,
    machine: 'test',
  });
  const action = { kind: 'transfer-report', taskId: task.id, stage, reportId: entry.reportId };
  const forgotten = [];
  function open() {
    const recipient = openRecipient(boardPath);
    const store = openReportStore(queuePath);
    const io = {
      ...recipient.store,
      now,
      reportStore: store,
      readReport: () => report,
      forgetSession: (...args) => {
        forgotten.push(args);
      },
    };
    return { recipient, store, io };
  }
  return {
    root,
    boardPath,
    queuePath,
    disk,
    diskEvents,
    task,
    member,
    now,
    report,
    entry,
    action,
    forgotten,
    open,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
