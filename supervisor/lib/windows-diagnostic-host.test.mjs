import { describe, it, expect, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { prepareProjectSkillHost, classifyHostError } from './windows-diagnostic-host.mjs';
import { hostIO } from './project-skill-host-fixture.mjs';

function context() {
  const workspace = resolve('virtual-project/0302');
  const calls = [];
  const effects = {
    platform: 'win32',
    now: () => 100,
    reserve: vi.fn(() => ({ finish: vi.fn(), close: vi.fn() })),
    identify: vi.fn(() => {
      calls.push('identify');
      return { tree: 'consumer', identity: { root: 'main' } };
    }),
    snapshot: vi.fn(() => ({ artifact: 'hash' })),
    previous: vi.fn(() => ({ status: 'available', hash: 'old-evidence' })),
    createFixture: vi.fn(() => {
      calls.push('fixture');
      return { root: 'fixture-main', cwd: 'fixture-tree' };
    }),
    verifyFixture: vi.fn(() => ({ control: 'hash' })),
    sources: vi.fn(() => ({ module: 'hash' })),
    git: vi.fn(() => 'a'.repeat(40)),
    exec: vi.fn(() => 'git version 2.0'),
    cliVersion: vi.fn(() => {
      calls.push('cli');
      return 'codex-cli 1.0';
    }),
  };
  return { options: { workspace, home: join(workspace, 'supervisor') }, effects, calls };
}

describe('Windows host preparation with substituted effects', () => {
  it('separates host readiness, CLI startup and permission acceptance', async () => {
    const { options, effects, calls } = context();
    const result = await prepareProjectSkillHost(options, effects);
    expect(calls).toEqual(['identify', 'fixture', 'cli']);
    expect(result).toMatchObject({
      status: 'ready',
      hostReady: true,
      cliStart: true,
      permissionAcceptance: 'not-run',
      sessions: [],
      consumerPreserved: true,
      previousPreserved: true,
    });
    expect(effects.snapshot).toHaveBeenCalledTimes(2);
  });
  it.each([
    'ownership',
    'branch-mismatch',
    'common-mismatch',
    'toplevel-mismatch',
    'registration-mismatch',
    'reparse-point',
  ])('identity failure %s forbids setup and CLI', async (kind) => {
    const { options, effects } = context();
    effects.identify.mockImplementation(() => {
      throw Object.assign(new Error(kind), { hostCode: kind });
    });
    const result = await prepareProjectSkillHost(options, effects);
    expect(result).toMatchObject({
      status: 'failed',
      hostReady: false,
      cliStart: false,
      sessions: [],
      error: { kind },
    });
    expect(effects.createFixture).not.toHaveBeenCalled();
    expect(effects.cliVersion).not.toHaveBeenCalled();
  });
  it('occupied evidence forbids even identity checks', async () => {
    const { options, effects } = context();
    effects.reserve.mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'EEXIST' });
    });
    expect((await prepareProjectSkillHost(options, effects)).error.kind).toBe('EEXIST');
    expect(effects.identify).not.toHaveBeenCalled();
  });
  it('a setup refusal preserves hashes and does not try the CLI', async () => {
    const { options, effects } = context();
    effects.createFixture.mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'EPERM' });
    });
    const result = await prepareProjectSkillHost(options, effects);
    expect(result.error.kind).toBe('EPERM');
    expect(result.consumerPreserved).toBe(true);
    expect(effects.cliVersion).not.toHaveBeenCalled();
  });
  it('unknown old evidence blocks setup and never claims preservation', async () => {
    const { options, effects } = context();
    effects.previous.mockReturnValue({ status: 'unknown', reason: 'EACCES' });
    const result = await prepareProjectSkillHost(options, effects);
    expect(result.previousPreserved).toBe(false);
    expect(effects.createFixture).not.toHaveBeenCalled();
  });
  it('changed inventory invalidates readiness', async () => {
    const { options, effects } = context();
    effects.snapshot
      .mockReturnValueOnce({ a: 'hash' })
      .mockReturnValueOnce({ a: 'hash', b: 'new' });
    const result = await prepareProjectSkillHost(options, effects);
    expect(result.status).toBe('failed');
    expect(result.hostReady).toBe(false);
  });
  it('rejects a foreign home before reserving evidence', async () => {
    const { options, effects } = context();
    options.home = resolve('foreign');
    expect((await prepareProjectSkillHost(options, effects)).error.kind).toBe('home-mismatch');
    expect(effects.reserve).not.toHaveBeenCalled();
  });
  it('enforces a ten-minute deadline', () => {
    let time = 0;
    const io = hostIO({ now: () => time });
    time = 600000;
    expect(() => io.checkTime()).toThrow('timeout');
  });
  it.each([
    ['detected dubious ownership SID-secret', 'ownership'],
    ['rejected by policy user-secret', 'policy'],
    ['sandbox setup failed user-secret', 'sandbox-start'],
    ['private unknown text', 'unknown'],
  ])('redacts %s', (message, expected) => {
    expect(classifyHostError(new Error(message))).toBe(expected);
  });
});
