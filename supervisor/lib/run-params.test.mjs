import { describe, expect, it } from 'vitest';
import { benchmarkRunProblem, runParamsProblem } from './run-params.mjs';

describe('сохраняемый JSON без тихих потерь', () => {
  it.each([
    undefined,
    null,
    [],
    '',
    { x: undefined },
    { x: NaN },
    { x: Infinity },
    { x: -0 },
    { x: () => 1 },
    { x: 1n },
    { x: Symbol('x') },
    { x: new Date() },
    { x: new Map() },
    { x: Array(2) },
    { [Symbol('x')]: 1 },
    Object.defineProperty({}, 'x', { value: 1 }),
    {
      get x() {
        throw new Error('не вызывать');
      },
    },
  ])('отвергает несохраняемое значение #%#', (params) => {
    expect(runParamsProblem(params)).toContain('run.params');
  });
  it('отличает цикл от повторного использования объекта', () => {
    const x = { value: null };
    expect(runParamsProblem({ a: x, b: x, more: [true, false, 0, 1.5, '', {}] })).toBeNull();
    x.self = x;
    expect(runParamsProblem({ x })).toContain('циклическая');
  });
  it('не теряет дополнительные свойства массива', () => {
    const list = [1];
    list.extra = 2;
    expect(runParamsProblem({ list })).toContain('run.params.list');
  });
});

describe('готовность benchmark', () => {
  it.each([undefined, null, [], {}])('останавливает неполную арену %j', (params) => {
    expect(benchmarkRunProblem({ kind: 'arena', params })).toContain('run.params');
  });
  it.each([[], null, [['a']], [['a', '']], [['a', 2]], [['a', 'b', 'c']]])(
    'указывает повреждённую пару %j',
    (profilePairs) => {
      expect(benchmarkRunProblem({ kind: 'arena', params: { profilePairs } })).toContain(
        'run.params.profilePairs',
      );
    },
  );
  it('указывает индекс стороны', () => {
    expect(
      benchmarkRunProblem({
        kind: 'arena',
        params: {
          profilePairs: [
            ['a', 'b'],
            ['a', ' '],
          ],
        },
      }),
    ).toContain('[1][1]');
  });
  it.each([
    { matches: 20, seed: 1 },
    { profiles: ['a', 'b'], matches: 60, seed: 1, change: 'test' },
    { profilePairs: [['a', 'b']], tuning_args: '' },
  ])('сохраняет прежнюю допустимую форму %j', (params) => {
    expect(benchmarkRunProblem({ kind: 'arena', params })).toBeNull();
  });
  it.each(['perf', 'bench-tick'])('использует действующий контракт source для %s', (kind) => {
    expect(benchmarkRunProblem({ kind, params: {} })).toContain('run.params.source');
    for (const source of [{ branch: 'main' }, { worktree: 'local/tree' }])
      expect(benchmarkRunProblem({ kind, params: { source } })).toBeNull();
  });
});
