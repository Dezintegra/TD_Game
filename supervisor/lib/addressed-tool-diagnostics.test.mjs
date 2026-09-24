import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openReportStore } from './report-store.mjs';
import {
  createAddressedToolDiagnostics,
  parseDiagnosticRequest,
} from './addressed-tool-diagnostics.mjs';
import { createToolDiagnosticAccounting } from './tool-diagnostic-accounting.mjs';

const directories = [];
const { structuredClone } = globalThis;
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true });
});
const taskId = '0156-svesti-komandy-etapov-k-odnoy-obolochke-';
const request = {
  schemaVersion: 1,
  requestId: 'one',
  taskId,
  stage: 'revise',
  sourceLaunchId: 'unknown',
  profile: 'historical-revise',
};
function fixture() {
  const base = join(import.meta.dirname, '../../.matchlog');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'addressed-test-'));
  directories.push(dir);
  const path = join(dir, 'store.json');
  const store = openReportStore(path);
  const source = {
    taskId,
    stage: 'revise',
    cwd: dir,
    branch: 'own',
    head: 'a'.repeat(40),
    providerVersion: 'test',
    runtimeSha: 'b'.repeat(40),
    generation: 'gen',
    context: { provider: 'claude', cwd: dir, environmentId: 'env', permissionsId: 'permissions' },
    history: { state: 'unknown' },
    task: { id: taskId, status: 'blocked', attempts: { continuations: 2 } },
    merge: { state: 'unknown' },
  };
  let reserved = false;
  let launches = 0;
  let checked = 0;
  const flags = {
    authorized: true,
    verified: true,
    busy: false,
    paused: false,
    duringPause: false,
    allowed: true,
    changed: false,
  };
  const options = {
    store,
    authorize: (_request, fingerprint) => ({
      allowed: flags.authorized,
      fingerprint,
      source: structuredClone(source),
      generation: 'gen',
      duringPause: flags.duringPause,
    }),
    inspect: () => {
      checked++;
      return {
        verified: flags.verified,
        busy: flags.busy,
        paused: flags.paused,
        source: { ...source, ...(flags.changed && checked > 1 ? { branch: 'foreign' } : {}) },
      };
    },
    acquire: () => {
      if (reserved) return null;
      reserved = true;
      return () => {
        reserved = false;
      };
    },
    admit: () => ({ allowed: flags.allowed }),
    accounting: (callbacks) =>
      createToolDiagnosticAccounting({ ...callbacks, config: { provider: 'claude' } }),
    diagnose: async ({ onStart, onResult }) => {
      await onStart('launch', {
        id: 'read-revise',
        argv: ['Get-Content', 'supervisor/skills/revise.md'],
      });
      launches++;
      const run = {
        code: 0,
        stdout: JSON.stringify({
          type: 'result',
          subtype: 'success',
          total_cost_usd: 0.25,
          session_id: 'session',
          result: '{}',
        }),
      };
      await onResult('launch', run, { startedAt: 1, finishedAt: 2 });
      return { verdict: 'inconclusive', checks: [], runs: [{ ...run, launchId: 'launch' }] };
    },
  };
  return {
    path,
    store,
    source,
    flags,
    options,
    launches: () => launches,
    reserved: () => reserved,
  };
}

describe('addressed historical diagnostics', () => {
  it('retains raw output on accounting failure and holds every new request for the assignment', async () => {
    const f = fixture();
    f.options.accounting = (callbacks) => ({
      onStart: callbacks.saveIntent,
      onResult: async (...args) => {
        await callbacks.saveRaw(...args);
        throw new Error('accounting unavailable');
      },
    });
    const handler = createAddressedToolDiagnostics(f.options);
    expect((await handler.submit(request)).reason).toBe('accounting unavailable');
    expect(handler.blocked).toBe(true);
    expect(f.store.getDiagnostic('one').launches[0]).toMatchObject({
      state: 'raw',
      run: { code: 0 },
    });
    expect((await handler.submit({ ...request, requestId: 'replacement' })).reason).toBe('busy');
    const restarted = createAddressedToolDiagnostics({
      ...f.options,
      store: openReportStore(f.path),
    });
    expect((await restarted.get('one')).entry.state).toBe('uncertain');
    expect(f.launches()).toBe(1);
  });
  it.each(['blocked', 'failed'])(
    'diagnoses %s without an envelope and preserves source state',
    async (status) => {
      const f = fixture();
      f.source.task.status = status;
      const before = structuredClone(f.source);
      const handler = createAddressedToolDiagnostics(f.options);
      const result = await handler.submit(request);
      expect(result.ok).toBe(true);
      expect(f.launches()).toBe(1);
      expect(f.store.entries()).toEqual([]);
      expect(f.source).toEqual(before);
      expect(f.reserved()).toBe(false);
      const restarted = createAddressedToolDiagnostics({
        ...f.options,
        store: openReportStore(f.path),
      });
      expect(await restarted.get('one')).toEqual(result);
      expect(await restarted.submit(request)).toEqual(result);
      expect(f.launches()).toBe(1);
      expect((await restarted.submit({ ...request, sourceLaunchId: 'different' })).reason).toBe(
        'fingerprint-conflict',
      );
    },
  );
  it.each([
    [{ authorized: false }, 'unauthorized'],
    [{ verified: false }, 'unverified-context-or-ownership'],
    [{ busy: true }, 'busy'],
    [{ paused: true }, 'manual-pause'],
    [{ allowed: false }, 'launch-held'],
    [{ changed: true }, 'unverified-context-or-ownership'],
  ])('fails closed for %j', async (flags, reason) => {
    const f = fixture();
    Object.assign(f.flags, flags);
    expect(await createAddressedToolDiagnostics(f.options).submit(request)).toEqual({
      ok: false,
      reason,
    });
    expect(f.launches()).toBe(0);
    expect(f.reserved()).toBe(false);
  });
  it('requires scoped authorization during pause and keeps an existing held envelope untouched', async () => {
    const f = fixture();
    Object.assign(f.flags, { paused: true, duringPause: true });
    const held = f.store.retain(
      { report: null },
      { taskId, stage: 'revise', launchId: 'historical' },
    );
    f.store.update(held.reportId, { disposition: 'infrastructure-held' });
    const before = f.store.entries();
    expect((await createAddressedToolDiagnostics(f.options).submit(request)).ok).toBe(true);
    expect(f.store.entries()).toEqual(before);
    expect(f.flags.paused).toBe(true);
  });
  it('shares a reservation with scheduling and other diagnostic requests', async () => {
    const f = fixture();
    const release = f.options.acquire(taskId);
    const handler = createAddressedToolDiagnostics(f.options);
    expect((await handler.submit(request)).reason).toBe('busy');
    release();
    let continueRun;
    const wait = new Promise((resolve) => {
      continueRun = resolve;
    });
    const original = f.options.diagnose;
    f.options.diagnose = async (args) => {
      await wait;
      return original(args);
    };
    const active = createAddressedToolDiagnostics(f.options);
    const pending = active.submit(request);
    for (let i = 0; i < 20 && active.activeCount === 0; i++) await Promise.resolve();
    expect(f.options.acquire(taskId)).toBe(null);
    expect((await active.submit({ ...request, requestId: 'two' })).reason).toBe('busy');
    continueRun();
    expect((await pending).ok).toBe(true);
  });
  it('refuses new launches after an uncertain restart and rejects executable overrides', async () => {
    const f = fixture();
    const { fingerprint } = parseDiagnosticRequest(request);
    f.store.acceptDiagnostic(request, {
      fingerprint,
      source: f.source,
      authorization: { generation: 'gen' },
      at: '2026-09-24T00:00:00Z',
    });
    f.store.diagnosticLaunchIntent('one', {
      launchId: 'unknown-spawn',
      startedAt: '2026-09-24T00:00:01Z',
      control: { id: 'read' },
    });
    const handler = createAddressedToolDiagnostics({
      ...f.options,
      store: openReportStore(f.path),
    });
    expect((await handler.submit(request)).entry.state).toBe('uncertain');
    expect((await handler.submit({ ...request, requestId: 'two' })).reason).toBe('busy');
    for (const extra of [
      { command: 'anything' },
      { env: {} },
      { cwd: 'foreign' },
      { profile: 'default' },
    ])
      expect((await handler.submit({ ...request, ...extra })).ok).toBe(false);
    expect(f.launches()).toBe(0);
  });
});
