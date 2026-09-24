import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const git = (args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  }).trim();

const samePath = (left, right) => {
  const normalize = (value) => resolve(value).replaceAll('\\', '/');
  const a = normalize(left);
  const b = normalize(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};

const fail = () => {
  throw new Error('untrusted-diagnostic-code');
};

/**
 * Attest the code actually loaded by the sole supervisor. The project root may
 * be main while the opt-in endpoint is loaded from a clean, registered worktree.
 * A descriptor-provided path is never sufficient authority by itself.
 */
export function attestDiagnosticCode({ root, home, readGit = git }) {
  try {
    const projectRoot = realpathSync(root);
    const codeHome = realpathSync(home);
    const codeRoot = dirname(codeHome);
    const entrypoint = realpathSync(join(codeHome, 'bin', 'supervise.mjs'));
    if (!samePath(codeHome, join(codeRoot, 'supervisor'))) fail();
    if (!samePath(entrypoint, join(codeRoot, 'supervisor', 'bin', 'supervise.mjs'))) fail();

    const read = (...args) => String(readGit(args)).trim();
    if (!samePath(read('-C', projectRoot, 'rev-parse', '--show-toplevel'), projectRoot)) fail();
    if (!samePath(read('-C', codeRoot, 'rev-parse', '--show-toplevel'), codeRoot)) fail();
    const common = (cwd) => resolve(cwd, read('-C', cwd, 'rev-parse', '--git-common-dir'));
    if (!samePath(common(projectRoot), common(codeRoot))) fail();

    const registered = read('-C', projectRoot, 'worktree', 'list', '--porcelain')
      .split(/\r?\n\r?\n/)
      .some((block) => {
        const path = block.match(/^worktree (.+)$/m)?.[1];
        return path && !/^prunable /m.test(block) && samePath(path, codeRoot);
      });
    if (!registered) fail();

    const codeSha = read('-C', codeRoot, 'rev-parse', 'HEAD');
    const rootSha = read('-C', projectRoot, 'rev-parse', 'HEAD');
    if (!/^[a-f0-9]{40}$/.test(codeSha) || !/^[a-f0-9]{40}$/.test(rootSha)) fail();
    if (read('-C', codeRoot, '--no-optional-locks', 'status', '--porcelain', '--', 'supervisor'))
      fail();
    if (read('-C', projectRoot, '--no-optional-locks', 'status', '--porcelain', '--', 'supervisor'))
      fail();
    return { root: projectRoot, entrypoint, codeSha, rootSha };
  } catch {
    fail();
  }
}

export function diagnosticCodeMatches(descriptor, { readGit = git } = {}) {
  try {
    const actual = attestDiagnosticCode({
      root: descriptor.root,
      home: dirname(dirname(descriptor.entrypoint)),
      readGit,
    });
    return (
      samePath(actual.root, descriptor.root) &&
      samePath(actual.entrypoint, descriptor.entrypoint) &&
      actual.codeSha === descriptor.codeSha &&
      actual.rootSha === descriptor.rootSha &&
      descriptor.runtimeSha === actual.codeSha
    );
  } catch {
    return false;
  }
}
