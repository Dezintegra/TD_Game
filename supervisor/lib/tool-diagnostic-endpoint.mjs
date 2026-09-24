import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import { resolve, relative } from 'node:path';
import { stageCommand } from './stage-command.mjs';
import { toolContext, diagnoseStageTools } from './tool-diagnostics.mjs';
import { codexGitEnvironment } from './codex-environment.mjs';
import { providerOf, codexInvocation } from './provider.mjs';
import { supervisorIdentity } from './process-identity.mjs';
import { parseDiagnosticRequest } from './addressed-tool-diagnostics.mjs';

const REQUEST_LIMIT = 65536;
const RESPONSE_LIMIT = 16 * 1024 * 1024;

// Windows PowerShell exposes the framework constructor with PipeSecurity. Node's
// public pipe API does not expose that ACL. This child transports bytes only;
// the owning Node runtime remains the sole store/ledger writer.
const PIPE_SERVER = String.raw`param([string]$PipeName)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$security = New-Object System.IO.Pipes.PipeSecurity
$security.SetAccessRuleProtection($true, $false)
$security.SetOwner($identity.User)
$network = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-2')
$security.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($network, 'FullControl', 'Deny')))
$security.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($identity.User, 'FullControl', 'Allow')))
function Read-Exact($stream, [int]$length) {
  $bytes = New-Object byte[] $length
  $offset = 0
  while ($offset -lt $length) {
    $read = $stream.ReadAsync($bytes, $offset, $length - $offset)
    if (-not $read.Wait(10000)) { throw 'pipe-read-timeout' }
    if ($read.Result -eq 0) { throw 'pipe-eof' }
    $offset += $read.Result
  }
  return ,$bytes
}
while ($true) {
  $pipe = New-Object System.IO.Pipes.NamedPipeServerStream($PipeName, 'InOut', 1, 'Byte', 'Asynchronous', 65536, 65536, $security)
  try {
    $actual = $pipe.GetAccessControl()
    $rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 2) { throw 'unverified-pipe-acl' }
    foreach ($rule in $rules) {
      if ($rule.IsInherited -or $rule.PipeAccessRights -ne [System.IO.Pipes.PipeAccessRights]::FullControl) { throw 'unverified-pipe-acl' }
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $identity.User.Value) { throw 'unverified-pipe-allow' }
      if ($rule.AccessControlType -eq 'Deny' -and $rule.IdentityReference.Value -ne 'S-1-5-2') { throw 'unverified-pipe-deny' }
    }
    [Console]::WriteLine((@{type='ready';sid=$identity.User.Value;user=$identity.Name;pid=$PID;acl='user-only-network-denied'} | ConvertTo-Json -Compress))
    $pipe.WaitForConnection()
    $header = Read-Exact $pipe 4
    $client = New-Object System.Security.Principal.NTAccount($pipe.GetImpersonationUserName())
    $clientSid = $client.Translate([System.Security.Principal.SecurityIdentifier])
    if ($clientSid.Value -ne $identity.User.Value) { throw 'foreign-pipe-client' }
    $length = [BitConverter]::ToInt32($header, 0)
    if ($length -le 0 -or $length -gt 65536) { throw 'oversized-request' }
    $body = Read-Exact $pipe $length
    [Console]::WriteLine((@{type='request';user=$identity.Name;body=[Convert]::ToBase64String($body)} | ConvertTo-Json -Compress))
    $reply = [Console]::ReadLine()
    if ($null -eq $reply) { break }
    $bytes = [Convert]::FromBase64String($reply)
    if ($bytes.Length -gt 16777216) { throw 'oversized-response' }
    $prefix = [BitConverter]::GetBytes([int]$bytes.Length)
    $pipe.Write($prefix, 0, 4)
    $write = $pipe.WriteAsync($bytes, 0, $bytes.Length)
    if (-not $write.Wait(10000)) { throw 'pipe-write-timeout' }
  } catch {
    [Console]::WriteLine((@{type='refusal';reason=$_.Exception.Message} | ConvertTo-Json -Compress))
  } finally {
    $pipe.Dispose()
  }
}
`;

/** Exact protocol, independently testable; caller identity comes from the OS helper. */
export async function dispatchDiagnosticMessage({
  message,
  caller,
  ownerUser,
  generation,
  owns,
  handler,
}) {
  if (!caller || caller !== ownerUser) return { ok: false, reason: 'foreign-client' };
  if (!(await owns())) return { ok: false, reason: 'owner-unavailable' };
  if (!message || message.generation !== generation)
    return { ok: false, reason: 'generation-mismatch' };
  const keys = Object.keys(message).sort().join(',');
  if (message.operation === 'submit' && keys === 'generation,operation,request')
    return handler.submit(message.request);
  if (
    message.operation === 'get' &&
    keys === 'generation,operation,requestId' &&
    typeof message.requestId === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(message.requestId)
  )
    return handler.get(message.requestId);
  return { ok: false, reason: 'invalid-message' };
}

/** Called only by the runtime after ownership; directory belongs to that runtime. */
export async function openDiagnosticEndpoint({
  directory,
  handler,
  owns,
  metadata = {},
  platform = process.platform,
  start = spawn,
}) {
  if (platform !== 'win32') throw new Error('windows-pipe-required');
  if (!(await owns())) throw new Error('owner-unavailable');
  const generation = randomUUID();
  const name = `td-diagnostic-${generation}`;
  const script = join(directory, `diagnostic-pipe-${generation}.ps1`);
  writeFileSync(script, PIPE_SERVER, { flag: 'wx' });
  const child = start(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-File', script, '-PipeName', name],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  let descriptor;
  const refusals = [];
  child.stdin.on('error', (error) => {
    refusals.push(error.message);
    if (refusals.length > 100) refusals.shift();
  });
  let settle;
  const ready = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  const timer = setTimeout(() => settle.reject(new Error('pipe-start-timeout')), 15000);
  child.once('error', (error) => settle.reject(error));
  child.once('exit', (code) => settle.reject(new Error(`pipe-helper-exit ${code}: ${stderr}`)));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', async (line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === 'ready') {
        if (
          event.pid !== child.pid ||
          event.acl !== 'user-only-network-denied' ||
          !event.sid ||
          !event.user
        )
          throw new Error('unverified-transport');
        if (!descriptor) {
          descriptor = {
            ...metadata,
            generation,
            pipe: `\\\\.\\pipe\\${name}`,
            ownerPid: process.pid,
            helperPid: child.pid,
            ownerUser: event.user,
            ownerSid: event.sid,
            acl: event.acl,
          };
          settle.resolve(descriptor);
        }
      } else if (event.type === 'request') {
        let answer;
        try {
          const bytes = Buffer.from(event.body, 'base64');
          if (bytes.length > REQUEST_LIMIT) throw new Error('oversized-request');
          answer = await dispatchDiagnosticMessage({
            message: JSON.parse(bytes.toString('utf8')),
            caller: event.user,
            ownerUser: descriptor.ownerUser,
            generation,
            owns,
            handler,
          });
        } catch (error) {
          answer = { ok: false, reason: error.message };
        }
        let response = Buffer.from(JSON.stringify(answer));
        if (response.length > RESPONSE_LIMIT)
          response = Buffer.from(JSON.stringify({ ok: false, reason: 'oversized-response' }));
        if (!child.stdin.destroyed) child.stdin.write(`${response.toString('base64')}\n`);
      } else if (event.type === 'refusal') {
        refusals.push(event.reason);
        if (refusals.length > 100) refusals.shift();
      }
    } catch (error) {
      settle.reject(error);
      child.kill();
    }
  });
  try {
    await ready;
    return {
      descriptor,
      refusals,
      close: () =>
        new Promise((resolve) => {
          lines.close();
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('exit', resolve);
          child.kill();
        }),
    };
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** No store or ledger access. Generation is routing, never an authorization grant. */
export async function requestDiagnostic(descriptor, operation, { timeoutMs = 150000 } = {}) {
  const started = Date.now();
  // Windows needs a new pipe instance after a disconnected client. Retrying a
  // failed connection cannot resubmit bytes; errors after connect are returned.
  while (true) {
    const result = await exchangeDiagnostic(descriptor, operation, {
      timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)),
    });
    if (
      !['EBUSY', 'ENOENT'].includes(result.reason) ||
      Date.now() - started >= Math.min(timeoutMs, 5000)
    )
      return result;
    await delay(25);
  }
}

function exchangeDiagnostic(descriptor, operation, { timeoutMs }) {
  const bytes = Buffer.from(JSON.stringify({ ...operation, generation: descriptor.generation }));
  if (bytes.length > REQUEST_LIMIT)
    return Promise.resolve({ ok: false, reason: 'oversized-request' });
  if (!/^\\\\\.\\pipe\\td-diagnostic-[a-f0-9-]+$/.test(descriptor.pipe ?? ''))
    return Promise.resolve({ ok: false, reason: 'invalid-pipe' });
  return new Promise((resolve) => {
    const socket = connect(descriptor.pipe);
    let data = Buffer.alloc(0);
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done({ ok: false, reason: 'transport-timeout' }));
    socket.once('error', (error) => done({ ok: false, reason: error.code ?? error.message }));
    socket.once('end', () => done({ ok: false, reason: 'transport-eof' }));
    socket.once('connect', () => {
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(bytes.length);
      socket.write(Buffer.concat([prefix, bytes]));
    });
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 4) return;
      const size = data.readUInt32LE(0);
      if (size > RESPONSE_LIMIT || data.length > size + 4)
        return done({ ok: false, reason: 'invalid-response-size' });
      if (data.length !== size + 4) return;
      try {
        done(JSON.parse(data.subarray(4).toString('utf8')));
      } catch {
        done({ ok: false, reason: 'invalid-response' });
      }
    });
  });
}

export function readDiagnosticDescriptor(path) {
  const descriptor = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !Number.isSafeInteger(descriptor.ownerPid) ||
    !Number.isSafeInteger(descriptor.helperPid) ||
    !descriptor.generation ||
    !descriptor.ownerSid ||
    descriptor.acl !== 'user-only-network-denied'
  )
    throw new Error('invalid-endpoint-descriptor');
  return descriptor;
}

/** Both client and server prove the existing owner; a public PID is insufficient. */
export async function diagnosticOwnerAvailable(descriptor, { identity = supervisorIdentity } = {}) {
  try {
    const lock = JSON.parse(readFileSync(descriptor.lockPath, 'utf8'));
    return (
      lock.pid === descriptor.ownerPid &&
      (await identity(lock.pid, descriptor.lockPath)).kind === 'live'
    );
  } catch {
    return false;
  }
}

/** Production wiring: exactly the store and ledger already owned by runtime. */
export async function installHostDiagnosticEndpoint({
  runtime,
  config,
  root,
  home,
  directory,
  lockPath,
  owns,
  readRegistry,
  readStages,
  readTask,
  getEnvironment,
  isPaused,
  mayDiagnose,
  runCommand,
  spawn: spawnStage,
  killTree,
}) {
  const read = (argv, program = 'git', cwd = root) => {
    const result = runCommand(argv, program, cwd, { timeout: 5000 });
    if (result.code !== 0) throw new Error('diagnostic-context-read-failed');
    return String(result.stdout ?? '').trim();
  };
  const runtimeSha = read(['-C', root, 'rev-parse', 'HEAD']);
  if (read(['-C', root, '--no-optional-locks', 'status', '--porcelain', '--', 'supervisor']))
    throw new Error('runtime-code-not-committed');
  let endpoint;
  const authorizationPath = join(directory, 'diagnostic-authorizations.json');
  const currentGrant = (request, fingerprint) => {
    const data = JSON.parse(readFileSync(authorizationPath, 'utf8'));
    const grants = data.requests?.filter((item) => item.requestId === request.requestId);
    const grant = grants?.length === 1 ? grants[0] : null;
    if (
      !endpoint ||
      data.schemaVersion !== 1 ||
      !grant ||
      grant.fingerprint !== fingerprint ||
      grant.generation !== endpoint.descriptor.generation ||
      grant.ownerUser !== endpoint.descriptor.ownerUser ||
      grant.noCompetingOwner !== true ||
      typeof grant.coordinationEvidence !== 'string' ||
      !grant.coordinationEvidence.trim() ||
      !Number.isFinite(Date.parse(grant.expiresAt)) ||
      Date.parse(grant.expiresAt) <= Date.now() ||
      Date.parse(grant.expiresAt) - Date.now() > 15 * 60 * 1000
    )
      throw new Error('unauthorized-or-expired');
    return grant;
  };
  const assignmentFor = (request, source) => ({
    taskId: request.taskId,
    stage: request.stage,
    path: relative(root, source.cwd) || '.',
    branch: source.branch,
    task: source.task,
    continuation: false,
    sessionId: null,
  });
  const inspect = async (request, authorization, preparing = false) => {
    if (!(await owns())) return { verified: false };
    const grant = currentGrant(request, authorization.fingerprint);
    if (
      JSON.stringify(grant) !==
      JSON.stringify(
        Object.fromEntries(Object.entries(authorization).filter(([key]) => key !== 'allowed')),
      )
    )
      return { verified: false };
    const entries = readRegistry().entries.filter((item) => item.taskId === request.taskId);
    if (entries.length !== 1 || !entries[0].path) return { verified: false };
    const source = preparing
      ? {
          taskId: request.taskId,
          stage: request.stage,
          sourceLaunchId: request.sourceLaunchId,
          cwd: resolve(root, entries[0].path),
          branch: entries[0].branch,
          task: await readTask(request.taskId),
          history: grant.source?.history ?? {
            state: 'unknown',
            reason: 'owner has not supplied historical provenance',
          },
        }
      : grant.source;
    if (
      !source ||
      source.sourceLaunchId !== request.sourceLaunchId ||
      source.task?.id !== request.taskId ||
      !['failed', 'blocked'].includes(source.task.status) ||
      !source.history
    )
      return { verified: false };
    if (
      entries.length !== 1 ||
      !entries[0].path ||
      resolve(root, entries[0].path) !== source.cwd ||
      entries[0].branch !== source.branch
    )
      return { verified: false };
    const stages = readStages();
    // Unknown remembered liveness cannot be reinterpreted as absence.
    if (
      Object.entries(stages).some(
        ([key, value]) => key.startsWith(`${request.taskId}:`) && value?.live,
      )
    )
      return { busy: true };
    const assignment = assignmentFor(request, source);
    const command = stageCommand({ assignment, prompt: '', config, root, home });
    const provider = providerOf(config);
    const versionCommand =
      provider === 'codex'
        ? codexInvocation(config, ['--version'])
        : { program: command.program, args: ['--version'] };
    const env =
      provider === 'codex' ? codexGitEnvironment(getEnvironment(), root, command.cwd) : undefined;
    const current = {
      ...source,
      cwd: resolve(command.cwd),
      context: toolContext(command, provider, env),
      branch: read(['-C', source.cwd, 'branch', '--show-current']),
      head: read(['-C', source.cwd, 'rev-parse', 'HEAD']),
      providerVersion: read(versionCommand.args, versionCommand.program, command.cwd),
      runtimeSha: read(['-C', root, 'rev-parse', 'HEAD']),
      generation: endpoint.descriptor.generation,
    };
    if (
      current.runtimeSha !== runtimeSha ||
      read(['-C', root, '--no-optional-locks', 'status', '--porcelain', '--', 'supervisor'])
    )
      return { verified: false };
    return { verified: true, source: current, paused: isPaused() };
  };
  const handler = runtime.createAddressedDiagnostics({
    authorize: (request, fingerprint) => {
      const grant = currentGrant(request, fingerprint);
      if (grant.prepareOnly === true) throw new Error('owner-confirmation-required');
      return { ...grant, allowed: true };
    },
    inspect,
    admit: (request, authorization) => mayDiagnose(request, authorization),
    diagnose: ({ request, source, ...callbacks }) =>
      diagnoseStageTools({
        assignment: assignmentFor(request, source),
        expectedContext: source.context,
        config,
        root,
        home,
        env: providerOf(config) === 'codex' ? getEnvironment() : undefined,
        spawn: spawnStage,
        killTree,
        ...callbacks,
      }),
  });
  endpoint = await openDiagnosticEndpoint({
    directory,
    handler: {
      get: (id) => handler.get(id),
      submit: async (value) => {
        const { request, fingerprint } = parseDiagnosticRequest(value);
        const grant = currentGrant(request, fingerprint);
        if (grant.prepareOnly !== true) return handler.submit(request);
        const observed = await inspect(request, { ...grant, allowed: true }, true);
        if (observed.verified !== true)
          return { ok: false, reason: observed.busy ? 'busy' : 'unverified-context-or-ownership' };
        return {
          ok: false,
          reason: 'owner-confirmation-required',
          requestId: request.requestId,
          fingerprint,
          generation: endpoint.descriptor.generation,
          observedAt: new Date().toISOString(),
          source: observed.source,
        };
      },
    },
    owns,
    metadata: {
      runtimeSha,
      lockPath,
      root,
      startedAt: new Date().toISOString(),
      storePath: join(directory, 'pending-reports.json'),
    },
  });
  try {
    writeFileSync(
      join(directory, 'diagnostic-endpoint.json'),
      `${JSON.stringify(endpoint.descriptor, null, 2)}\n`,
    );
  } catch (error) {
    await endpoint.close();
    throw error;
  }
  return endpoint;
}
