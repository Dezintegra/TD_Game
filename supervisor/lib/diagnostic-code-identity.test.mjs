import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { attestDiagnosticCode, diagnosticCodeMatches } from './diagnostic-code-identity.mjs';

const base = resolve(import.meta.dirname, '../../.matchlog');
const fixtures = [];
const run = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true });

function makeFixture() {
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'staged-code-'));
  const main = join(dir, 'main');
  const staged = join(dir, 'staged');
  mkdirSync(join(main, 'supervisor', 'bin'), { recursive: true });
  run('init', '--initial-branch=main', main);
  writeFileSync(join(main, 'supervisor', 'bin', 'supervise.mjs'), 'export const version = 1;\n');
  run('-C', main, 'add', 'supervisor');
  run(
    '-C',
    main,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'main',
  );
  run('-C', main, 'worktree', 'add', '-b', 'staged', staged);
  writeFileSync(join(staged, 'supervisor', 'bin', 'supervise.mjs'), 'export const version = 2;\n');
  run('-C', staged, 'add', 'supervisor');
  run(
    '-C',
    staged,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'staged',
  );
  fixtures.push({ dir, main, staged });
  return { main, staged };
}

afterEach(() => {
  for (const { dir, main, staged } of fixtures.splice(0)) {
    try {
      run('-C', main, 'worktree', 'remove', '--force', staged);
    } catch {
      // The directory is still confined to this test's verified fixture root.
    }
    if (!resolve(dir).startsWith(`${base}\\`) && !resolve(dir).startsWith(`${base}/`))
      throw new Error('fixture-path-escaped');
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('staged diagnostic code identity', () => {
  it('attests distinct root/code commits from one registered, clean repository', () => {
    const { main, staged } = makeFixture();
    const identity = attestDiagnosticCode({ root: main, home: join(staged, 'supervisor') });
    expect(identity.codeSha).not.toBe(identity.rootSha);
    expect(identity.entrypoint).toBe(resolve(staged, 'supervisor', 'bin', 'supervise.mjs'));
    expect(diagnosticCodeMatches({ ...identity, runtimeSha: identity.codeSha })).toBe(true);
    expect(diagnosticCodeMatches({ ...identity, runtimeSha: identity.rootSha })).toBe(false);
    expect(
      diagnosticCodeMatches({
        ...identity,
        codeSha: identity.rootSha,
        runtimeSha: identity.rootSha,
      }),
    ).toBe(false);
  });

  it('rejects dirty code and a foreign or unregistered worktree', () => {
    const { main, staged } = makeFixture();
    const foreign = join(resolve(main, '..'), 'foreign');
    mkdirSync(join(foreign, 'supervisor', 'bin'), { recursive: true });
    run('init', '--initial-branch=main', foreign);
    writeFileSync(join(foreign, 'supervisor', 'bin', 'supervise.mjs'), 'export {};\n');
    run('-C', foreign, 'add', 'supervisor');
    run(
      '-C',
      foreign,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'foreign',
    );
    expect(() => attestDiagnosticCode({ root: main, home: join(foreign, 'supervisor') })).toThrow(
      'untrusted-diagnostic-code',
    );
    writeFileSync(
      join(staged, 'supervisor', 'bin', 'supervise.mjs'),
      'export const changed = true;\n',
    );
    expect(() => attestDiagnosticCode({ root: main, home: join(staged, 'supervisor') })).toThrow(
      'untrusted-diagnostic-code',
    );
  });
});
