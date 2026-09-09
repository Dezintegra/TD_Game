import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAssignmentPreparer, prepareBenchmarkSource } from './benchmark-source.mjs';
import { runParamRecoveries, recoveryKey } from './run-param-recovery.mjs';
import { withReceipt } from './report-receipts.mjs';

it.each([false, true])(
  'повторно сверяет полный восстановленный заказ, continuation=%s',
  (continuation) => {
    const recipe = runParamRecoveries[0];
    const task = withReceipt(
      {
        id: recipe.targetTaskId,
        run: { kind: 'arena', params: JSON.parse(JSON.stringify(recipe.params)) },
      },
      recoveryKey(recipe, 'ready'),
    );
    const ops = {
      prepareDeploySnapshot: (_root, _config, assignment) => assignment,
      prepareCodexPerfFiles: vi.fn(),
    };
    const prepare = createAssignmentPreparer('/repo', { provider: 'codex' }, ops);
    const assignment = { taskId: task.id, stage: 'benchmark', continuation, task };
    expect(prepare(assignment).reason).toContain('run.params сверены');
    ops.prepareCodexPerfFiles.mockClear();
    task.run.params.matches = 1;
    expect(() => prepare(assignment)).toThrow('не совпадают');
    expect(ops.prepareCodexPerfFiles).not.toHaveBeenCalled();
    task.run.params = recipe.params;
    delete task.reportReceipts;
    expect(() => prepare(assignment)).toThrow('ещё не подтверждены');
    expect(ops.prepareCodexPerfFiles).not.toHaveBeenCalled();
  },
);

it.each([false, true])('проверяет заказ до ACL и источника, continuation=%s', (continuation) => {
  const ops = { git: vi.fn(), prepareDeploySnapshot: vi.fn(), prepareCodexPerfFiles: vi.fn() };
  const prepare = createAssignmentPreparer('/repo', { provider: 'codex' }, ops);
  expect(() =>
    prepare({
      taskId: '0308-test',
      stage: 'benchmark',
      continuation,
      task: { run: { kind: 'arena' } },
    }),
  ).toThrow('0308-test: run.params');
  for (const operation of Object.values(ops)) expect(operation).not.toHaveBeenCalled();
});

const root = resolve('fixture/main');
const other = resolve('fixture/outside tree');
const mainHead = '1'.repeat(40);
const otherHead = '2'.repeat(40);
function fixture({
  detached = false,
  duplicate = false,
  foreign = false,
  missing = false,
  moved = false,
} = {}) {
  const entries = [
    `worktree ${root}\0HEAD ${mainHead}\0branch refs/heads/main\0\0`,
    `worktree ${other}\0HEAD ${otherHead}\0${detached ? 'detached' : 'branch refs/heads/worktree-0041-visual'}\0\0`,
  ];
  const git = vi.fn((cwd, ...args) => {
    const command = args.join(' ');
    if (command === 'worktree list --porcelain -z')
      return entries.join('') + (duplicate ? entries[1] : '');
    if (command === 'rev-parse --show-toplevel') return cwd;
    if (command === 'rev-parse --path-format=absolute --git-common-dir')
      return foreign && cwd === other ? resolve('foreign/.git') : resolve(root, '.git');
    if (command === 'rev-parse --symbolic-full-name HEAD')
      return cwd === root || moved
        ? 'refs/heads/main'
        : detached
          ? 'HEAD'
          : 'refs/heads/worktree-0041-visual';
    if (command === 'rev-parse --verify HEAD') return cwd === root ? mainHead : otherHead;
    throw new Error(`unexpected Git command: ${command}`);
  });
  const realpath = vi.fn((path) => {
    if (missing && path === other) throw new Error('ENOENT');
    if (path === resolve('unavailable')) throw new Error('EACCES');
    return resolve(path);
  });
  return { git, realpath };
}
const assignment = (source, kind = 'perf') => ({
  stage: 'benchmark',
  task: { type: 'run', run: { kind, params: { source } } },
});

describe.each(['perf', 'bench-tick'])('resolve %s', (kind) => {
  it('selects unmerged code instead of distinct main code', () => {
    const ops = fixture();
    const source = { branch: 'worktree-0041-visual' };
    const input = assignment(source, kind);
    const result = prepareBenchmarkSource(root, input, ops);
    expect(result.path).toBe(other);
    expect(result.benchmarkSource).toEqual({
      source,
      path: other,
      branch: source.branch,
      head: otherHead,
    });
    expect(input).not.toHaveProperty('path');
    expect(
      prepareBenchmarkSource(root, assignment({ branch: 'main' }, kind), ops).benchmarkSource.head,
    ).toBe(mainHead);
  });
  it.each([other, '../outside tree'])(
    'accepts root path %s outside main, with spaces',
    (worktree) => {
      expect(prepareBenchmarkSource(root, assignment({ worktree }, kind), fixture()).path).toBe(
        other,
      );
    },
  );
  it('allows detached only by path', () => {
    expect(
      prepareBenchmarkSource(
        root,
        assignment({ worktree: other }, kind),
        fixture({ detached: true }),
      ).benchmarkSource.branch,
    ).toBeNull();
    expect(() =>
      prepareBenchmarkSource(
        root,
        assignment({ branch: 'worktree-0041-visual' }, kind),
        fixture({ detached: true }),
      ),
    ).toThrow('найдено 0');
  });
  it.each([
    { branch: 'remote-only' },
    { branch: 'worktree-0041' },
    { worktree: `${other}/subdirectory` },
  ])('rejects unavailable or inexact %j', (source) => {
    expect(() => prepareBenchmarkSource(root, assignment(source, kind), fixture())).toThrow(
      'найдено 0',
    );
  });
  it.each([{ duplicate: true }, { foreign: true }, { missing: true }, { moved: true }])(
    'refuses unsafe source %j',
    (options) => {
      expect(() =>
        prepareBenchmarkSource(
          root,
          assignment({ branch: 'worktree-0041-visual' }, kind),
          fixture(options),
        ),
      ).toThrow('run.params.source');
    },
  );
  it('reports inaccessible paths and never falls back on missing source', () => {
    expect(() =>
      prepareBenchmarkSource(
        root,
        assignment({ worktree: resolve('unavailable') }, kind),
        fixture(),
      ),
    ).toThrow('EACCES');
    const ops = fixture();
    expect(() => prepareBenchmarkSource(root, assignment(undefined, kind), ops)).toThrow(
      'run.params.source',
    );
    expect(ops.git).not.toHaveBeenCalled();
  });
});

it('does not prepare arena, interpret or deploy', () => {
  const ops = fixture();
  for (const input of [
    assignment(undefined, 'arena'),
    { ...assignment(undefined), stage: 'interpret' },
    { ...assignment(undefined), stage: 'deploy' },
  ])
    expect(prepareBenchmarkSource(root, input, ops)).toBe(input);
  expect(ops.git).not.toHaveBeenCalled();
});

it('rechecks source on continuation instead of trusting saved path and SHA', () => {
  const input = {
    ...assignment({ branch: 'worktree-0041-visual' }),
    continuation: true,
    path: root,
    benchmarkSource: { path: root, head: mainHead },
  };
  expect(prepareBenchmarkSource(root, input, fixture()).benchmarkSource.head).toBe(otherHead);
  expect(() => prepareBenchmarkSource(root, input, fixture({ missing: true }))).toThrow('ENOENT');
});
