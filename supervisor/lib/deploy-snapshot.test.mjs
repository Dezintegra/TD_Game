import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { prepareDeploySnapshot } from './deploy-snapshot.mjs';

const roots = [];
const scratch = fileURLToPath(new URL('../../.matchlog/', import.meta.url));
const projectIgnore = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(ignore = projectIgnore) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'td-snapshot-test-'));
  roots.push(root);
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  // Локальная настройка общая для detached-снимка и исходного репозитория;
  // личные исключения машины не должны делать проверку ложноположительной.
  git('config', 'core.excludesFile', join(root, 'absent-personal-ignore'));
  writeFileSync(join(root, '.gitignore'), ignore);
  writeFileSync(join(root, 'source'), 'base');
  git('add', '.');
  git('commit', '-m', 'base');
  git('branch', 'task');
  writeFileSync(join(root, 'source'), 'main');
  git('commit', '-am', 'main');
  const main = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', root);
  git('switch', 'task');
  writeFileSync(join(root, 'source'), 'task');
  git('commit', '-am', 'task');
  return {
    root,
    git,
    main,
    assignment: { taskId: '0001-task', stage: 'deploy', path: '.', branch: 'task' },
  };
}

it('prepares main despite conflicting task history and leaves task unchanged', () => {
  const f = fixture();
  const before = f.git('rev-parse', 'HEAD');
  const a = prepareDeploySnapshot(f.root, {}, f.assignment);
  expect(a.deploymentRevision).toBe(f.main);
  expect(a.branch).toBeNull();
  expect(readFileSync(join(f.root, a.path, 'source'), 'utf8')).toBe('main');
  expect(f.git('rev-parse', 'HEAD')).toBe(before);
  expect(readFileSync(join(f.root, 'source'), 'utf8')).toBe('task');
  expect(f.git('status', '--porcelain')).toBe('');
});

it('reuses a saved snapshot after main advances, including failed spawn retries', () => {
  const f = fixture();
  const a = prepareDeploySnapshot(f.root, {}, f.assignment);
  f.git('branch', '-f', 'main', 'task');
  expect(
    prepareDeploySnapshot(f.root, {}, { ...f.assignment, continuation: true }, a).deployment,
  ).toEqual(a.deployment);
  expect(prepareDeploySnapshot(f.root, {}, f.assignment, a).deployment).toEqual(a.deployment);
});

it('rejects old continuations and dirty snapshots without deleting files', () => {
  const f = fixture();
  expect(() => prepareDeploySnapshot(f.root, {}, { ...f.assignment, continuation: true })).toThrow(
    'без сохранённого',
  );
  const a = prepareDeploySnapshot(f.root, {}, f.assignment);
  const file = join(f.root, a.path, 'source');
  expect(() =>
    prepareDeploySnapshot(f.root, {}, f.assignment, {
      deployment: { ...a.deployment, revision: '0'.repeat(40) },
    }),
  ).toThrow('изменён');
  writeFileSync(file, 'keep');
  expect(() => prepareDeploySnapshot(f.root, {}, f.assignment, a)).toThrow('изменён');
  expect(readFileSync(file, 'utf8')).toBe('keep');
  expect(() =>
    prepareDeploySnapshot(f.root, {}, f.assignment, {
      deployment: { ...a.deployment, path: '..' },
    }),
  ).toThrow('неверный путь');
});

it('leaves other stages alone', () => {
  const a = { stage: 'audit' };
  expect(prepareDeploySnapshot('/absent', {}, a)).toBe(a);
});

function cachedSnapshot(ignore) {
  const f = fixture(ignore);
  const a = prepareDeploySnapshot(f.root, {}, f.assignment);
  const path = join(f.root, a.path);
  const cache = join(path, '.pnpm-store/v-test/files/cache-entry');
  mkdirSync(join(path, '.pnpm-store/v-test/files'), { recursive: true });
  writeFileSync(cache, 'cached package');
  const git = (...args) => f.git('-C', path, ...args);
  expect(git('config', '--get', 'core.excludesFile')).toBe(join(f.root, 'absent-personal-ignore'));
  expect(readFileSync(join(f.root, '.git/info/exclude'), 'utf8')).not.toContain('.pnpm-store');
  return { f, a, path, cache, git };
}

it('project ignore keeps nested pnpm cache clean without personal exclusions', () => {
  const { f, a, cache, git } = cachedSnapshot();
  expect(git('status', '--porcelain')).toBe('');
  expect(git('check-ignore', '-v', '.pnpm-store/v-test/files/cache-entry')).toMatch(
    /^\.gitignore:[0-9]+:\.pnpm-store\/\s+\.pnpm-store\/v-test\/files\/cache-entry$/,
  );
  const reused = prepareDeploySnapshot(f.root, {}, { ...f.assignment, continuation: true }, a);
  expect(reused.path).toBe(a.path);
  expect(reused.deploymentRevision).toBe(a.deploymentRevision);
  expect(readFileSync(cache, 'utf8')).toBe('cached package');
});

it.each([
  ['source', 'M source'],
  ['unexpected-source.txt', '?? unexpected-source.txt'],
])('cache does not hide changes to %s or allow their cleanup', (name, status) => {
  const { f, a, path, cache, git } = cachedSnapshot();
  const file = join(path, name);
  writeFileSync(file, 'keep this change');
  expect(git('status', '--porcelain')).toBe(status);
  expect(() =>
    prepareDeploySnapshot(f.root, {}, { ...f.assignment, continuation: true }, a),
  ).toThrow('снимок deploy изменён');
  expect(readFileSync(file, 'utf8')).toBe('keep this change');
  expect(readFileSync(cache, 'utf8')).toBe('cached package');
});

it('control without project cache exclusion detects and rejects the cache', () => {
  // Порча только фикстуры: рабочий ignore и чужой подготовленный коммит не меняются.
  const ignore = projectIgnore.replace(/^\.pnpm-store\/\r?\n/m, '');
  expect(ignore).not.toBe(projectIgnore);
  const { f, a, cache, git } = cachedSnapshot(ignore);
  expect(git('status', '--porcelain')).toBe('?? .pnpm-store/');
  expect(() => prepareDeploySnapshot(f.root, {}, f.assignment, a)).toThrow('снимок deploy изменён');
  expect(readFileSync(cache, 'utf8')).toBe('cached package');
});
