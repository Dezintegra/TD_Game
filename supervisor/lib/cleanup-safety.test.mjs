import { describe, expect, it, vi } from 'vitest';
import { inspectCleanup } from './cleanup-safety.mjs';
const head = 'a'.repeat(40),
  task = { id: '0001-one', links: { pr: 42 } },
  entry = { taskId: '0001-one', branch: 'worktree-0001-one', path: '.claude/worktrees/0001-one' };
const root = process.cwd(),
  config = { worktreeDir: '.claude/worktrees', remote: 'origin', mainBranch: 'main' };
function check({ dirty = '', local = head, remote = head, exists = false } = {}) {
  const run = vi.fn((args) => ({
    code: 0,
    stdout:
      args[0] === '-C'
        ? dirty
        : args[0] === 'for-each-ref'
          ? local
          : args[0] === 'ls-remote'
            ? remote
              ? `${remote}\trefs/heads/worktree-0001-one`
              : ''
            : JSON.stringify({
                number: 42,
                state: 'MERGED',
                mergedAt: '2026-09-12T00:00:00Z',
                baseRefName: 'main',
                headRefOid: head,
              }),
  }));
  return { result: inspectCleanup({ task, entry, root, config, run, exists: () => exists }), run };
}
describe('сохранность работы при уборке', () => {
  it('повторяет частично завершённую уборку без уже удалённых веток', () =>
    expect(check({ local: '', remote: '' }).result.ok).toBe(true));
  it('сжатие PR не мешает удалить только исходную голову ветки', () =>
    expect(check().result.ok).toBe(true));
  it('сохраняет коммит, появившийся после вливания, локально и удалённо', () => {
    expect(check({ local: 'b'.repeat(40) }).result.ok).toBe(false);
    expect(check({ remote: 'b'.repeat(40) }).result.ok).toBe(false);
  });
  it('сохраняет несохранённые чужие файлы и не продолжает проверку удаления', () => {
    const { result, run } = check({ dirty: '?? чужая-работа.txt', exists: true });
    expect(result.ok).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
