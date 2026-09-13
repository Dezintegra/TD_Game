import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeWorktree } from './remove-worktree.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
});
const inventory = (...paths) => ({
  code: 0,
  stdout: paths.map((path) => `worktree ${path}\0\0`).join(''),
  stderr: '',
});
function world() {
  const root = mkdtempSync(join(tmpdir(), 'td-cleanup-'));
  roots.push(root);
  const path = join(root, '.claude', 'worktrees', 'task');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'remaining.txt'), 'остаток');
  const run = vi.fn((args) =>
    args[1] === 'remove'
      ? { code: 128, stdout: '', stderr: 'fatal: not a working tree' }
      : inventory(root),
  );
  return { root, path, run };
}

describe('фактическое удаление дерева', () => {
  it('поддерживает настроенный каталог внутри проекта', () => {
    const state = world();
    const path = join(state.root, 'custom', 'task');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'remaining.txt'), 'остаток');
    expect(removeWorktree({ ...state, path, worktreeDir: 'custom' }).ok).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('отклоняет перенаправленный родительский каталог', () => {
    const state = world();
    const outside = join(state.root, 'outside');
    mkdirSync(join(outside, 'task'), { recursive: true });
    const parent = join(state.root, '.claude', 'worktrees');
    rmSync(parent, { recursive: true });
    symlinkSync(outside, parent, 'junction');
    expect(removeWorktree(state).ok).toBe(false);
    expect(state.run).not.toHaveBeenCalled();
    expect(existsSync(join(outside, 'task'))).toBe(true);
  });

  it('дочищает снятый с регистрации каталог и допускает повтор', () => {
    const state = world();
    expect(removeWorktree(state)).toEqual({ ok: true });
    expect(existsSync(state.path)).toBe(false);
    expect(removeWorktree(state)).toEqual({ ok: true });
  });

  it.each(['Directory not empty', 'Permission denied', 'не удалось удалить каталог'])(
    'дочищает после ошибки Git «%s», если регистрация уже снята',
    (stderr) => {
      const state = world();
      state.run.mockReturnValueOnce({ code: 1, stderr });
      expect(removeWorktree(state)).toEqual({ ok: true });
      expect(existsSync(state.path)).toBe(false);
    },
  );

  it('отказ с сохранённой регистрацией оставляет файлы до следующего вызова', () => {
    const state = world();
    state.run.mockReturnValueOnce({ code: 1, stderr: 'Directory not empty' });
    state.run.mockReturnValueOnce(inventory(state.root, state.path));
    expect(removeWorktree(state).ok).toBe(false);
    expect(existsSync(state.path)).toBe(true);
    expect(removeWorktree(state).ok).toBe(true);
  });

  it('не доверяет сообщению об отсутствии регистрации без проверки списка', () => {
    const state = world();
    state.run.mockReturnValueOnce({ code: 128, stderr: 'not a working tree' });
    state.run.mockReturnValueOnce(inventory(state.root, state.path));
    expect(removeWorktree(state).ok).toBe(false);
    expect(existsSync(state.path)).toBe(true);
  });

  it('не удаляет при недоступном списке деревьев', () => {
    const state = world();
    state.run.mockReturnValueOnce({ code: 128, stderr: 'not a working tree' });
    state.run.mockReturnValueOnce({ code: 1, stderr: 'failed' });
    expect(removeWorktree(state).ok).toBe(false);
    expect(existsSync(state.path)).toBe(true);
  });

  it.each(['', 'worktree /truncated'])(
    'неполный ответ Git «%s» не разрешает удаление',
    (stdout) => {
      const state = world();
      state.run.mockReturnValueOnce({ code: 0, stderr: '' });
      state.run.mockReturnValueOnce({ code: 0, stdout });
      expect(removeWorktree(state).ok).toBe(false);
      expect(existsSync(state.path)).toBe(true);
    },
  );

  it('исчезнувшая папка с оставшейся регистрацией не считается убранной', () => {
    const state = world();
    rmSync(state.path, { recursive: true });
    state.run.mockReturnValueOnce({ code: 1, stderr: 'locked' });
    state.run.mockReturnValueOnce(inventory(state.root, state.path));
    expect(removeWorktree(state).ok).toBe(false);
    expect(removeWorktree(state)).toEqual({ ok: true });
  });

  it('повтор после удаления самого каталога деревьев успешен', () => {
    const state = world();
    rmSync(join(state.root, '.claude'), { recursive: true });
    expect(removeWorktree(state)).toEqual({ ok: true });
  });

  it('проверяет границы снова после Git, если родитель заменён ссылкой', () => {
    const state = world();
    const outside = join(state.root, 'outside');
    mkdirSync(join(outside, 'task'), { recursive: true });
    writeFileSync(join(outside, 'task', 'keep.txt'), 'сохранить');
    state.run.mockImplementationOnce(() => {
      const parent = join(state.root, '.claude', 'worktrees');
      rmSync(parent, { recursive: true });
      symlinkSync(outside, parent, 'junction');
      return { code: 0, stderr: '' };
    });
    expect(removeWorktree(state).ok).toBe(false);
    expect(readFileSync(join(outside, 'task', 'keep.txt'), 'utf8')).toBe('сохранить');
  });

  it('удаляет весь остаток с глубокими зависимостями, сохраняя цель ссылки', () => {
    const state = world();
    const modules = join(state.path, 'packages', 'sim', 'node_modules');
    const nested = join(modules, '.pnpm', ...Array(6).fill('dependency-with-a-long-name'));
    mkdirSync(nested, { recursive: true });
    const readonly = join(nested, 'index.js');
    writeFileSync(readonly, 'export default 1;');
    chmodSync(readonly, 0o444);
    mkdirSync(join(state.path, '.cache'), { recursive: true });
    writeFileSync(join(state.path, '.cache', 'build'), 'кэш');
    const outside = join(state.root, 'shared-store');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'общая зависимость');
    symlinkSync(outside, join(modules, 'shared'), 'junction');
    expect(removeWorktree(state)).toEqual({ ok: true });
    expect(existsSync(state.path)).toBe(false);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('общая зависимость');
  });

  it('реальный Git убирает регистрацию, игнорируемые файлы и саму папку', () => {
    const state = world();
    const run = (args) => {
      const result = spawnSync('git', ['-C', state.root, ...args], { encoding: 'utf8' });
      return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    const git = (args) => expect(run(args)).toMatchObject({ code: 0 });
    git(['init']);
    writeFileSync(join(state.root, '.gitignore'), 'node_modules/\n.cache/\n');
    git(['add', '.gitignore']);
    git([
      '-c',
      'user.name=Cleanup test',
      '-c',
      'user.email=test@localhost',
      'commit',
      '-m',
      'init',
    ]);
    // Пробелы и кириллица проверяют список Git без экранирования имён.
    const path = join(state.root, '.claude', 'worktrees', 'задача с пробелами');
    git(['worktree', 'add', '-b', 'cleanup-test', path]);
    mkdirSync(join(path, 'node_modules', '.pnpm', 'dep'), { recursive: true });
    writeFileSync(join(path, 'node_modules', '.pnpm', 'dep', 'index.js'), 'dependency');
    expect(removeWorktree({ root: state.root, path, run })).toEqual({ ok: true });
    expect(existsSync(path)).toBe(false);
    expect(run(['worktree', 'list', '--porcelain', '-z']).stdout).not.toContain('cleanup-test');
    expect(removeWorktree({ root: state.root, path, run })).toEqual({ ok: true });
  });

  it('отклоняет основной корень и внешние пути до вызова Git', () => {
    const state = world();
    for (const path of [state.root, join(state.root, '..'), join(state.path, 'nested')]) {
      expect(removeWorktree({ ...state, path }).ok).toBe(false);
    }
    expect(state.run).not.toHaveBeenCalled();
  });

  it('не проходит по ссылке вместо дерева и сохраняет её цель', () => {
    const state = world();
    const outside = join(state.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'сохранить');
    rmSync(state.path, { recursive: true });
    symlinkSync(outside, state.path, 'junction');
    expect(removeWorktree(state).ok).toBe(false);
    expect(state.run).not.toHaveBeenCalled();
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });
});
