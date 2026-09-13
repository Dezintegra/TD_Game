import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { openReportStore, sameReportLaunch } from './report-store.mjs';

const directories = [];
function fixture() {
  const base = join(import.meta.dirname, '../../.matchlog');
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(join(base, 'report-store-'));
  directories.push(directory);
  return join(directory, 'pending.json');
}
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
const report = {
  taskId: '0233-report',
  stage: 'implement',
  outcome: 'done',
  costUsd: 2,
  denials: [],
  batch: ['0234-member'],
};

describe('durable report queue', () => {
  it('restores payload, plan and progress and acknowledges exactly one launch', () => {
    const path = fixture();
    const store = openReportStore(path);
    const first = store.accept(report, { launchId: 'one' });
    expect(store.accept(report, { launchId: 'one' }).reportId).toBe(first.reportId);
    const second = store.accept(report, { launchId: 'two' });
    expect(second.reportId).not.toBe(first.reportId);
    store.update(first.reportId, { plan: { operations: ['save'] }, progress: ['save'] });
    const reopened = openReportStore(path);
    expect(reopened.get(first.reportId)).toMatchObject({
      report,
      plan: { operations: ['save'] },
      progress: ['save'],
    });
    reopened.acknowledge(first.reportId);
    reopened.acknowledge(first.reportId);
    expect(openReportStore(path).entries()).toEqual([second]);
  });
  it('does not expose mutable state and ignores an uncommitted temporary file', () => {
    const path = fixture();
    fs.writeFileSync(`${path}.tmp`, 'broken');
    const store = openReportStore(path);
    expect(store.entries()).toEqual([]);
    const entry = store.accept(report);
    entry.report.outcome = 'failed';
    expect(store.get(entry.reportId).report.outcome).toBe('done');
  });
  it.each(['broken', '{"version":2,"reports":[]}', '{"version":1,"reports":[{}]}'])(
    'preserves invalid data: %s',
    (data) => {
      const path = fixture();
      fs.writeFileSync(path, data);
      expect(() => openReportStore(path)).toThrow(path);
      expect(fs.readFileSync(path, 'utf8')).toBe(data);
    },
  );
  it.each(['writeFileSync', 'fsyncSync', 'renameSync'])(
    'retains the prior queue on %s failure',
    (method) => {
      const path = fixture();
      const first = openReportStore(path).accept(report, { launchId: 'one' });
      const disk = {
        ...fs,
        [method]: () => {
          throw new Error('injected disk failure');
        },
      };
      const store = openReportStore(path, { disk });
      expect(() => store.accept(report, { launchId: 'two' })).toThrow('injected disk failure');
      expect(() => store.acknowledge(first.reportId)).toThrow('injected disk failure');
      expect(store.entries()).toEqual([first]);
      expect(openReportStore(path).entries()).toEqual([first]);
    },
  );
  it('does not treat access failure as an empty queue', () => {
    expect(() =>
      openReportStore(fixture(), {
        disk: {
          readFileSync: () => {
            throw Object.assign(new Error('access denied'), { code: 'EACCES' });
          },
        },
      }),
    ).toThrow('access denied');
  });
  it('requires full legacy identity and distinguishes newer launches', () => {
    const entry = {
      taskId: report.taskId,
      stage: report.stage,
      startedAt: 'yesterday',
      machine: 'station',
    };
    expect(sameReportLaunch(entry, entry)).toBe(true);
    expect(sameReportLaunch(entry, { ...entry, startedAt: 'today' })).toBe(false);
    expect(sameReportLaunch(entry, { ...entry, launchId: 'new' })).toBe(false);
    expect(
      sameReportLaunch({ taskId: 'x', stage: 'implement' }, { taskId: 'x', stage: 'implement' }),
    ).toBe(false);
  });
});
