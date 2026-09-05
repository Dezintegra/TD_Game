import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkedProcess, checkInstallSnapshot } from './install-snapshot-check.mjs';

const base = resolve('.matchlog/install-snapshot-tests');
mkdirSync(base, { recursive: true });

function fixture(ignore = '.pnpm-store/\nnode_modules/\n.matchlog/\n') {
  const cwd = mkdtempSync(join(base, 'fixture-'));
  const git = (...args) =>
    checkedProcess('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args]);
  git('init');
  git('config', 'core.excludesFile', join(cwd, 'absent'));
  git('config', 'core.hooksPath', join(cwd, 'absent-hooks'));
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  mkdirSync(join(cwd, 'packages/example'), { recursive: true });
  writeFileSync(join(cwd, 'packages/example/source.ts'), 'export const value = 1;\n');
  writeFileSync(join(cwd, 'package.json'), '{"packageManager":"pnpm@10.12.4"}\n');
  writeFileSync(join(cwd, '.gitignore'), ignore);
  git('add', '--', '.gitignore', 'package.json', 'packages/example/source.ts');
  git('commit', '-m', 'fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('config', 'branch.master.remote', 'origin');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  git('config', `branch.${branch}.remote`, 'origin');
  git('config', `branch.${branch}.merge`, 'refs/heads/main');
  git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  return { cwd, git };
}

function installer(mode = 'ok') {
  return (program, args, options) => {
    if (program !== process.execPath) {
      if (program === 'git') {
        expect(args.find((arg) => arg.startsWith('safe.directory='))).not.toContain('\\');
      }
      return checkedProcess(program, args, options);
    }
    if (args[1] === '--version')
      return { status: 0, stdout: mode === 'version' ? '9.0.0' : '10.12.4', stderr: '' };
    expect(args.slice(1)).toEqual(['install', '--frozen-lockfile', '--store-dir', '.pnpm-store']);
    expect(process.cwd()).not.toBe(options.cwd);
    if (mode === 'error') throw new Error('pnpm: EPERM mkdir .pnpm-store');
    const store = join(options.cwd, '.pnpm-store/v10/files');
    mkdirSync(store, { recursive: true });
    if (mode !== 'empty') writeFileSync(join(store, 'package-content'), 'package bytes');
    if (mode === 'wrong-ignore') {
      writeFileSync(join(options.cwd, '.git/info/exclude'), '.pnpm-store/\n');
    }
    return { status: 0, stdout: 'fake installer', stderr: '' };
  };
}

const check = (cwd, mode) =>
  checkInstallSnapshot({ cwd, pnpmCli: 'fixture-pnpm.cjs', run: installer(mode) });

describe('install snapshot', () => {
  it('checks clean installation and independent controls, preserving old copies', () => {
    const { cwd } = fixture();
    const first = check(cwd);
    expect(first.error).toBeUndefined();
    expect(first.ok).toBe(true);
    expect(first.cacheAbsent).toBe(true);
    expect(first.sourceStatus).toBe(' M packages/example/source.ts\n');
    expect(first.restoredSourceStatus).toBe('');
    expect(first.extraStatus).toBe('?? install-check-untracked.txt\n');
    expect(first.finalStatus).toBe('');
    const second = check(cwd);
    expect(second.ok).toBe(true);
    expect(second.snapshot).not.toBe(first.snapshot);
    expect(existsSync(first.cacheFile && join(first.snapshot, first.cacheFile))).toBe(true);
    expect(JSON.parse(readFileSync(join(first.directory, 'result.json'), 'utf8')).ok).toBe(true);
  });

  it.each([
    ['error', 'EPERM'],
    ['empty', 'Cache has no'],
    ['version', 'version mismatch'],
  ])('rejects %s', (mode, message) => {
    const result = check(fixture().cwd, mode);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(message);
  });

  it('detects removing the project store ignore', () => {
    const result = check(fixture('node_modules/\n.matchlog/\n').cwd);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Dirty snapshot: ?? .pnpm-store/');
  });

  it('rejects a non-project ignore even with clean status', () => {
    const result = check(fixture('node_modules/\n.matchlog/\n').cwd, 'wrong-ignore');
    expect(result.error).toContain('Wrong ignore source');
  });

  it('rejects an unpushed revision before creating a copy', () => {
    const { cwd, git } = fixture();
    git('commit', '--allow-empty', '-m', 'unpushed');
    expect(check(cwd).error).toContain('HEAD must equal upstream');
    expect(existsSync(join(cwd, '.matchlog'))).toBe(false);
  });

  it('rejects a junction outside its root before writing there', () => {
    // Без завершающего слеша Git игнорирует и symlink на POSIX, и junction на Windows.
    const { cwd, git } = fixture('.pnpm-store/\nnode_modules/\n.matchlog\n');
    const outside = mkdtempSync(join(base, 'outside-'));
    symlinkSync(outside, join(cwd, '.matchlog'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(git('status', '--porcelain', '--untracked-files=all').stdout).toBe('');
    const result = check(cwd);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Path escapes workspace');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('does not accept a Git diagnostic as an empty clean status', () => {
    const { cwd } = fixture();
    const result = checkInstallSnapshot({
      cwd,
      pnpmCli: 'fixture-pnpm.cjs',
      run: (program, args, options) => {
        if (args.includes('status')) throw new Error('error: daemon terminated');
        return installer()(program, args, options);
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('daemon terminated');
  });

  it('rejects stderr errors, nonzero exit, missing commands and timeouts', () => {
    const script = join(base, 'process-result.mjs');
    writeFileSync(script, "console.error('error: daemon terminated');\n");
    expect(() => checkedProcess(process.execPath, [script])).toThrow('daemon terminated');
    writeFileSync(script, 'process.exit(2);\n');
    expect(() => checkedProcess(process.execPath, [script])).toThrow(': 2');
    expect(() => checkedProcess('missing-install-check-command', [])).toThrow('ENOENT');
    writeFileSync(script, 'setTimeout(() => {}, 10000);\n');
    expect(() => checkedProcess(process.execPath, [script], { timeout: 50 })).toThrow('ETIMEDOUT');
  });
});
