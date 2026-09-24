import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { openReportStore, sameReportLaunch } from './report-store.mjs';
import { launchCharge, confirmLaunchCharge, gitWorkEvidence } from './tool-work-evidence.mjs';

const directories = [];
const diagnosticRequest = {
  schemaVersion: 1,
  requestId: 'addressed',
  taskId: 'stopped',
  stage: 'revise',
  sourceLaunchId: 'unknown',
  profile: 'historical-revise',
};
const diagnosticMeta = {
  fingerprint: 'fingerprint',
  source: { branch: 'own', cwd: 'tree' },
  authorization: { generation: 'generation' },
  at: '2026-09-24T20:00:00Z',
};
const diagnosticLaunch = {
  launchId: 'diagnostic-launch',
  startedAt: '2026-09-24T20:00:01Z',
  control: { id: 'git-status', argv: ['git', 'status'] },
};

describe('addressed diagnostics in the shared store', () => {
  it('preserves both collections, held state and report progress across interleaved writes', () => {
    const path = fixture();
    const store = openReportStore(path);
    const ordinary = store.accept(report, { launchId: 'ordinary' });
    store.update(ordinary.reportId, { plan: { operations: ['a', 'b'] }, progress: ['a'] });
    const held = store.retain(
      { report: null },
      { taskId: 'held', stage: 'revise', launchId: 'held-launch' },
    );
    store.update(held.reportId, { disposition: 'infrastructure-held' });
    const before = store.entries();
    store.acceptDiagnostic(diagnosticRequest, diagnosticMeta);
    store.diagnosticLaunchIntent('addressed', diagnosticLaunch);
    store.diagnosticRawResult('addressed', diagnosticLaunch.launchId, {
      code: 0,
      stdout: 'evidence',
    });
    expect(() => store.completeDiagnostic('addressed', { verdict: 'healthy' })).toThrow(
      'accounting pending',
    );
    store.diagnosticAccounted('addressed', diagnosticLaunch.launchId, {
      tokens: 12,
      state: 'accounted',
    });
    const completed = store.completeDiagnostic('addressed', { verdict: 'healthy' });
    expect(store.entries()).toEqual(before);
    const reopened = openReportStore(path);
    expect(reopened.getDiagnostic('addressed')).toEqual(completed);
    expect(reopened.acceptDiagnostic(diagnosticRequest, diagnosticMeta)).toEqual(completed);
    expect(() =>
      reopened.acceptDiagnostic(diagnosticRequest, { ...diagnosticMeta, fingerprint: 'changed' }),
    ).toThrow('conflict');
    expect(() =>
      reopened.acceptDiagnostic({ ...diagnosticRequest, stage: 'audit' }, diagnosticMeta),
    ).toThrow('conflict');
    reopened.acknowledge(ordinary.reportId);
    expect(openReportStore(path).entries()).toEqual([before[1]]);
    expect(openReportStore(path).getDiagnostic('addressed')).toEqual(completed);
    expect(reopened.verifySaved()).toEqual({ ok: true, count: 1 });
    const disk = JSON.parse(fs.readFileSync(path, 'utf8'));
    disk.diagnosticRequests[0].result.verdict = 'changed';
    fs.writeFileSync(path, JSON.stringify(disk));
    expect(reopened.verifySaved().ok).toBe(false);
  });
  it.each([1, 2])('migrates version %s without discarding report fields', (version) => {
    const path = fixture();
    const ordinary = openReportStore(path).accept(report, { launchId: 'old' });
    fs.writeFileSync(path, JSON.stringify({ version, reports: [ordinary] }));
    const store = openReportStore(path);
    store.acceptDiagnostic(diagnosticRequest, diagnosticMeta);
    expect(openReportStore(path).entries()).toEqual([ordinary]);
    const value = JSON.parse(fs.readFileSync(path, 'utf8'));
    value.version = version;
    fs.writeFileSync(path, JSON.stringify(value));
    expect(() => openReportStore(path)).toThrow('legacy store');
  });
  it('exposes restored running requests as uncertain and never creates another launch', () => {
    const path = fixture();
    const store = openReportStore(path);
    store.acceptDiagnostic(diagnosticRequest, diagnosticMeta);
    store.diagnosticLaunchIntent('addressed', diagnosticLaunch);
    const reopened = openReportStore(path);
    expect(reopened.getDiagnostic('addressed').state).toBe('uncertain');
    expect(() =>
      reopened.diagnosticLaunchIntent('addressed', { ...diagnosticLaunch, launchId: 'duplicate' }),
    ).toThrow('uncertain');
    expect(reopened.verifySaved().ok).toBe(true);
    expect(openReportStore(path).getDiagnostic('addressed').state).toBe('uncertain');
  });
  it.each(['intent', 'raw', 'completion', 'readback'])(
    'retains %s failure for storage retry without another launch',
    (failure) => {
      const path = fixture();
      let fail = false;
      const store = openReportStore(path, {
        disk: {
          ...fs,
          renameSync: (...args) => {
            if (fail && failure !== 'readback') throw new Error('disk failure');
            return fs.renameSync(...args);
          },
          readFileSync: (...args) => {
            if (fail && failure === 'readback') throw new Error('readback failure');
            return fs.readFileSync(...args);
          },
        },
      });
      store.acceptDiagnostic(diagnosticRequest, diagnosticMeta);
      if (failure !== 'intent') store.diagnosticLaunchIntent('addressed', diagnosticLaunch);
      if (['completion', 'readback'].includes(failure)) {
        store.diagnosticRawResult('addressed', diagnosticLaunch.launchId, { code: 0 });
        store.diagnosticAccounted('addressed', diagnosticLaunch.launchId, {
          state: 'accounted',
          tokens: 3,
        });
      }
      fail = true;
      expect(() => {
        if (failure === 'intent') store.diagnosticLaunchIntent('addressed', diagnosticLaunch);
        else if (failure === 'raw')
          store.diagnosticRawResult('addressed', diagnosticLaunch.launchId, { code: 0 });
        else store.completeDiagnostic('addressed', { verdict: 'healthy' });
      }).toThrow('failure');
      expect(store.verifySaved().ok).toBe(false);
      expect(() => store.getDiagnostic('addressed')).toThrow('storage pending');
      expect(() => store.accept(report)).toThrow('storage pending');
      fail = false;
      store.retryDiagnosticStorage();
      expect(store.verifySaved().ok).toBe(true);
      expect(store.getDiagnostic('addressed').launches).toHaveLength(1);
      expect(openReportStore(path).getDiagnostic('addressed').launches).toHaveLength(1);
    },
  );
});
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
  it('migrates existing ordinary plans and rejections without reclassification', () => {
    const path = fixture();
    const entries = [
      {
        reportId: 'planned',
        taskId: report.taskId,
        stage: report.stage,
        report,
        plan: { operations: ['write'] },
        progress: ['write'],
      },
      {
        reportId: 'rejected',
        taskId: report.taskId,
        stage: report.stage,
        report,
        plan: null,
        progress: [],
        rejection: { kind: 'invalid-report', why: 'bad', at: '2026-09-14T00:00:00Z' },
      },
    ];
    fs.writeFileSync(path, JSON.stringify({ version: 1, reports: entries }));
    const store = openReportStore(path);
    expect(store.entries()).toEqual(
      entries.map((entry) => ({ ...entry, disposition: 'ordinary' })),
    );
    expect(store.verifySaved().ok).toBe(true);
    expect(() => store.update('planned', { disposition: 'infrastructure-held' })).toThrow(
      'reclassify',
    );
    store.update('planned', { progress: ['write', 'confirm'] });
    expect(openReportStore(path).get('rejected').rejection).toEqual(entries[1].rejection);
  });
  it('retains a null report, trusted batch and unknown work across restart', () => {
    const path = fixture();
    const store = openReportStore(path);
    const original = { report: null, raw: '{broken', why: 'invalid JSON', usage: { tokens: 12 } };
    const launch = {
      taskId: 'lead',
      stage: 'deploy',
      launchId: 'launch',
      batch: ['lead', 'member'],
      charge: launchCharge('launch'),
      assignment: { branch: 'own', deployment: { revision: 'abc' } },
    };
    const entry = store.retain(original, launch);
    original.raw = 'changed';
    expect(store.retain({ report: {} }, launch).reportId).toBe(entry.reportId);
    expect(openReportStore(path).get(entry.reportId)).toMatchObject({
      report: null,
      batch: ['lead', 'member'],
      originalResult: { raw: '{broken' },
      git: { state: 'unknown' },
      charge: { state: 'not-required' },
    });
    expect(() => store.update(entry.reportId, { disposition: 'ordinary' })).toThrow(
      'invalid report envelope',
    );
    store.update(entry.reportId, {
      disposition: 'infrastructure-held',
      evidence: { verdict: 'confirmed' },
    });
    expect(openReportStore(path).get(entry.reportId).disposition).toBe('infrastructure-held');
    expect(() => store.update(entry.reportId, { charge: launchCharge('other') })).toThrow(
      'another launch',
    );
  });
  it('does not infer charging from attempts or turn unknown Git into a clean tail', () => {
    const pending = launchCharge('one', true);
    expect(confirmLaunchCharge(pending, { continuations: 2 })).toEqual(pending);
    expect(
      confirmLaunchCharge(pending, { key: pending.key, launchId: 'other', confirmed: true }),
    ).toEqual(pending);
    expect(
      confirmLaunchCharge(pending, { key: pending.key, launchId: 'one', confirmed: true }).state,
    ).toBe('confirmed');
    expect(gitWorkEvidence(null, { head: 'old' })).toMatchObject({
      state: 'unknown',
      previous: { head: 'old' },
    });
    const read = (stdout) => ({ code: 0, stdout });
    const readings = {
      head: read('a'.repeat(40)),
      branch: read('own'),
      upstream: read('origin/own'),
      tail: read('b'.repeat(40)),
      dirty: read('?? work.txt'),
    };
    expect(gitWorkEvidence(readings)).toMatchObject({
      state: 'known',
      tail: ['b'.repeat(40)],
      dirty: ['?? work.txt'],
    });
    expect(gitWorkEvidence({ ...readings, tail: { code: 1, stdout: '' } }).state).toBe('unknown');
  });
  it('proves the complete persisted envelope, including rejection and progress', () => {
    const path = fixture();
    const store = openReportStore(path);
    expect(store.verifySaved()).toEqual({ ok: true, count: 0 });
    const entry = store.accept(report);
    store.reject(entry.reportId, { why: 'invalid incident', at: '2026-09-13T10:00:00Z' });
    expect(store.verifySaved()).toEqual({ ok: true, count: 1 });
    const saved = fs.readFileSync(path, 'utf8');
    for (const mutation of [
      (value) => {
        value.reports[0].report.costUsd = 999;
      },
      (value) => {
        value.reports[0].rejection.why = 'changed';
      },
      (value) => {
        value.reports = [];
      },
    ]) {
      const value = JSON.parse(saved);
      mutation(value);
      fs.writeFileSync(path, JSON.stringify(value));
      expect(store.verifySaved()).toMatchObject({ ok: false, count: 0 });
    }
    fs.writeFileSync(path, 'broken');
    expect(store.verifySaved()).toMatchObject({ ok: false, count: 0 });
    fs.unlinkSync(path);
    expect(store.verifySaved()).toMatchObject({ ok: false, count: 0 });
    fs.writeFileSync(path, saved);
    expect(store.verifySaved()).toEqual({ ok: true, count: 1 });
    let unreadable = false;
    const reader = openReportStore(path, {
      disk: {
        ...fs,
        readFileSync: (...args) => {
          if (unreadable) throw new Error('EACCES');
          return fs.readFileSync(...args);
        },
      },
    });
    unreadable = true;
    expect(reader.verifySaved()).toMatchObject({
      ok: false,
      count: 0,
      why: expect.stringContaining('EACCES'),
    });
  });
  it('retains the rejected original across restart and explicit retry', () => {
    const path = fixture();
    const store = openReportStore(path);
    const first = store.accept(report, { launchId: 'one' });
    store.reject(first.reportId, { why: 'invalid incident', at: '2026-09-13T10:00:00Z' });
    const reopened = openReportStore(path);
    expect(reopened.get(first.reportId)).toMatchObject({
      ...first,
      rejection: { kind: 'invalid-report', why: 'invalid incident' },
    });
    reopened.retry(first.reportId);
    expect(openReportStore(path).get(first.reportId)).toEqual({ ...first, rejection: null });
    reopened.update(first.reportId, { plan: { operations: [] } });
    expect(() =>
      reopened.reject(first.reportId, {
        why: 'no parking after planning',
        at: '2026-09-13T10:00:00Z',
      }),
    ).toThrow('planned report');
  });
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
  it.each(['broken', '{"version":4,"reports":[]}', '{"version":1,"reports":[{}]}'])(
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
      expect(() =>
        store.reject(first.reportId, {
          why: 'invalid incident',
          at: '2026-09-13T10:00:00Z',
        }),
      ).toThrow('injected disk failure');
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
