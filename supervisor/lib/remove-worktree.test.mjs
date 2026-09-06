import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeWorktree } from './remove-worktree.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
      : { code: 0, stdout: `worktree ${root}\n`, stderr: '' },
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

  it('сохраняет остатки после отказа Git, следующий оборот дочищает', () => {
    const state = world();
    state.run.mockReturnValueOnce({ code: 1, stderr: 'Directory not empty' });
    expect(removeWorktree(state).ok).toBe(false);
    expect(existsSync(state.path)).toBe(true);
    expect(removeWorktree(state).ok).toBe(true);
  });

  it('не доверяет сообщению об отсутствии регистрации без проверки списка', () => {
    const state = world();
    state.run.mockReturnValueOnce({ code: 128, stderr: 'not a working tree' });
    state.run.mockReturnValueOnce({ code: 0, stdout: `worktree ${state.path}\n` });
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
