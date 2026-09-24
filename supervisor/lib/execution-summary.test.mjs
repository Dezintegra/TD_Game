import { expect, it, vi } from 'vitest';
import { executionSummary, executionNote } from './execution-summary.mjs';
import { execute } from './execute.mjs';

const task = { id: '0001-test', type: 'feature', status: 'postmortem', attempts: {}, history: [] };
const action = { kind: 'continue-stage', taskId: task.id, stage: task.status };
function io() {
  return {
    now: '2026-09-14T00:00:00Z',
    machine: 'test',
    readTask: () => task,
    registryEntry: () => ({ path: 'gone', branch: 'worktree-0001-test' }),
    directoryExists: () => false,
    readJournal: () => '',
    boardDigest: () => [],
    spawnStage: vi.fn(() => ({ ok: true, pid: 123 })),
    saveTask: vi.fn(async () => ({ ok: true })),
  };
}
it('план, отказ и служебная работа не объявляются запуском', () => {
  expect(executionSummary('worked', [], [], false)).toMatchObject({
    outcome: 'planned',
    launches: 0,
  });
  const summary = executionSummary('worked', [{ result: 'failed' }, { result: 'skipped' }]);
  expect(summary).toMatchObject({ outcome: 'held', launches: 0, failed: 1, skipped: 1 });
  expect(executionNote(summary)).toContain('запущено процессов: 0');
  expect(executionSummary('worked', [{ result: 'done' }])).toMatchObject({
    outcome: 'progress',
    service: 1,
    launches: 0,
  });
});
it('аналитический этап не получает исчезнувший каталог, отказ записи не стирает запуск', async () => {
  const world = io();
  world.saveTask.mockResolvedValue({ ok: false, outcome: 'write-failed' });
  const results = await execute([action], world);
  expect(world.spawnStage.mock.calls[0][0].path).toBe(null);
  expect(executionSummary('worked', results)).toMatchObject({
    outcome: 'worked',
    launches: 1,
    failed: 1,
  });
});
it('исключение после рождения процесса учитывается и не прерывает независимое действие', async () => {
  const world = io();
  let count = 0;
  world.spawnCount = () => count;
  world.spawnStage.mockImplementation(() => {
    count++;
    throw Error('stage store write failed');
  });
  const results = await execute([action, { kind: 'no-such-action', taskId: 'other' }], world);
  expect(results).toHaveLength(2);
  expect(executionSummary('worked', results)).toMatchObject({ launches: 1, failed: 1, skipped: 1 });
});
it('отсутствующее обязательное дерево не вызывает процесс и не тратит продолжение', async () => {
  const world = io();
  world.readTask = () => ({ ...task, status: 'review' });
  world.workspaceStatus = () => ({ ok: false });
  const results = await execute([{ ...action, stage: 'review' }], world);
  expect(executionSummary('worked', results).launches).toBe(0);
  expect(world.spawnStage).not.toHaveBeenCalled();
  expect(world.saveTask).not.toHaveBeenCalled();
});
