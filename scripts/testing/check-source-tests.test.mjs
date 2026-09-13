import { expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from './source-aliases.mjs';
import {
  assertNoDist,
  checkSourceTests,
  installedControlCopy,
  runControls,
  runMatrix,
  sourceMatrix,
  sourcePnpm,
} from './check-source-tests.mjs';

it('resolves the extensionless pnpm executable used by Linux action-setup', () => {
  const root = fixture();
  writeFileSync(resolve(root, 'pnpm'), 'launcher');
  const target = resolve(root, 'actual/pnpm.cjs');
  mkdirSync(resolve(root, 'actual'));
  writeFileSync(target, 'cli');
  const resolveExecutable = vi.fn(() => target);
  const finder = vi.fn((env) => {
    if (!env.npm_execpath) throw new Error('No cjs in PATH');
    return env.npm_execpath;
  });
  expect(sourcePnpm({ PATH: root }, resolveExecutable, finder)).toBe(target);
  expect(resolveExecutable).toHaveBeenCalledWith(resolve(root, 'pnpm'));
});

function fixture() {
  mkdirSync(resolve(repoRoot, '.matchlog'), { recursive: true });
  const root = mkdtempSync(resolve(repoRoot, '.matchlog/check-fixture-'));
  for (const pkg of ['shared', 'sim']) {
    mkdirSync(resolve(root, `packages/${pkg}/src`), { recursive: true });
    writeFileSync(resolve(root, `packages/${pkg}/src/index.ts`), `export const ${pkg} = 1;\r\n`);
  }
  mkdirSync(resolve(root, 'node_modules/vitest'), { recursive: true });
  writeFileSync(resolve(root, 'node_modules/vitest/package.json'), '{"version":"2.1.9"}');
  return root;
}
const success = (selection, { root }) => ({
  ok: true,
  repoRoot: root,
  ...selection,
  executed: selection.files.map((file) => ({ file, passed: 1, failed: 0, skipped: 0 })),
});

it('runs exactly the five required selections with absence checks around them', () => {
  const root = fixture();
  const calls = [];
  runMatrix(
    root,
    {},
    {
      noDist: () => {
        calls.push('dist');
        return true;
      },
      invoke: (selection, options) => {
        calls.push(selection);
        return success(selection, options);
      },
    },
  );
  expect(calls).toEqual(['dist', ...sourceMatrix, 'dist']);
  expect(sourceMatrix.map((s) => [s.environment, s.files.map((f) => f.split('/').at(-1))])).toEqual(
    [
      ['node', ['crowd.test.ts', 'step.test.ts']],
      ['jsdom', ['crowd.test.ts', 'step.test.ts']],
      ['node', ['determinism.golden.match.test.ts']],
      ['jsdom', ['determinism.golden.match.test.ts']],
      ['node', ['profile.golden.match.test.ts']],
    ],
  );
});

it.each(['shared', 'sim', 'ai'])('rejects existing %s dist without deleting it', (pkg) => {
  const root = fixture();
  const path = resolve(root, `packages/${pkg}/dist`);
  mkdirSync(path, { recursive: true });
  const invoke = vi.fn();
  expect(() => runMatrix(root, {}, { invoke })).toThrow('Unexpected dist');
  expect(invoke).not.toHaveBeenCalled();
  expect(() => assertNoDist(root)).toThrow(pkg);
});

it.each(['zero', 'extra', 'missing', 'load'])('rejects %s execution evidence', (kind) => {
  const root = fixture();
  expect(() =>
    runMatrix(
      root,
      {},
      {
        invoke: (selection, options) => {
          const report = success(selection, options);
          if (kind === 'zero') report.executed[0].passed = 0;
          if (kind === 'extra') report.executed.push({ file: 'extra', passed: 1, failed: 0 });
          if (kind === 'missing') report.executed.pop();
          if (kind === 'load') report.ok = false;
          return report;
        },
      },
    ),
  ).toThrow();
});

it('recognizes each source marker and restores original bytes before successful replay', () => {
  const root = fixture();
  const report = {};
  runControls(root, report, {
    invoke: (selection, options) => {
      const pkg = selection.files[0].includes('/ai/') ? 'sim' : 'shared';
      const text = readFileSync(resolve(root, `packages/${pkg}/src/index.ts`), 'utf8');
      const marker = text.match(/TD_SOURCE_CONTROL_[A-Z]+/)?.[0];
      return marker ? { ok: false, stderr: marker } : success(selection, options);
    },
  });
  expect(report.controls.map((c) => [c.pkg, c.detected, c.restoredBytes, c.restored.ok])).toEqual([
    ['shared', true, true, true],
    ['sim', true, true, true],
  ]);
});

it.each([{ ok: true }, { ok: false, stderr: 'unrelated failure' }])(
  'rejects an unrecognized control and restores bytes',
  (failure) => {
    const root = fixture();
    const path = resolve(root, 'packages/shared/src/index.ts');
    const original = readFileSync(path);
    expect(() => runControls(root, {}, { invoke: () => failure })).toThrow(
      'Unrecognized negative control',
    );
    expect(readFileSync(path).equals(original)).toBe(true);
  },
);

it('installs an archive of the explicit revision before returning its own copy', () => {
  const root = fixture();
  const directory = resolve(root, '.matchlog');
  mkdirSync(directory);
  const calls = [];
  const copy = installedControlCopy(root, 'fixed-sha', directory, {
    pnpmCli: 'pnpm.cjs',
    run: (program, args) => {
      calls.push([program, args]);
      return { stdout: '', status: 0 };
    },
  });
  expect(copy).toBe(resolve(directory, 'controls'));
  expect(calls[0][1]).toContain('fixed-sha');
  expect(calls[1][0]).toBe('tar');
  expect(calls[2][1]).toEqual([
    'pnpm.cjs',
    'install',
    '--frozen-lockfile',
    '--prefer-offline',
    '--store-dir',
    '.pnpm-store',
  ]);
});

it.each(['--fresh', '--installed'])(
  'prepares %s before matrix and controls, without upstream in detached mode',
  (mode) => {
    const root = fixture();
    const target = fixture();
    // Контрольная копия обязана находиться внутри своего родителя.
    const nested = resolve(root, 'snapshot');
    mkdirSync(nested);
    mkdirSync(resolve(nested, 'node_modules/vitest'), { recursive: true });
    writeFileSync(resolve(nested, 'node_modules/vitest/package.json'), '{"version":"2.1.9"}');
    const events = [];
    const run = (_program, args) => {
      expect(args).not.toContain('@{u}');
      if (args.includes('--show-toplevel')) return { stdout: root };
      if (args.includes('HEAD')) return { stdout: 'sha' };
      return { stdout: '' };
    };
    const report = checkSourceTests(mode, {
      root,
      run,
      snapshotCheck: () => {
        events.push('install');
        return { ok: true, snapshot: nested };
      },
      copy: (_root, sha) => {
        expect(sha).toBe('sha');
        events.push('copy-install');
        return nested;
      },
      matrix: (where) => {
        expect(where).toBe(mode === '--fresh' ? nested : root);
        events.push('matrix');
      },
      controls: (where) => {
        expect(where).toBe(nested);
        events.push('controls');
      },
    });
    expect(report.ok, report.error).toBe(true);
    expect(events).toEqual(
      mode === '--fresh'
        ? ['install', 'matrix', 'controls']
        : ['matrix', 'copy-install', 'controls'],
    );
    expect(target).not.toBe(root);
  },
);
