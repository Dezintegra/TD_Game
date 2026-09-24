import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createOwnedSupervisor } from './supervisor-startup.mjs';
import { createSupervisor } from './supervisor.mjs';
import { createIo } from './io.mjs';
import { openReportStore } from './report-store.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { stageCommand } from './stage-command.mjs';
import { toolContext } from './tool-diagnostics.mjs';
import { parseDiagnosticRequest } from './addressed-tool-diagnostics.mjs';
import {
  dispatchDiagnosticMessage,
  openDiagnosticEndpoint,
  requestDiagnostic,
  installHostDiagnosticEndpoint,
  diagnosticOwnerAvailable,
  readDiagnosticDescriptor,
} from './tool-diagnostic-endpoint.mjs';

const paths = [];
const endpoints = [];
afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory() {
  const root = join(import.meta.dirname, '../../.matchlog');
  mkdirSync(root, { recursive: true });
  const path = mkdtempSync(join(root, 'diagnostic-pipe-'));
  paths.push(path);
  return path;
}
describe('Windows addressed diagnostic transport', () => {
  it('requires attested code and the exact live entrypoint before a host client connects', async () => {
    const dir = directory();
    const lockPath = join(dir, 'supervisor.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 123 }));
    const descriptor = {
      ownerPid: 123,
      helperPid: 456,
      generation: 'generation',
      ownerSid: 'owner-sid',
      acl: 'user-only-network-denied',
      root: dir,
      lockPath,
      entrypoint: join(dir, 'supervisor', 'bin', 'supervise.mjs'),
      codeSha: 'a'.repeat(40),
      rootSha: 'b'.repeat(40),
      runtimeSha: 'a'.repeat(40),
    };
    const path = join(dir, 'diagnostic-endpoint.json');
    writeFileSync(path, JSON.stringify(descriptor));
    expect(readDiagnosticDescriptor(path)).toEqual(descriptor);
    const identity = vi.fn(async () => ({ kind: 'live' }));
    expect(await diagnosticOwnerAvailable(descriptor, { identity, attest: () => true })).toBe(true);
    expect(identity).toHaveBeenCalledWith(123, lockPath, {
      entrypoint: descriptor.entrypoint,
    });
    identity.mockClear();
    expect(await diagnosticOwnerAvailable(descriptor, { identity, attest: () => false })).toBe(
      false,
    );
    expect(identity).not.toHaveBeenCalled();
    writeFileSync(lockPath, JSON.stringify({ pid: 999 }));
    expect(await diagnosticOwnerAvailable(descriptor, { identity, attest: () => true })).toBe(
      false,
    );
    writeFileSync(path, JSON.stringify({ ...descriptor, runtimeSha: descriptor.rootSha }));
    expect(() => readDiagnosticDescriptor(path)).toThrow('invalid-endpoint-descriptor');
  });
  it.skipIf(process.platform !== 'win32')(
    'refuses an anonymous OS pipe caller before dispatch',
    async () => {
      const dir = directory();
      let calls = 0;
      const endpoint = await openDiagnosticEndpoint({
        directory: dir,
        owns: () => true,
        handler: {
          get: () => {
            calls++;
            return { ok: true };
          },
        },
      });
      endpoints.push(endpoint);
      const script = join(dir, 'anonymous-client.ps1');
      writeFileSync(
        script,
        String.raw`param([string]$Name)
$ErrorActionPreference = 'Stop'
$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $Name, 'InOut', 'None', 'Anonymous')
try {
  $pipe.Connect(5000)
  $bytes = [BitConverter]::GetBytes([int]1)
  $pipe.Write($bytes, 0, 4)
  $pipe.WriteByte(0)
  [Console]::WriteLine($pipe.ReadByte())
} finally { $pipe.Dispose() }
`,
      );
      const result = await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          script,
          '-Name',
          endpoint.descriptor.pipe.split('\\').at(-1),
        ],
        { windowsHide: true, timeout: 10000 },
      );
      expect(result.stdout.trim()).toBe('-1');
      expect(calls).toBe(0);
      expect(endpoint.refusals.length).toBeGreaterThan(0);
    },
    20000,
  );
  it.skipIf(process.platform !== 'win32')(
    'gets the saved result after response loss without resubmitting and checks owner/generation on the real endpoint',
    async () => {
      let owner = true;
      let submits = 0;
      let saved;
      let entered;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      const endpoint = await openDiagnosticEndpoint({
        directory: directory(),
        owns: () => owner,
        handler: {
          submit: async () => {
            submits++;
            saved = { ok: true, requestId: 'lost' };
            entered();
            await delay(300);
            return saved;
          },
          get: () => saved,
        },
      });
      endpoints.push(endpoint);
      const lost = requestDiagnostic(
        endpoint.descriptor,
        { operation: 'submit', request: {} },
        { timeoutMs: 100 },
      );
      await started;
      expect(await lost).toEqual({ ok: false, reason: 'transport-timeout' });
      await delay(350);
      expect(
        await requestDiagnostic(endpoint.descriptor, { operation: 'get', requestId: 'lost' }),
      ).toEqual(saved);
      expect(submits).toBe(1);
      expect(
        await requestDiagnostic(
          { ...endpoint.descriptor, generation: 'replacement' },
          { operation: 'get', requestId: 'lost' },
        ),
      ).toEqual({ ok: false, reason: 'generation-mismatch' });
      owner = false;
      expect(
        await requestDiagnostic(endpoint.descriptor, { operation: 'get', requestId: 'lost' }),
      ).toEqual({ ok: false, reason: 'owner-unavailable' });
      expect(submits).toBe(1);
    },
    15000,
  );
  it.skipIf(process.platform !== 'win32')(
    'uses the owned runtime store, scheduler reservation and accounting across a client/runtime restart',
    async () => {
      const dir = directory();
      const home = join(import.meta.dirname, '..');
      const { config } = resolveConfig({ provider: 'claude', maxConcurrent: 1 });
      const request = {
        schemaVersion: 1,
        requestId: 'restart',
        taskId: '0156-svesti-komandy-etapov-k-odnoy-obolochke-',
        stage: 'revise',
        sourceLaunchId: 'unknown',
        profile: 'historical-revise',
      };
      const fingerprint = parseDiagnosticRequest(request).fingerprint;
      const task = { id: request.taskId, status: 'failed', attempts: { continuations: 2 } };
      const assignment = {
        taskId: task.id,
        stage: request.stage,
        path: '.',
        task,
        continuation: false,
        sessionId: null,
      };
      const source = {
        taskId: task.id,
        stage: request.stage,
        cwd: dir,
        branch: 'own',
        head: 'a'.repeat(40),
        providerVersion: 'fixture-version',
        runtimeSha: 'b'.repeat(40),
        context: toolContext(
          stageCommand({ assignment, prompt: '', config, root: dir, home }),
          'claude',
        ),
        sourceLaunchId: 'unknown',
        task,
        history: { state: 'unknown' },
      };
      const path = join(dir, 'pending-reports.json');
      let spawns = 0;
      let codeRevision = 'b'.repeat(40);
      let race;
      let runtime;
      const spawnStage = () => {
        spawns++;
        race = runtime.spawnStage(assignment);
        const child = new EventEmitter();
        child.pid = 10000 + spawns;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = new EventEmitter();
        child.stdin.end = () =>
          setImmediate(() => {
            child.stdout.emit(
              'data',
              JSON.stringify({
                type: 'result',
                subtype: 'success',
                session_id: `session-${spawns}`,
                total_cost_usd: 0.25,
                result: '{}',
              }),
            );
            child.emit('close', 0);
          });
        return child;
      };
      const makeRuntime = () =>
        createOwnedSupervisor({
          claim: () => ({ acquired: true }),
          createSupervisor: () =>
            createSupervisor({
              config,
              root: dir,
              home,
              initialize: false,
              spawn: spawnStage,
              killTree: () => {},
              saveStages: () => {},
              stages: {},
              reportStore: openReportStore(path),
            }),
        }).supervisor;
      runtime = makeRuntime();
      const report = runtime.reportStore.accept(
        { taskId: 'ordinary', stage: 'implement', outcome: 'done' },
        { launchId: 'ordinary-launch' },
      );
      runtime.reportStore.update(report.reportId, {
        plan: { operations: ['one', 'two'] },
        progress: ['one'],
      });
      const held = runtime.reportStore.retain(
        { report: null },
        { taskId: 'held', stage: 'revise', launchId: 'held-launch' },
      );
      runtime.reportStore.update(held.reportId, { disposition: 'infrastructure-held' });
      const reports = runtime.reportStore.entries();
      const install = async () => {
        const endpoint = await installHostDiagnosticEndpoint({
          runtime,
          config,
          root: dir,
          home,
          directory: dir,
          lockPath: join(dir, 'supervisor.lock'),
          owns: () => true,
          readRegistry: () => ({ entries: [{ taskId: task.id, path: dir, branch: 'own' }] }),
          readStages: () => ({}),
          readTask: () => task,
          getEnvironment: () => undefined,
          isPaused: () => true,
          mayDiagnose: () => ({ allowed: true }),
          attestCode: () => ({
            root: dir,
            entrypoint: join(home, 'bin', 'supervise.mjs'),
            codeSha: codeRevision,
            rootSha: 'b'.repeat(40),
          }),
          runCommand: (args, program) => ({
            code: 0,
            stdout:
              program !== 'git'
                ? 'fixture-version'
                : args.includes('status')
                  ? ''
                  : args.includes('branch')
                    ? 'own'
                    : args.includes(dir) && args.length === 4
                      ? 'b'.repeat(40)
                      : 'a'.repeat(40),
          }),
          spawn: spawnStage,
          killTree: () => {},
        });
        endpoints.push(endpoint);
        const descriptor = endpoint.descriptor;
        writeFileSync(
          join(dir, 'diagnostic-authorizations.json'),
          JSON.stringify({
            schemaVersion: 1,
            requests: [
              {
                requestId: request.requestId,
                fingerprint,
                generation: descriptor.generation,
                ownerUser: descriptor.ownerUser,
                noCompetingOwner: true,
                coordinationEvidence: 'own fixture; no external assignments',
                expiresAt: new Date(Date.now() + 600000).toISOString(),
                duringPause: true,
                source: { ...source, head: 'b'.repeat(40), generation: descriptor.generation },
              },
            ],
          }),
        );
        return endpoint;
      };
      let endpoint = await install();
      const grantsPath = join(dir, 'diagnostic-authorizations.json');
      const grants = JSON.parse(readFileSync(grantsPath, 'utf8'));
      writeFileSync(grantsPath, JSON.stringify({ schemaVersion: 1, requests: [] }));
      expect(
        (await requestDiagnostic(endpoint.descriptor, { operation: 'submit', request })).reason,
      ).toBe('unauthorized-or-expired');
      grants.requests[0].prepareOnly = true;
      delete grants.requests[0].source;
      writeFileSync(grantsPath, JSON.stringify(grants));
      const prepared = await requestDiagnostic(endpoint.descriptor, {
        operation: 'submit',
        request,
      });
      expect(prepared).toMatchObject({
        ok: false,
        reason: 'owner-confirmation-required',
        source: { task, branch: 'own', cwd: dir },
      });
      expect(spawns).toBe(0);
      expect(runtime.reportStore.diagnosticEntries()).toEqual([]);
      grants.requests[0].source = prepared.source;
      grants.requests[0].prepareOnly = false;
      writeFileSync(grantsPath, JSON.stringify(grants));
      codeRevision = 'c'.repeat(40);
      expect(
        await requestDiagnostic(endpoint.descriptor, { operation: 'submit', request }),
      ).toEqual({ ok: false, reason: 'unverified-context-or-ownership' });
      expect(spawns).toBe(0);
      expect(runtime.reportStore.diagnosticEntries()).toEqual([]);
      codeRevision = 'b'.repeat(40);
      const first = await requestDiagnostic(endpoint.descriptor, { operation: 'submit', request });
      expect(first, JSON.stringify(first)).toMatchObject({
        ok: true,
        entry: { state: 'completed' },
      });
      expect(spawns).toBe(2);
      expect(race).toMatchObject({ ok: false, reason: 'busy' });
      expect(first.entry.launches.map((launch) => launch.receipt.costUsd)).toEqual([0.25, 0.25]);
      for (const [index, primary] of first.entry.result.primary.entries())
        expect(primary.sha256).toBe(
          createHash('sha256')
            .update(JSON.stringify(first.entry.launches[index].run))
            .digest('hex'),
        );
      expect(runtime.reportStore.entries()).toEqual(reports);
      await endpoint.close();
      endpoints.pop();
      runtime = makeRuntime();
      endpoint = await install();
      const io = createIo({ root: dir, config, reportStore: runtime.reportStore });
      expect(io.reportStore).toBe(runtime.reportStore);
      const second = await requestDiagnostic(endpoint.descriptor, {
        operation: 'get',
        requestId: request.requestId,
      });
      expect(second).toEqual(first);
      expect(spawns).toBe(2);
      expect(runtime.reportStore.entries()).toEqual(reports);
      runtime.reportStore.acknowledge(report.reportId);
      expect(runtime.reportStore.entries()).toEqual([reports[1]]);
      expect(
        await requestDiagnostic(endpoint.descriptor, {
          operation: 'get',
          requestId: request.requestId,
        }),
      ).toEqual(first);
      expect(runtime.reportRestartState.pendingProblem).toBeNull();
      writeFileSync(path, '{}');
      expect(runtime.reportStorageBlocked).toBe(true);
      expect(runtime.reportRestartState.pendingProblem).not.toBeNull();
      expect(
        (
          await requestDiagnostic(endpoint.descriptor, {
            operation: 'get',
            requestId: request.requestId,
          })
        ).ok,
      ).toBe(false);
    },
    30000,
  );
  it('rejects foreign callers, owner loss and generation replacement before dispatch', async () => {
    let calls = 0;
    const options = {
      message: { operation: 'get', requestId: 'one', generation: 'g' },
      caller: 'owner',
      ownerUser: 'owner',
      generation: 'g',
      owns: () => true,
      handler: {
        get: () => {
          calls++;
          return { ok: true };
        },
      },
    };
    expect(await dispatchDiagnosticMessage({ ...options, caller: 'foreign' })).toEqual({
      ok: false,
      reason: 'foreign-client',
    });
    expect(await dispatchDiagnosticMessage({ ...options, generation: 'new' })).toEqual({
      ok: false,
      reason: 'generation-mismatch',
    });
    expect(await dispatchDiagnosticMessage({ ...options, owns: () => false })).toEqual({
      ok: false,
      reason: 'owner-unavailable',
    });
    expect(calls).toBe(0);
    expect(await dispatchDiagnosticMessage(options)).toEqual({ ok: true });
    expect(calls).toBe(1);
  });
  it.skipIf(process.platform !== 'win32')(
    'round trips through a real user-only Windows pipe',
    async () => {
      const endpoint = await openDiagnosticEndpoint({
        directory: directory(),
        owns: () => true,
        handler: { get: (id) => ({ ok: true, id }) },
      });
      endpoints.push(endpoint);
      expect(endpoint.descriptor.acl).toBe('user-only-network-denied');
      const result = await requestDiagnostic(endpoint.descriptor, {
        operation: 'get',
        requestId: 'one',
      });
      expect({ result, refusals: endpoint.refusals }).toEqual({
        result: { ok: true, id: 'one' },
        refusals: [],
      });
    },
    25000,
  );
});
