import { describe, expect, it } from 'vitest';
import { planDependencyUpdates } from './dependency-updates.mjs';

const source = '0001-source';
const target = { id: '0003-consumer', status: 'failed' };
const update = {
  taskId: target.id,
  dependsOn: ['0002-producer'],
  dependencyResults: [{ taskId: '0002-producer', kind: 'merged-pr', pr: 42 }],
  reason: 'Поручено постановкой задачи',
};
const plan = (updates = [update], records = [target]) =>
  planDependencyUpdates(updates, source, records);

describe('dependencyUpdates', () => {
  it('принимает отсутствие и пустой массив', () => {
    expect(planDependencyUpdates(undefined, source, []).tasks).toEqual([]);
    expect(plan([]).tasks).toEqual([]);
  });
  it.each(
    [
      null,
      {},
      'updates',
      [null],
      [{ ...update, extra: 1 }],
      [{ ...update, reason: ' ' }],
      [{ ...update, taskId: '0003' }],
      [{ ...update, dependsOn: [] }],
      [{ ...update, dependsOn: [target.id] }],
      [{ ...update, dependencyResults: null }],
      [{ ...update, dependsOn: ['0002-producer', '0002-producer'] }],
      [
        {
          ...update,
          dependencyResults: [update.dependencyResults[0], update.dependencyResults[0]],
        },
      ],
      [update, update],
      [{ ...update, dependsOn: ['0002'] }],
      [{ ...update, dependencyResults: [{ ...update.dependencyResults[0], pr: 0 }] }],
      [{ taskId: target.id, dependsOn: update.dependsOn, reason: 'yes' }],
    ].map((value) => [value]),
  )('отвергает неверную оболочку %j', (updates) => expect(plan(updates).ok).toBe(false));
  it.each(
    [
      [],
      [target, target],
      [target, { ...target, archived: true }],
      [target, { ...target, valid: false }],
      [{ ...target, archived: true }],
      [{ ...target, valid: false }],
      [{ ...target, status: 'closed' }],
    ].map((value) => [value]),
  )('не скрывает негодного или неоднозначного адресата %j', (records) => {
    expect(plan([update], records).ok).toBe(false);
  });
  it('запрещает источник', () => {
    expect(planDependencyUpdates([update], target.id, [target]).ok).toBe(false);
  });
  it('сохраняет порядок, входы, поля failed и распознаёт повтор по значениям', () => {
    const current = {
      ...target,
      unknown: { keep: true },
      dependsOn: ['0004-old'],
      dependencyResults: [{ taskId: '0004-old', kind: 'merged-pr', pr: 9 }],
    };
    const before = JSON.parse(JSON.stringify({ current, update }));
    const result = plan([update], [current]);
    expect(result.ok).toBe(true);
    expect(result.tasks[0]).toEqual({
      ...current,
      dependsOn: ['0004-old', '0002-producer'],
      dependencyResults: [...current.dependencyResults, ...update.dependencyResults],
    });
    const reordered = {
      ...update,
      dependencyResults: [{ pr: 42, kind: 'merged-pr', taskId: '0002-producer' }],
    };
    expect(plan([reordered], result.tasks).tasks).toEqual(result.tasks);
    expect({ current, update }).toEqual(before);
    expect(
      plan(
        [{ ...update, dependencyResults: [{ ...update.dependencyResults[0], pr: 43 }] }],
        result.tasks,
      ).ok,
    ).toBe(false);
  });
  it('разрешает ребро без результата и отсутствующего предшественника', () => {
    expect(plan([{ ...update, dependencyResults: [] }]).ok).toBe(true);
  });
  it('отвергает цикл совокупных кандидатов до записи', () => {
    expect(
      plan(
        [
          update,
          {
            taskId: '0002-producer',
            dependsOn: [target.id],
            dependencyResults: [],
            reason: 'assigned',
          },
        ],
        [target, { id: '0002-producer', status: 'new' }],
      ).why,
    ).toContain('цикл');
  });
});
