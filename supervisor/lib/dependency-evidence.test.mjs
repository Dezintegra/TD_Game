import { describe, expect, it, vi } from 'vitest';
import { collectDependencyEvidence } from './dependency-evidence.mjs';
import { pendingDependencies } from './dependencies.mjs';

const dependent = (over = {}) => ({
  id: '0001-next',
  status: 'new',
  dependsOn: ['0002-base'],
  dependencyResults: [{ taskId: '0002-base', kind: 'merged-pr', pr: 168 }],
  ...over,
});
const base = (over = {}) => ({ id: '0002-base', status: 'completed', links: { pr: 168 }, ...over });
const merged = (over = {}) => ({
  number: 168,
  state: 'MERGED',
  mergedAt: '2026-09-06T12:00:00Z',
  baseRefName: 'main',
  ...over,
});
const root = 'C:/pipeline';
const config = { mainBranch: 'main' };
const runner = (value = merged()) =>
  vi.fn(() => ({ code: 0, stdout: JSON.stringify(value), stderr: '' }));
const collect = (run, over = {}) =>
  collectDependencyEvidence({ tasks: [dependent(), base()], config, root, run, ...over });
const pending = (evidence, over = {}) =>
  pendingDependencies(dependent(), [base()], [], { evidence, mainBranch: 'main', ...over });

describe('доказательство результата', () => {
  it('читает уникальный номер в корне конвейера с ограничением и возвращает неизменный снимок', async () => {
    const run = runner();
    const evidence = await collect(run, {
      tasks: [dependent(), dependent({ id: '0003-next' }), base()],
    });
    expect(run.mock.calls).toEqual([
      [
        ['pr', 'view', '168', '--json', 'number,state,mergedAt,baseRefName'],
        'gh',
        root,
        { timeout: 10000 },
      ],
    ]);
    expect(pending(evidence)).toEqual([]);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence[168])).toBe(true);
  });
  it.each([
    null,
    {},
    merged({ state: 'OPEN' }),
    merged({ state: 'CLOSED' }),
    merged({ state: 'unknown' }),
    merged({ number: 169 }),
    merged({ number: '168' }),
    merged({ baseRefName: 'other' }),
    merged({ mergedAt: null }),
    merged({ mergedAt: '' }),
    merged({ mergedAt: 'bad' }),
  ])('не принимает неполный или неподходящий ответ %j', async (value) => {
    const evidence = await collect(runner(value));
    expect(pending(evidence).join()).toContain('PR #168');
    expect(evidence[168].problem).toBeTruthy();
  });
  it.each([
    () => ({ code: 1, stderr: 'offline' }),
    () => ({ code: 0, stdout: '{' }),
    () => {
      throw new Error('ETIMEDOUT');
    },
    () => Promise.reject(new Error('rejected')),
  ])('ошибка одного номера не мешает проверке другого', async (fail) => {
    const run = vi.fn((args) =>
      args[2] === '168' ? fail() : { code: 0, stdout: JSON.stringify(merged({ number: 169 })) },
    );
    const tasks = [
      dependent(),
      base(),
      dependent({
        id: '0003-next',
        dependsOn: ['0004-base'],
        dependencyResults: [{ taskId: '0004-base', kind: 'merged-pr', pr: 169 }],
      }),
      base({ id: '0004-base', links: { pr: 169 } }),
    ];
    const evidence = await collect(run, { tasks });
    expect(evidence[168].problem).toBeTruthy();
    expect(evidence[169].state).toBe('MERGED');
  });
  it.each([
    { tasks: [dependent({ dependencyResults: [] }), base()] },
    { tasks: [{ id: '0001-old', dependsOn: ['0002-base'], status: 'new' }, base()] },
    { tasks: [dependent({ dependencyResults: null }), base()] },
    { tasks: [dependent(), base({ status: 'deploy' })] },
    { tasks: [dependent(), base({ links: { pr: 169 } })] },
    { tasks: [dependent(), base({ links: { pr: null } })] },
    { tasks: [dependent()] },
    { tasks: [dependent(), base(), base()] },
    { dependencyRecords: [base()] },
    { invalid: [{ id: '0002-base' }] },
    { running: [{ taskId: '0001-next', stage: 'implement' }] },
    { reports: [{ taskId: '0001-next', stage: 'implement' }] },
    { reports: [{ taskId: '0009-deploy', stage: 'deploy', batch: ['0001-next'] }] },
    { tasks: [dependent({ status: 'completed' }), base()] },
    { tasks: [dependent({ dependsOn: ['0001-next'] }), base()] },
  ])('не читает GitHub при непригодном для проверки условии %j', async (over) => {
    const run = runner();
    expect(await collect(run, over)).toEqual({});
    expect(run).not.toHaveBeenCalled();
  });
  it('архивный ID без записи не доказывает результат, годная запись доказывает', async () => {
    const run = runner();
    const records = [base({ valid: true })];
    const evidence = await collect(run, { tasks: [dependent()], dependencyRecords: records });
    expect(
      pendingDependencies(dependent(), [], ['0002-base'], { mainBranch: 'main', evidence }),
    ).not.toEqual([]);
    expect(
      pendingDependencies(dependent(), [], [], { records, mainBranch: 'main', evidence }),
    ).toEqual([]);
    for (const bad of [
      base({ valid: false }),
      base({ status: 'new' }),
      base({ dependsOn: null }),
    ]) {
      expect(await collect(runner(), { tasks: [dependent()], dependencyRecords: [bad] })).toEqual(
        {},
      );
    }
  });
  it('перечитывает после перезапуска, смены ссылки и главной ветки', async () => {
    const run = runner();
    expect(pending(await collect(run))).toEqual([]);
    run.mockReturnValue({ code: 0, stdout: JSON.stringify(merged({ state: 'OPEN' })) });
    expect(pending(await collect(run))).not.toEqual([]);
    expect(await collect(run, { tasks: [dependent(), base({ links: { pr: 169 } })] })).toEqual({});
    expect(await collect(runner(), { config: { mainBranch: 'release' } })).toMatchObject({
      168: { problem: 'другая база PR' },
    });
  });
  it('не читает без корня репозитория', async () => {
    const run = runner();
    expect(pending(await collect(run, { root: null })).join()).toContain('репозиторий');
    expect(run).not.toHaveBeenCalled();
  });
});
