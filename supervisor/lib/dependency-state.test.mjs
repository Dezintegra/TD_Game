import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildDependencyState } from './dependency-state.mjs';
import { createCommandRunner } from './command-runner.mjs';
import { createTrelloBacklog } from './backlog-trello.mjs';
import { sortCards } from './validate-card.mjs';
import { joinDescription } from './card.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { scan } from './scan.mjs';
import { runCycle } from './cycle.mjs';

const root = 'C:/pipeline';
const { config } = resolveConfig({
  commands: { verify: 'x', deploy: 'x', perf: 'x' },
  mainBranch: 'main',
  maxConcurrent: 1,
});
const merged = {
  number: 168,
  state: 'MERGED',
  mergedAt: '2026-09-06T00:00:00Z',
  baseRefName: 'main',
};
const task = (id, over = {}) => ({
  id,
  type: 'feature',
  status: 'new',
  priority: 1,
  createdAt: '2026-09-06T00:00:00Z',
  attempts: { continuations: 0, cycleFailures: 0 },
  ...over,
});
const dependent = (over = {}) =>
  task('0001-next', {
    dependsOn: ['0002-base'],
    dependencyResults: [{ taskId: '0002-base', kind: 'merged-pr', pr: 168 }],
    ...over,
  });
const base = (over = {}) => task('0002-base', { status: 'closed', links: { pr: 168 }, ...over });
const registry = {
  entries: [
    { taskId: '0001-next', branch: 'worktree-0001-next', path: '.claude/worktrees/0001-next' },
    { taskId: '0003-ready', branch: 'worktree-0003-ready', path: '.claude/worktrees/0003-ready' },
  ],
};

// Оба режима получают ровно общий вызываемый сборщик из bin, без запуска main и живой доски.
async function decision(
  mode,
  {
    tasks = [dependent(), base()],
    value = merged,
    records = [],
    running = [],
    reports = [],
    invalid = [],
  } = {},
) {
  const exec = vi.fn(() => JSON.stringify(value));
  const state = await buildDependencyState({
    backlog: { tasks, invalid, dependencyRecords: records },
    config,
    root,
    run: createCommandRunner(root, exec),
    running,
    reports,
  });
  const input = { ...state, registry, config };
  const result =
    mode === 'cycle'
      ? scan(input)
      : runCycle({
          state: input,
          config,
          git: { tail: () => 0, behind: () => 0 },
          now: '2026-09-06T00:00:00Z',
          pid: 1,
          lock: null,
          ourAuthors: [],
          elapsed: () => 0,
        });
  return { result, exec, state };
}

describe.each(['cycle', 'supervise'])('снимок допуска %s', (mode) => {
  it('точка входа передаёт архив и использует общий сборщик и runner', () => {
    const source = readFileSync(new URL(`../bin/${mode}.mjs`, import.meta.url), 'utf8');
    expect(source).toContain("import { buildDependencyState } from '../lib/dependency-state.mjs'");
    expect(source).toContain('await buildDependencyState({');
    expect(source).toContain('run: runCommand');
    expect(source).toContain('const runCommand = createCommandRunner(root)');
    expect(source).toContain('dependencyRecords: store.dependencyRecords()');
  });
  it('не занимает квоту implement и не списывает пределы, следующий снимок разрешает продолжение', async () => {
    const held = dependent({
      status: 'implement',
      returnTo: 'audit',
      spentUsd: 1e9,
      attempts: { continuations: 999, cycleFailures: 999, spawnFailures: 999 },
    });
    const before = JSON.parse(JSON.stringify(held));
    const { result, exec } = await decision(mode, {
      tasks: [held, base(), task('0003-ready')],
      value: { ...merged, state: 'OPEN' },
    });
    expect(result.actions).toEqual([
      { kind: 'start-stage', taskId: '0003-ready', stage: 'decompose' },
    ]);
    expect(held).toEqual(before);
    expect(exec.mock.calls[0][2]).toMatchObject({ cwd: root, timeout: 10000, windowsHide: true });
    const released = await decision(mode, { tasks: [dependent({ status: 'implement' }), base()] });
    expect(released.result.actions).toContainEqual(
      expect.objectContaining({ kind: 'continue-stage', taskId: held.id, stage: 'implement' }),
    );
  });
  it('ожидающий run не держит очередь готовых фич', async () => {
    const { result } = await decision(mode, {
      tasks: [dependent({ type: 'run' }), base(), task('0003-ready')],
      value: null,
    });
    expect(result.actions).toEqual([
      { kind: 'start-stage', taskId: '0003-ready', stage: 'decompose' },
    ]);
  });
  it('ожидающий deploy не занимает исключительность и не входит в пакет', async () => {
    const held = dependent({ status: 'deploy' });
    const { result } = await decision(mode, {
      tasks: [held, base(), task('0003-ready', { status: 'deploy' })],
      value: null,
    });
    expect(result.actions).toEqual([
      expect.objectContaining({
        kind: 'continue-stage',
        taskId: '0003-ready',
        stage: 'deploy',
        batch: ['0003-ready'],
      }),
    ]);
    const ready = await decision(mode, { tasks: [held, base(), task('0003-ready')], value: null });
    expect(ready.result.actions).toEqual([
      { kind: 'start-stage', taskId: '0003-ready', stage: 'decompose' },
    ]);
  });
  it('сохраняет живой процесс и перенос отчёта, не читая GitHub', async () => {
    const tasks = [dependent({ status: 'implement' }), base(), task('0003-ready')];
    const running = await decision(mode, {
      tasks,
      running: [{ taskId: '0001-next', stage: 'implement' }],
      value: null,
    });
    expect(running.result.actions).toEqual([]);
    expect(running.exec).not.toHaveBeenCalled();
    const reported = await decision(mode, {
      tasks,
      reports: [{ taskId: '0001-next', stage: 'implement', outcome: 'done' }],
      value: null,
    });
    expect(reported.result.actions).toContainEqual({
      kind: 'transfer-report',
      taskId: '0001-next',
      stage: 'implement',
      outcome: 'done',
    });
    expect(reported.exec).not.toHaveBeenCalled();
  });
  it('требует и закрытие, и вливание, новый номер не наследует успех', async () => {
    const waiting = await decision(mode, { tasks: [dependent(), base({ status: 'deploy' })] });
    expect(waiting.result.actions.some((a) => a.taskId === '0001-next')).toBe(false);
    expect(waiting.exec).not.toHaveBeenCalled();
    expect((await decision(mode)).result.actions).toContainEqual({
      kind: 'start-stage',
      taskId: '0001-next',
      stage: 'decompose',
    });
    const changed = await decision(mode, {
      tasks: [
        dependent({ dependencyResults: [{ taskId: '0002-base', kind: 'merged-pr', pr: 169 }] }),
        base({ links: { pr: 169 } }),
      ],
    });
    expect(changed.exec.mock.calls[0][1][2]).toBe('169');
    expect(changed.result.actions).toEqual([]);
    expect((await decision(mode, { value: null })).result.actions).toEqual([]);
  });
  it('удерживает цикл даже через закрытого предшественника', async () => {
    const { result, exec } = await decision(mode, {
      tasks: [dependent(), base({ dependsOn: ['0001-next'] })],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes.join()).toContain('цикл зависимостей');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('сборка от снимка Trello до допуска', () => {
  it.each([false, true])('закрытый предшественник, архивирован=%s', async (archived) => {
    const lists = Object.entries(config.trello.lists).map(([status, name]) => ({
      id: status,
      name,
    }));
    const labels = [{ id: 'feature', name: config.trello.labels.feature.name }];
    const cards = [dependent(), base()].map((task) => ({
      id: `65000000${task.id}`,
      name: task.id,
      idLabels: ['feature'],
      idList: task.status,
      desc: joinDescription('Описание', task),
      closed: task.id === '0002-base' && archived,
    }));
    const store = createTrelloBacklog({
      config,
      trello: {},
      snapshot: { lists, labels, cards, comments: [] },
    });
    const backlog = {
      ...sortCards(store.parsedCards()),
      dependencyRecords: store.dependencyRecords(),
      closedDependencyIds: store.closedDependencyIds(),
    };
    const run = createCommandRunner(root, () => JSON.stringify(merged));
    const state = await buildDependencyState({ backlog, config, root, run });
    expect(scan({ ...state, config }).actions).toContainEqual({
      kind: 'start-stage',
      taskId: '0001-next',
      stage: 'decompose',
    });
    const duplicate = await buildDependencyState({
      backlog: {
        ...backlog,
        dependencyRecords: [...backlog.dependencyRecords, { ...base(), valid: false }],
      },
      config,
      root,
      run,
    });
    expect(scan({ ...duplicate, config }).actions).toEqual([]);
  });
  it('тайм-аут чтения не меняет режим прочих команд', async () => {
    const exec = vi.fn(() => {
      throw Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT', status: null });
    });
    const run = createCommandRunner(root, exec);
    const state = await buildDependencyState({
      backlog: { tasks: [dependent(), base()] },
      config,
      root,
      run,
    });
    expect(scan({ ...state, config }).notes.join()).toContain('ETIMEDOUT');
    expect(exec.mock.calls[0][2].timeout).toBe(10000);
    run(['status']);
    expect(exec.mock.calls[1][2]).not.toHaveProperty('timeout');
  });
});
