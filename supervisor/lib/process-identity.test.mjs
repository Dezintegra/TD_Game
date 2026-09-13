import { describe, it, expect, vi } from 'vitest';
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
