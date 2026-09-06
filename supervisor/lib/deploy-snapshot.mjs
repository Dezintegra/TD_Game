import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function within(parent, child) {
  const path = relative(parent, child);
  return path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

/** Prepare only deploy's process assignment; the task registry is never changed. */
export function prepareDeploySnapshot(root, config, assignment, previous = null) {
  if (assignment.stage !== 'deploy') return assignment;
  const base = resolve(root, '.pipeline/deploy-checkouts');
  let snapshot = previous?.deployment;
  if (!snapshot && (assignment.continuation || assignment.sessionId)) {
    throw new Error(
      'продолжение deploy без сохранённого снимка: требуется разбор прежней выкладки',
    );
  }
  if (!snapshot) {
    const remote = config.remote ?? 'origin';
    const branch = config.mainBranch ?? 'main';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) throw new Error('неверный remote');
    git(root, 'check-ref-format', `refs/heads/${branch}`);
    git(
      root,
      'fetch',
      '--no-tags',
      remote,
      `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
    );
    const revision = git(
      root,
      'rev-parse',
      '--verify',
      `refs/remotes/${remote}/${branch}^{commit}`,
    );
    mkdirSync(base, { recursive: true });
    const path = mkdtempSync(join(base, 'deploy-'));
    git(root, 'worktree', 'add', '--detach', path, revision);
    snapshot = { path: relative(root, path), revision };
  }
  const path = resolve(root, snapshot.path);
  if (
    !within(base, path) ||
    !within(realpathSync(base), realpathSync(path)) ||
    !/^[a-f0-9]{40,64}$/.test(snapshot.revision)
  ) {
    throw new Error('неверный путь или ревизия снимка deploy');
  }
  const common = (cwd) =>
    realpathSync(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  if (common(path) !== common(root))
    throw new Error('снимок deploy принадлежит другому репозиторию');
  if (
    git(path, 'rev-parse', '--abbrev-ref', 'HEAD') !== 'HEAD' ||
    git(path, 'rev-parse', 'HEAD') !== snapshot.revision ||
    git(path, 'status', '--porcelain')
  ) {
    throw new Error('снимок deploy изменён: требуется разбор без reset и clean');
  }
  return {
    ...assignment,
    path: snapshot.path,
    branch: null,
    deployment: snapshot,
    deploymentRevision: snapshot.revision,
  };
}
