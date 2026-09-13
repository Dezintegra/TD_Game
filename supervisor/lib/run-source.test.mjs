import { describe, expect, it } from 'vitest';
import { runSourceProblem } from './run-source.mjs';

describe.each(['perf', 'bench-tick'])('%s source', (kind) => {
  it.each([
    { branch: 'main' },
    { branch: 'worktree-0041-visual' },
    { branch: 'codex/visual' },
    { worktree: 'C:/code/tree with spaces' },
    { worktree: '../other-tree' },
  ])('accepts %j', (source) => {
    expect(runSourceProblem({ kind, params: { source } })).toBeNull();
  });
  it.each([
    undefined,
    null,
    '',
    [],
    {},
    { branch: '' },
    { branch: ' main' },
    { branch: 'main ' },
    { branch: 1 },
    { worktree: false },
    { worktree: '' },
    { branch: 'main', worktree: '.' },
    { change: 'visual' },
    { branch: 'main', extra: 1 },
    { branch: 'HEAD' },
    { branch: 'origin/main' },
    { branch: 'refs/heads/main' },
    { branch: 'a'.repeat(40) },
    { branch: '../main' },
    { branch: '-main' },
    { branch: 'bad.lock' },
    { branch: 'bad name' },
    { worktree: '//host/share' },
    { worktree: '\\\\host\\share' },
    { worktree: 'a\nb' },
  ])('rejects %j', (source) => {
    expect(runSourceProblem({ kind, params: { source, change: 'visual' } })).toContain(
      'run.params.source',
    );
  });
});

it('leaves arena and absent run alone', () => {
  expect(runSourceProblem({ kind: 'arena' })).toBeNull();
  expect(runSourceProblem(null)).toBeNull();
});
