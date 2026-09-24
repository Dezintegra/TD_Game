import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { diagnosticCodeMatches } from './diagnostic-code-identity.mjs';

const execute = promisify(execFile);

/** PID после перезагрузки может принадлежать Docker или другому Node. */
export async function supervisorIdentity(
  pid,
  lockPath,
  {
    run = execute,
    platform = process.platform,
    entrypoint,
    attestStaged = diagnosticCodeMatches,
  } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0) return { kind: 'unknown', reason: 'некорректный PID' };
  const windows = platform === 'win32';
  let command;
  try {
    const result = await run(
      windows ? 'powershell.exe' : 'ps',
      windows
        ? [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$ErrorActionPreference = 'Stop'; $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -eq $p) { 'null' } else { ConvertTo-Json -Compress -InputObject @{ command = $p.CommandLine } }`,
          ]
        : ['-p', String(pid), '-o', 'args='],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 },
    );
    if (windows) {
      const value = JSON.parse(result.stdout.trim());
      if (value === null) return { kind: 'waiting' };
      command = value.command;
    } else command = result.stdout.trim();
  } catch (error) {
    if (!windows && error.code === 1 && !String(error.stdout ?? '').trim())
      return { kind: 'waiting' };
    return { kind: 'unknown', reason: `не удалось проверить владельца PID ${pid}` };
  }
  if (typeof command !== 'string' || !command.trim())
    return { kind: 'unknown', reason: `командная строка PID ${pid} недоступна` };
  const normalize = (value) => {
    const path = value.replaceAll('\\', '/');
    return windows ? path.toLowerCase() : path;
  };
  // The diagnostic endpoint may be loaded from a separately attested Git
  // worktree. Other callers keep the main-checkout entrypoint derived from the
  // lock location; merely supplying a PID never changes their trust boundary.
  const expected = normalize(
    entrypoint ?? join(dirname(dirname(lockPath)), 'supervisor', 'bin', 'supervise.mjs'),
  );
  const args = [...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3],
  );
  // Проверяем точку входа, а не упоминание пути внутри чужой команды.
  const node = normalize(args[0] ?? '')
    .split('/')
    .at(-1);
  if (!['node', 'node.exe'].includes(node)) return { kind: 'waiting' };
  if (normalize(args[1] ?? '') === expected) return { kind: 'live', pid };
  if (entrypoint || !args.includes('--diagnostic-endpoint')) return { kind: 'waiting' };

  // The main watchdog and stop command must recognize an attested staged
  // owner too. Without this fallback they would mistake its live lock for an
  // orphan. The descriptor is evidence only after the code and command line
  // are independently checked.
  try {
    const descriptor = JSON.parse(
      readFileSync(join(dirname(lockPath), 'diagnostic-endpoint.json'), 'utf8'),
    );
    if (
      descriptor.ownerPid === pid &&
      normalize(descriptor.lockPath ?? '') === normalize(lockPath) &&
      normalize(descriptor.storePath ?? '') ===
        normalize(join(dirname(lockPath), 'pending-reports.json')) &&
      normalize(descriptor.entrypoint ?? '') === normalize(args[1] ?? '') &&
      (await attestStaged(descriptor))
    )
      return { kind: 'live', pid };
  } catch {
    // Missing or tampered attestation cannot grant ownership.
  }
  return { kind: 'waiting' };
}
