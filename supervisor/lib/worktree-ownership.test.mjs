import { describe, expect, it } from 'vitest';
import { recoverOwnership } from './worktree-ownership.mjs';
import { reconcile } from './reconcile.mjs';
import { repairWorld } from './repair.mjs';
const task = { id: '0001-one', owner: 'station', status: 'cleanup' };
const entry = { taskId: task.id, branch: 'worktree-0001-one', path: 'owned/0001-one' };
const context = { task, root: process.cwd(), machine: 'station' };
const record = { root: process.cwd(), machine: 'station', entry };
describe('принадлежность после частичной уборки', () => {
  it('восстанавливает только собственный сохранённый путь', () => {
    expect(recoverOwnership(record, context)).toEqual(entry);
    for (const bad of [
      { ...record, machine: 'other' },
      { ...record, root: '/other' },
      { ...record, entry: { ...entry, path: '.' } },
      { ...record, entry: { ...entry, branch: 'main' } },
    ])
      expect(recoverOwnership(bad, context)).toBeNull();
    expect(recoverOwnership(record, { ...context, task: { ...task, owner: 'other' } })).toBeNull();
  });
  it.each(['cleanup', 'failed', 'postmortem', 'awaiting-po', 'deploy', 'pr', 'review'])(
    'не выбрасывает запись остановленной задачи в %s',
    (status) => {
      const plan = reconcile({
        registry: { entries: [entry] },
        tasks: [{ ...task, status }],
        worktrees: [],
        machine: 'station',
      });
      expect(plan.repairs.some((r) => r.kind === 'drop-entry')).toBe(false);
    },
  );
  it('усыновление использует найденный путь, а не шаблон расположения', () => {
    let saved;
    repairWorld([{ kind: 'adopt-worktree', ...entry, path: 'actual/path' }], {
      now: '2026-09-12T00:00:00Z',
      readTask: () => task,
      worktreePathFor: (_id, actual) => actual,
      upsertRegistry: (e) => {
        saved = e;
      },
    });
    expect(saved.path).toBe('actual/path');
  });
});
