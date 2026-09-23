import { describe, it, expect, vi } from 'vitest';
import { resolve, join } from 'node:path';
import { main } from '../bin/prepare-project-skill-host.mjs';
import { projectSkillHostEffects, PR_SOURCE, hostCliVersion } from './windows-diagnostic-host.mjs';
import { sha256, TARGETS, HOST_DIRECTORY } from './project-skill-host-fixture.mjs';

function harness() {
  const workspace = resolve('virtual-host');
  const stand = resolve(workspace, HOST_DIRECTORY);
  const fixture = { stand, root: join(stand, 'main'), cwd: join(stand, 'tree') };
  const gitdir = join(fixture.root, '.git/worktrees/tree');
  const config = { codexWindowsSandbox: 'elevated' };
  const grants = {
    files: TARGETS.map((file) => resolve(fixture.cwd, file)),
    digest: 'manifest-hash',
    source: 'manifest',
  };
  const evidence = {
    schemaVersion: 1,
    status: 'ready',
    hostReady: true,
    cliStart: true,
    permissionAcceptance: 'not-run',
    sessions: [],
    consumerPreserved: true,
    previousPreserved: true,
    workspace,
    fixture,
    sourcePr: { sha: PR_SOURCE },
    finishedAt: '2026-01-01T00:00:00Z',
    configDigest: sha256(JSON.stringify(config)),
    sources: { module: 'hash' },
    versions: { codex: 'codex-cli 1.0.0' },
  };
  const bytes = JSON.stringify(evidence);
  const effects = {
    platform: 'test',
    fs: {
      lstatSync: () => ({
        isSymbolicLink: () => false,
        isDirectory: () => true,
        isFile: () => true,
        nlink: 1,
      }),
      realpathSync: (path) => path,
      readFileSync: () => bytes,
      writeFileSync: vi.fn(),
    },
    git: () => gitdir,
    verifyFixture: vi.fn(),
    sources: () => ({ module: 'hash' }),
    cliVersion: vi.fn(() => 'codex-cli 1.0.0'),
  };
  function argsBuilder(_config, root, cwd, _platform, files) {
    const paths = [
      resolve(root, '.git'),
      gitdir,
      resolve(root, '.perf-lock'),
      resolve(root, '.perf-log.jsonl'),
      ...files,
    ];
    return [
      '-c',
      'approval_policy="never"',
      '-c',
      'default_permissions="td-pipeline"',
      '-c',
      'permissions={td-pipeline={extends=":workspace",filesystem={' +
        paths.map((path) => JSON.stringify(path.replaceAll('\\', '/')) + '="write"').join(',') +
        '},network={enabled=true}}}',
      '-c',
      'windows.sandbox="elevated"',
    ];
  }
  const options = {
    workspace,
    home: 'fixed-home',
    config,
    evidence,
    evidenceHash: sha256(bytes),
    checkerStartedAt: '2026-01-02T00:00:00Z',
    resolveProjectSkillWrites: vi.fn(() => grants),
    codexExecutionArgs: argsBuilder,
    invocation: (_config, args) => ({ program: 'fixed-runner', args }),
    runProbeSession: vi.fn(async () => ({
      events: [{ type: 'thread.started', thread_id: 'target-session' }],
      run: { code: 0 },
    })),
    env: {
      GH_TOKEN: 'test-token',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '*',
      GIT_CONFIG_GLOBAL: 'host-global',
      GIT_TRACE: 'trace',
      GIT_DIR: 'host-git',
      PRIVATE_SECRET: 'hidden',
      PATH: 'path',
    },
  };
  function command(phase) {
    const args = [
      'exec',
      '--ignore-user-config',
      '--json',
      ...argsBuilder(
        config,
        fixture.root,
        fixture.cwd,
        'win32',
        phase === 'baseline' ? [] : grants.files,
      ),
      '-c',
      'project_doc_max_bytes=0',
    ];
    if (phase === 'resume') args.push('resume', 'target-session');
    args.push('-');
    return {
      program: 'fixed-runner',
      args,
      cwd: fixture.cwd,
      stdin: `prompt-${phase}`,
      grants,
      profile: args.find((arg) => arg.startsWith('permissions=')),
      env: { unsafe: 'discard' },
    };
  }
  return { options, effects, fixture, command };
}

describe('prepared host effects', () => {
  it('keeps argv, cwd, stdin and resume while isolating every child environment', async () => {
    const h = harness();
    const adapter = projectSkillHostEffects(h.options, h.effects);
    expect(adapter.setup(h.options.workspace)).toBe(h.fixture);
    for (const phase of ['baseline', 'target', 'resume']) {
      const command = h.command(phase);
      await adapter.runSession(command, phase);
      const sent = h.options.runProbeSession.mock.calls.at(-1)[0];
      expect(sent.args).toEqual(command.args);
      expect(sent.stdin).toBe(command.stdin);
      expect(sent.cwd).toBe(h.fixture.cwd);
      expect(sent.env.GIT_CONFIG_VALUE_1).toBe(h.fixture.root.replaceAll('\\', '/'));
      expect(sent.env.GIT_CONFIG_VALUE_2).toBe(h.fixture.cwd.replaceAll('\\', '/'));
      expect(sent.env.GH_TOKEN).toBe('test-token');
      for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_TRACE', 'GIT_DIR', 'PRIVATE_SECRET', 'unsafe'])
        expect(sent.env[key]).toBeUndefined();
    }
    expect(h.effects.verifyFixture).toHaveBeenCalledTimes(7);
    await expect(adapter.runSession(h.command('resume'), 'resume')).rejects.toThrow('phase-budget');
    expect(() => adapter.setup(h.options.workspace)).toThrow('probe-already-started');
  });
  it('rejects changed assignment before resume without starting another child', async () => {
    const h = harness();
    const adapter = projectSkillHostEffects(h.options, h.effects);
    adapter.setup(h.options.workspace);
    await adapter.runSession(h.command('baseline'), 'baseline');
    await adapter.runSession(h.command('target'), 'target');
    h.options.resolveProjectSkillWrites.mockReturnValue({
      ...h.command('resume').grants,
      digest: 'changed',
    });
    await expect(adapter.runSession(h.command('resume'), 'resume')).rejects.toThrow(
      'assignment-changed',
    );
    expect(h.options.runProbeSession).toHaveBeenCalledTimes(2);
  });
  it('does not accept broad rights even if the supplied builder emits them', async () => {
    const h = harness();
    const original = h.options.codexExecutionArgs;
    h.options.codexExecutionArgs = (...args) =>
      original(...args).map((arg) => arg.replace('extends=":workspace"', 'extends=":all"'));
    const adapter = projectSkillHostEffects(h.options, h.effects);
    adapter.setup(h.options.workspace);
    const command = h.command('baseline');
    command.args = command.args.map((arg) => arg.replace('extends=":workspace"', 'extends=":all"'));
    command.profile = command.args.find((arg) => arg.startsWith('permissions='));
    await expect(adapter.runSession(command, 'baseline')).rejects.toThrow('exact-profile-mismatch');
    expect(h.options.runProbeSession).not.toHaveBeenCalled();
  });
  it('preserves failed native events and stops after unexpected control writes', async () => {
    const h = harness();
    const adapter = projectSkillHostEffects(h.options, h.effects);
    adapter.setup(h.options.workspace);
    h.effects.verifyFixture.mockImplementation((_workspace, _fixture, _io, _phase, after) => {
      if (after) throw new Error('unexpected');
    });
    const result = await adapter.runSession(h.command('baseline'), 'baseline');
    expect(result.events).toEqual([{ type: 'thread.started', thread_id: 'target-session' }]);
    expect(result.run.code).toBe(1);
    await expect(adapter.runSession(h.command('target'), 'target')).rejects.toThrow('phase-budget');
  });
  it.each(['hash', 'time', 'source', 'version'])('rejects stale %s evidence', async (kind) => {
    const h = harness();
    if (kind === 'hash') h.options.evidenceHash = 'wrong';
    if (kind === 'time') h.options.checkerStartedAt = h.options.evidence.finishedAt;
    if (kind === 'source') h.effects.sources = () => ({ module: 'changed' });
    if (kind === 'version') h.effects.cliVersion.mockReturnValue('codex-cli 2.0.0');
    const adapter = projectSkillHostEffects(h.options, h.effects);
    if (kind === 'version') {
      adapter.setup(h.options.workspace);
      await expect(adapter.runSession(h.command('baseline'), 'baseline')).rejects.toThrow(
        'cli-version-changed',
      );
    } else expect(() => adapter.setup(h.options.workspace)).toThrow();
    expect(h.options.runProbeSession).not.toHaveBeenCalled();
  });
});

describe('owner CLI', () => {
  it.each([[], ['--help'], ['--prepare', '--root', 'foreign'], ['--run']])(
    'has no effects for %j',
    async (...args) => {
      const prepare = vi.fn();
      const readConfig = vi.fn();
      await main(args, { prepare, readConfig, output: vi.fn() });
      expect(prepare).not.toHaveBeenCalled();
      expect(readConfig).not.toHaveBeenCalled();
    },
  );
  it('only --prepare calls the owner route', async () => {
    const prepare = vi.fn(async () => ({ status: 'ready' }));
    expect(await main(['--prepare'], { prepare, readConfig: () => ({}), output: vi.fn() })).toBe(0);
    expect(prepare).toHaveBeenCalledOnce();
  });
  it('version startup has a bounded process owner and no prompt', async () => {
    const start = vi.fn(() => ({
      finished: Promise.resolve({ code: 0, stdout: 'codex-cli 0.153.4\n' }),
    }));
    expect(await hostCliVersion({}, { start, checkTime: vi.fn() }, 'workspace')).toBe(
      'codex-cli 0.153.4',
    );
    const request = start.mock.calls[0][0];
    expect(request.timeoutMs).toBe(10000);
    expect(request.command.stdin).toBe('');
    expect(request.command.args.at(-1)).toBe('--version');
    expect(request.killTree).toBeTypeOf('function');
  });
});
