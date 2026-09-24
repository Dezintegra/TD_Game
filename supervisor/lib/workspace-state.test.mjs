import { describe, it, expect, vi } from 'vitest';
import { checkWorkspace, unavailableWorkspaces } from './workspace-state.mjs';
import { reconcile } from './reconcile.mjs';
import { repairWorld } from './repair.mjs';
import { resolve } from 'node:path';

const task = {
  id: '0043-old',
  type: 'feature',
  status: 'review',
  owner: 'test',
  links: { pr: 106 },
};
const entry = { taskId: task.id, path: 'old', branch: `worktree-${task.id}` };
const root = resolve('fixture');
describe('проверка существования и принадлежности дерева', () => {
  it.each([null, 42, ''])('повреждённый путь %s не роняет сверку остальных задач', (path) => {
    const registry = { entries: [{ ...entry, path }] };
    expect(
      unavailableWorkspaces({ tasks: [task], registry, worktrees: [entry], root }),
    ).toHaveProperty(task.id);
    expect(
      reconcile({
        tasks: [task],
        registry,
        worktrees: [entry],
        root,
        machine: 'test',
      }).notes.join(),
    ).toContain('повреждён');
  });
  it('призрачная регистрация Git не делает каталог пригодным', () => {
    const state = {
      tasks: [task],
      registry: { entries: [entry] },
      worktrees: [entry],
      root,
      directory: () => false,
    };
    expect(unavailableWorkspaces(state)).toHaveProperty(task.id);
    expect(reconcile({ ...state, machine: 'test' }).repairs).toEqual([]);
    const run = vi.fn();
    expect(checkWorkspace({ root, entry, directory: () => false, run }).ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  it('существующий каталог с другой веткой не принимается', () => {
    const run = vi.fn((args) => ({
      code: 0,
      stdout: args.includes('rev-parse') ? resolve(root, entry.path) : 'main',
    }));
    expect(checkWorkspace({ root, entry, directory: () => true, run }).ok).toBe(false);
  });
  it('перемещённое действующее дерево восстанавливает путь без создания', () => {
    const moved = { path: 'moved', branch: entry.branch };
    const repairs = reconcile({
      tasks: [task],
      registry: { entries: [entry] },
      worktrees: [moved],
      root,
      machine: 'test',
      directory: (path) => path === resolve(root, 'moved'),
    }).repairs;
    expect(repairs).toEqual([{ kind: 'adopt-worktree', taskId: task.id, ...moved }]);
  });
  it('сверка PR предшествует восстановлению прежней ветки', () => {
    const params = {
      tasks: [task],
      registry: { entries: [entry] },
      worktrees: [],
      machine: 'test',
      now: '2026-09-14T00:00:00Z',
    };
    expect(reconcile(params).repairs).toEqual([]);
    const checked = { ...task, reconciliation: { pr: 106, state: 'open', checkedAt: params.now } };
    expect(reconcile({ ...params, tasks: [checked] }).repairs).toMatchObject([
      { kind: 'finish-claim', existingOnly: true },
    ]);
  });
  it('влитому служебному PR дерево не создаётся', () => {
    const io = {
      readTask: () => ({ ...task, reconciliation: { state: 'merged' } }),
      deploymentImpact: () => ({ needed: false }),
      addWorktree: vi.fn(),
    };
    expect(
      repairWorld(
        [{ kind: 'finish-claim', taskId: task.id, branch: entry.branch, existingOnly: true }],
        io,
      )[0].result,
    ).toBe('skipped');
    expect(io.addWorktree).not.toHaveBeenCalled();
  });
  it('исключение одной починки не прерывает остальные', () => {
    const io = {
      readTask: () => task,
      addWorktree: () => {
        throw Error('broken directory');
      },
    };
    expect(
      repairWorld(
        [
          { kind: 'finish-claim', taskId: task.id },
          { kind: 'report-orphan', taskId: 'other' },
        ],
        io,
      ).map((item) => item.result),
    ).toEqual(['failed', 'reported']);
  });
});
