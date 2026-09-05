import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDeploySnapshot } from './deploy-snapshot.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'td-snapshot-test-'));
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
  writeFileSync(join(root, '.gitignore'), '.pipeline/\n');
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
