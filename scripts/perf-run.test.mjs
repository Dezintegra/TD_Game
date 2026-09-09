import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  specs: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  spawn: vi.fn(),
  write: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  probe: vi.fn(),
  quiet: vi.fn(),
  history: vi.fn(),
  record: vi.fn(),
  release: vi.fn(),
}));
vi.mock('./perf-prepare.mjs', () => ({ preparePerfPackages: mocks.prepare }));
vi.mock('./perf-services.mjs', () => ({
  perfServiceSpecs: mocks.specs,
  startPerfServices: mocks.start,
}));
vi.mock('./perf-lock.mjs', () => ({ releasePerfLock: mocks.release }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', () => ({
  existsSync: () => true,
  readFileSync: () => '{"name":"fps","value":60}',
  writeFileSync: mocks.write,
  mkdirSync: mocks.mkdir,
  rmSync: mocks.rm,
}));
vi.mock('node:net', () => ({
  createServer: () => {
    const handlers = {};
    return {
      once: (name, fn) => {
        handlers[name] = fn;
      },
      close: (fn) => fn(),
      listen: (port) => {
        handlers[mocks.probe(port) ? 'listening' : 'error']();
      },
    };
  },
}));
vi.mock('./perf-common.mjs', () => ({
  BUSY_LIMIT: 0.2,
  repoRoot: '/test-tree',
  lockPath: '/test-lock',
  die: (message) => {
    throw new Error(message);
  },
  note: vi.fn(),
  ok: vi.fn(),
  step: vi.fn(),
  warn: vi.fn(),
  printHistory: mocks.history,
  recordEntry: mocks.record,
  requireQuietMachine: mocks.quiet,
  startBusySampling: () => ({ stop: () => 0 }),
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArgv = process.argv;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('CLIENT_PORT', '5173');
  vi.stubEnv('PORT', '3001');
  vi.stubEnv('COMPUTER_METRICS_PORT', undefined);
  vi.stubEnv('VITE_API_URL', 'stale');
  vi.stubEnv('VITE_WS_URL', 'stale');
  vi.stubEnv('COMPUTER_API_URL', 'stale');
  vi.stubEnv('COMPUTER_WS_URL', 'stale');
  vi.spyOn(process, 'on').mockReturnValue(process);
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  });
  mocks.probe.mockReturnValue(true);
  mocks.quiet.mockResolvedValue(0);
  mocks.specs.mockReturnValue(['services']);
  mocks.start.mockResolvedValue({ stop: mocks.stop });
  mocks.spawn.mockImplementation(() => ({
    on: (name, fn) => {
      if (name === 'close') fn(0);
    },
  }));
});
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  process.argv = originalArgv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function run(args, platform = 'linux') {
  Object.defineProperty(process, 'platform', { value: platform });
  process.argv = ['node', 'perf-run.mjs', ...args];
  await import('./perf-run.mjs');
}
describe('реальные места запуска обёртки', () => {
  it.each(['win32', 'linux'])('передаёт одну конфигурацию на %s', async (platform) => {
    await expect(
      run(['--', '--client-port=5199', '--port', '3055', '--grep', 'camera'], platform),
    ).rejects.toThrow('exit:0');
    expect(mocks.probe.mock.calls.flat()).toEqual([5199, 3055, 3056]);
    const env = mocks.spawn.mock.calls[0][2].env;
    expect(env).toMatchObject({
      CLIENT_PORT: '5199',
      PORT: '3055',
      COMPUTER_METRICS_PORT: '3056',
      VITE_API_URL: 'http://127.0.0.1:3055',
      VITE_WS_URL: 'ws://127.0.0.1:3055/game',
      COMPUTER_API_URL: 'http://127.0.0.1:3055',
      COMPUTER_WS_URL: 'ws://127.0.0.1:3055/game',
    });
    expect(mocks.spawn.mock.calls[0][1]).toEqual([
      'exec',
      'playwright',
      'test',
      '--config',
      'playwright.perf.config.ts',
      '--grep',
      'camera',
    ]);
    if (platform === 'win32') {
      expect(mocks.specs).toHaveBeenCalledWith(
        '/test-tree',
        expect.objectContaining({ PORT: '3055' }),
      );
      expect(env).toMatchObject(mocks.specs.mock.calls[0][1]);
      expect(mocks.stop).toHaveBeenCalledOnce();
    } else expect(mocks.start).not.toHaveBeenCalled();
    expect(process.env.PORT).toBe('3001');
    expect(process.env.VITE_API_URL).toBe('stale');
  });
  it('check-only проверяет те же порты без подготовки и записи', async () => {
    await expect(run(['--client-port=5199', '--port=3055', '--check-only'])).rejects.toThrow(
      'exit:0',
    );
    expect(mocks.probe.mock.calls.flat()).toEqual([5199, 3055, 3056]);
    for (const fn of [mocks.prepare, mocks.spawn, mocks.start, mocks.write, mocks.rm])
      expect(fn).not.toHaveBeenCalled();
  });
  it('history обходит неверное окружение и прочие режимы', async () => {
    vi.stubEnv('PORT', 'bad');
    await expect(run(['--history', '--check-only', '--force'])).rejects.toThrow('exit:0');
    expect(mocks.history).toHaveBeenCalledOnce();
    for (const fn of [mocks.prepare, mocks.quiet, mocks.probe, mocks.write, mocks.spawn])
      expect(fn).not.toHaveBeenCalled();
  });
  it.each([['--port=0'], ['--history', '--port=bad'], ['--force', '--port=65535']])(
    'отказывает до побочных действий %j',
    async (...args) => {
      await expect(run(args)).rejects.toThrow();
      for (const fn of Object.values(mocks)) expect(fn).not.toHaveBeenCalled();
    },
  );
  it('force не обходит занятый порт', async () => {
    mocks.probe.mockReturnValue(false);
    await expect(run(['--force'])).rejects.toThrow('pnpm e2e:perf -- --client-port');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
