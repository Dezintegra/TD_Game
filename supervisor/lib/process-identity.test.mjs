import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { supervisorIdentity } from './process-identity.mjs';

const lock = 'C:/project with space/.pipeline/supervisor.lock';
const entry = 'C:/project with space/supervisor/bin/supervise.mjs';
const check = (command) =>
  supervisorIdentity(24268, lock, {
    platform: 'win32',
    run: async () => ({ stdout: JSON.stringify({ command }) }),
  });

describe('supervisor identity', () => {
  it('accepts the project entry with Windows paths and spaces', async () => {
    expect(
      await check(`"C:\\Program Files\\nodejs\\node.exe" "${entry.replaceAll('/', '\\')}"`),
    ).toEqual({ kind: 'live', pid: 24268 });
  });
  it('accepts only the explicitly attested staged entrypoint', async () => {
    const staged = 'C:/project with space/.claude/worktrees/0383/supervisor/bin/supervise.mjs';
    const command = `"C:\\Program Files\\nodejs\\node.exe" "${staged.replaceAll('/', '\\')}"`;
    expect(await check(command)).toEqual({ kind: 'waiting' });
    expect(
      await supervisorIdentity(24268, lock, {
        platform: 'win32',
        entrypoint: staged,
        run: async () => ({ stdout: JSON.stringify({ command }) }),
      }),
    ).toEqual({ kind: 'live', pid: 24268 });
    expect(
      await supervisorIdentity(24268, lock, {
        platform: 'win32',
        entrypoint: `${staged}.other`,
        run: async () => ({ stdout: JSON.stringify({ command }) }),
      }),
    ).toEqual({ kind: 'waiting' });
  });
  it('lets the ordinary watchdog recognize only an attested staged owner', async () => {
    const base = resolve(import.meta.dirname, '../../.matchlog');
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, 'staged-owner-'));
    if (!resolve(dir).startsWith(`${base}\\`) && !resolve(dir).startsWith(`${base}/`))
      throw new Error('fixture-path-escaped');
    try {
      const lockPath = join(dir, 'supervisor.lock');
      const staged = 'C:/registered/worktree/supervisor/bin/supervise.mjs';
      const descriptor = {
        ownerPid: 24268,
        lockPath,
        storePath: join(dir, 'pending-reports.json'),
        entrypoint: staged,
      };
      const path = join(dir, 'diagnostic-endpoint.json');
      writeFileSync(path, JSON.stringify(descriptor));
      const command = `node.exe ${staged} --diagnostic-endpoint C:/project`;
      const attestStaged = vi.fn(async () => true);
      const identify = (overrides = {}) =>
        supervisorIdentity(24268, lockPath, {
          platform: 'win32',
          run: async () => ({ stdout: JSON.stringify({ command }) }),
          attestStaged,
          ...overrides,
        });
      expect(await identify()).toEqual({ kind: 'live', pid: 24268 });
      expect(attestStaged).toHaveBeenCalledWith(descriptor);
      expect(await identify({ attestStaged: () => false })).toEqual({ kind: 'waiting' });
      writeFileSync(path, JSON.stringify({ ...descriptor, ownerPid: 1 }));
      expect(await identify()).toEqual({ kind: 'waiting' });
      writeFileSync(path, JSON.stringify(descriptor));
      expect(await identify({ entrypoint: 'C:/project/supervisor/bin/supervise.mjs' })).toEqual({
        kind: 'waiting',
      });
      expect(
        await identify({
          run: async () => ({
            stdout: JSON.stringify({ command: command.replace('--diagnostic-endpoint', '') }),
          }),
        }),
      ).toEqual({ kind: 'waiting' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each([
    '"C:/Docker/com.docker.backend.exe" services',
    'node.exe C:/other/supervisor/bin/supervise.mjs',
    'node.exe C:/project/another.mjs',
    `powershell.exe -Command "node.exe ${entry}"`,
    `node.exe -e "${entry}"`,
  ])('does not mistake another process for supervisor: %s', async (command) => {
    expect(await check(command)).toEqual({ kind: 'waiting' });
  });
  it('does not equate inaccessible command with a dead process', async () => {
    expect(await check(null)).toMatchObject({ kind: 'unknown' });
    expect(await check('')).toMatchObject({ kind: 'unknown' });
  });
  it('bounds the OS query and fails closed on timeout or malformed output', async () => {
    const run = vi.fn(async () => {
      throw new Error('timeout');
    });
    expect(await supervisorIdentity(24268, lock, { run, platform: 'win32' })).toMatchObject({
      kind: 'unknown',
    });
    expect(run.mock.calls[0][2]).toMatchObject({ timeout: 5000, windowsHide: true });
    run.mockResolvedValue({ stdout: 'bad json' });
    expect(await supervisorIdentity(24268, lock, { run, platform: 'win32' })).toMatchObject({
      kind: 'unknown',
    });
    run.mockResolvedValue({ stdout: 'null' });
    expect(await supervisorIdentity(24268, lock, { run, platform: 'win32' })).toEqual({
      kind: 'waiting',
    });
  });
  it('recognizes POSIX entry and preserves query failures', async () => {
    const run = vi.fn(async () => ({
      stdout: '/usr/bin/node /project/supervisor/bin/supervise.mjs\n',
    }));
    const options = { run, platform: 'linux' };
    expect(await supervisorIdentity(12, '/project/.pipeline/supervisor.lock', options)).toEqual({
      kind: 'live',
      pid: 12,
    });
    run.mockRejectedValue(Object.assign(new Error('gone'), { code: 1, stdout: '' }));
    expect(await supervisorIdentity(12, lock, options)).toEqual({ kind: 'waiting' });
    run.mockRejectedValue(Object.assign(new Error('denied'), { code: 2 }));
    expect(await supervisorIdentity(12, lock, options)).toMatchObject({ kind: 'unknown' });
  });
});
