import { afterEach, expect, it } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { codexPerfPaths, prepareCodexPerfFiles } from './codex-perf-files.mjs';
import { codexExecutionArgs } from './provider.mjs';
import { releasePerfLock } from '../../scripts/perf-lock.mjs';

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'td-perf-files-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('подготовка сохраняет активный замок и всю историю при повторном вызове', () => {
  const root = fixture();
  const [lock, log] = codexPerfPaths(root, root, {});
  prepareCodexPerfFiles(root, root, {});
  expect(readFileSync(lock, 'utf8')).toBe('');
  expect(readFileSync(log, 'utf8')).toBe('');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  appendFileSync(log, '{"old":true}\n');
  const before = readFileSync(lock, 'utf8');
  prepareCodexPerfFiles(root, root, {});
  expect(readFileSync(lock, 'utf8')).toBe(before);
  expect(readFileSync(log, 'utf8')).toBe('{"old":true}\n');
});

it('освобождение сохраняет идентичность файла, допускает повтор и не трогает чужой PID', () => {
  const root = fixture();
  const [lock] = codexPerfPaths(root, root, {});
  prepareCodexPerfFiles(root, root, {});
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const ino = statSync(lock).ino;
  releasePerfLock(lock);
  releasePerfLock(lock);
  expect(existsSync(lock)).toBe(true);
  expect(statSync(lock).ino).toBe(ino);
  expect(readFileSync(lock, 'utf8')).toBe('');
  writeFileSync(lock, '{"pid":-1}');
  releasePerfLock(lock);
  expect(readFileSync(lock, 'utf8')).toBe('{"pid":-1}');
});

it('отвергает каталог вместо журнала, не уничтожая его', () => {
  const root = fixture();
  mkdirSync(join(root, '.perf-log.jsonl'));
  expect(() => prepareCodexPerfFiles(root, root, {})).toThrow('обычным файлом');
  expect(statSync(join(root, '.perf-log.jsonl')).isDirectory()).toBe(true);
});

it('PERF_LOG относительно назначенного cwd сохраняет существующие записи', () => {
  const root = fixture();
  const cwd = join(root, 'tree');
  mkdirSync(cwd);
  const env = { PERF_LOG: 'custom.jsonl' };
  expect(codexPerfPaths(root, cwd, env)).toEqual([
    join(root, '.perf-lock'),
    join(cwd, 'custom.jsonl'),
  ]);
  writeFileSync(join(cwd, 'custom.jsonl'), 'history\n');
  prepareCodexPerfFiles(root, cwd, env);
  expect(readFileSync(join(cwd, 'custom.jsonl'), 'utf8')).toBe('history\n');
  expect(existsSync(join(root, '.perf-log.jsonl'))).toBe(false);
});

it('профиль даёт запись только в два файла и Git, не открывая main или .pipeline', () => {
  const root = fixture();
  const cwd = join(root, 'tree');
  mkdirSync(cwd);
  const args = codexExecutionArgs({}, root, cwd, 'win32');
  const profile = args.find((arg) => arg.startsWith('permissions='));
  const quote = (p) => JSON.stringify(p.replaceAll('\\', '/'));
  expect(profile).toContain(quote(resolve(root, '.perf-lock')) + '="write"');
  expect(profile).toContain(quote(resolve(root, '.perf-log.jsonl')) + '="write"');
  expect(profile).not.toContain(quote(root) + '="write"');
  expect(profile).not.toContain('.pipeline');
  expect(profile).toContain('extends=":workspace"');
  const unix = codexExecutionArgs({}, root, cwd, 'linux');
  const writable = JSON.parse(
    unix
      .find((arg) => arg.startsWith('sandbox_workspace_write.writable_roots='))
      .split('=')
      .slice(1)
      .join('='),
  );
  expect(writable).toEqual([join(root, '.git'), ...codexPerfPaths(root, cwd)]);
});
