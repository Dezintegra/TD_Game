import { describe, expect, it } from 'vitest';
import { planConsolidations } from './consolidation.mjs';
import { pendingDependencies } from './dependencies.mjs';
const now = '2026-09-12T12:00:00Z';
const task = (id, over = {}) => ({
  id,
  title: id,
  description: 'Критерий ' + id,
  type: 'feature',
  status: 'candidate',
  owner: null,
  links: {},
  attempts: {},
  ...over,
});
const source = task('0001-source'),
  target = task('0002-target');
const item = {
  sourceId: source.id,
  targetId: target.id,
  mode: 'absorb',
  evidence: 'Один дефект в обработчике X',
  coverage: 'Сохранить отрицательную проверку и диагностический текст',
};
const context = (tasks = [source, target]) => ({
  tasks,
  originId: '0003-analysis',
  stage: 'triage',
  machine: 'station',
  busy: () => false,
  entryOf: () => null,
  now,
});
describe('поглощение без потери требований', () => {
  it('сохраняет требования до закрытия и ждёт результата принимающей задачи', () => {
    const plan = planConsolidations([item], context());
    expect(plan.rejected).toEqual([]);
    expect(plan.operations.map((o) => o.task.id)).toEqual([target.id, source.id]);
    const [to, from] = plan.operations.map((o) => o.task);
    expect(to.description).toContain(source.description);
    expect(to.description).toContain(item.coverage);
    expect(from).toMatchObject({ status: 'closed', splitInto: [target.id] });
    const dependent = task('0004-wait', { dependsOn: [source.id] });
    expect(pendingDependencies(dependent, [from, to])).not.toEqual([]);
    expect(pendingDependencies(dependent, [from, { ...to, status: 'completed' }])).toEqual([]);
  });
  it('подтверждённый дубль выполненного результата не создаёт новую работу', () => {
    const done = { ...target, status: 'completed' };
    const plan = planConsolidations(
      [{ ...item, mode: 'duplicate' }],
      context([
        {
          ...source,
          type: 'run',
          status: 'awaiting-po',
          owner: 'station',
          links: { change: 'old-run' },
        },
        done,
      ]),
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].task.splitInto).toEqual([target.id]);
  });
  it('проверяет незавершённый результат, цикл, занятую работу и доказательства', () => {
    const cases = [
      [[{ ...item, mode: 'duplicate' }], context()],
      [[{ ...item, evidence: '' }], context()],
      [[item], { ...context(), busy: () => true }],
      [[item], context([source, { ...target, dependsOn: [source.id] }])],
      [[item], context([{ ...source, links: { pr: 42 } }, target])],
    ];
    for (const [items, ctx] of cases) {
      const p = planConsolidations(items, ctx);
      expect(p.operations).toEqual([]);
      expect(p.rejected.length).toBeGreaterThan(0);
    }
  });
  it('группирует несколько источников в одну запись получателя', () => {
    const other = task('0005-other');
    const p = planConsolidations(
      [item, { ...item, sourceId: other.id }],
      context([source, target, other]),
    );
    expect(p.operations).toHaveLength(3);
    expect(p.operations[0].task.description).toContain(other.description);
  });
  it('не снимает удержание токенов у принимающей задачи', () => {
    const held = {
      ...target,
      status: 'token-limit',
      tokenHold: { resumeStatus: 'audit', unknown: true },
      tokenBudget: { spent: 777 },
    };
    const p = planConsolidations([item], context([source, held]));
    expect(p.operations[0].task).toMatchObject({
      status: 'token-limit',
      tokenHold: { resumeStatus: 'design', unknown: true },
      tokenBudget: { spent: 777 },
    });
  });
});
