import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployPerfArgs } from './deploy-perf.mjs';

const mocks = vi.hoisted(() => ({ capture: vi.fn(), spawn: vi.fn(), temp: vi.fn(), rm: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.capture, spawnSync: mocks.spawn }));
vi.mock('node:fs', () => ({ existsSync: () => true, mkdtempSync: mocks.temp, rmSync: mocks.rm }));
vi.mock('./deploy-ssh.mjs', () => ({ deploySshHost: (host) => host, deploySshOptions: () => [] }));
const originalArgv = process.argv;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  });
  mocks.spawn.mockReturnValue({ status: 0 });
  mocks.temp.mockReturnValue('/mock-work');
  mocks.capture.mockImplementation((cmd, args) => {
    if (cmd === 'git') return args.includes('--show-toplevel') ? '/mock-root' : 'revision';
    if (args.at(-1).includes('TD_DOMAIN')) return 'example.test';
    if (args.at(-1).includes('http_code')) return '200';
    return 'ok';
  });
});
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function run(args) {
  process.argv = ['node', 'deploy.mjs', ...args];
  await import('./deploy.mjs');
}

describe('порты локального замера при выкладке', () => {
  it.each([
    ['--client-port=5209', '--port', '3065'],
    ['--client-port', '5209', '--port=3065'],
  ])('передаёт только локальному pnpm %j', async (...args) => {
    await run(['--', ...args]);
    expect(mocks.spawn).toHaveBeenCalledWith(
      'pnpm',
      ['e2e:perf', '--client-port', '5209', '--port', '3065'],
      { stdio: 'inherit', cwd: '/mock-root', shell: true },
    );
    const remote = [...mocks.spawn.mock.calls, ...mocks.capture.mock.calls].filter(
      ([cmd]) => cmd === 'ssh' || cmd === 'scp',
    );
    expect(remote.length).toBeGreaterThan(0);
    for (const [, remoteArgs] of remote)
      expect(remoteArgs.join(' ')).not.toMatch(/5209|3065|--client-port|--port/);
  });
  it('без ключей сохраняет прежний вызов и наследование окружения', async () => {
    vi.stubEnv('PORT', '3055');
    await run([]);
    expect(mocks.spawn).toHaveBeenCalledWith('pnpm', ['e2e:perf'], {
      stdio: 'inherit',
      cwd: '/mock-root',
      shell: true,
    });
    expect(process.env.PORT).toBe('3055');
  });
  it('передаёт только явно заданный порт', () => {
    expect(deployPerfArgs(['--port=3065'])).toEqual(['e2e:perf', '--port', '3065']);
    expect(deployPerfArgs(['--client-port=5209'])).toEqual(['e2e:perf', '--client-port', '5209']);
  });
  it('no-perf подавляет замер с корректными ключами', async () => {
    await run(['--no-perf', '--port=3065', '--client-port=5209']);
    expect(mocks.spawn.mock.calls.some(([cmd]) => cmd === 'pnpm')).toBe(false);
    expect(mocks.spawn.mock.calls.some(([cmd]) => cmd === 'ssh')).toBe(true);
  });
  it.each([
    ['--port=bad'],
    ['--client-port'],
    ['--port=0', '--no-perf'],
    ['--port=3065', '--port', '3065'],
    ['--client-port=65536'],
  ])('отказывает до SSH даже с no-perf %j', async (...args) => {
    await expect(run(args)).rejects.toThrow('exit:1');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.temp).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/--port|--client-port/));
  });
  it('справка описывает обе формы и локальную область', async () => {
    await expect(run(['--help'])).rejects.toThrow('exit:0');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('--client-port=N'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('--port=N'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('локального замера'));
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
