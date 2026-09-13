import { describe, expect, it } from 'vitest';
import { planBacklogReview, backlogFingerprint, queueBacklogReview } from './backlog-review.mjs';
import { planClassifications, planResumptions } from './consolidation.mjs';
const source = {
  id: '0001-one',
  type: 'feature',
  title: 'Уточнить правило',
  description: 'supervisor: одно правило',
  status: 'candidate',
  owner: null,
  links: {},
};
describe('самостоятельная сверка изменившейся доски', () => {
  it('не платит снова за те же факты и не размножает незавершённый проход', () => {
    const first = planBacklogReview({ tasks: [source] });
    const audit = {
      id: '0002-review',
      status: 'completed',
      backlogReview: { fingerprints: first.fingerprints },
    };
    expect(planBacklogReview({ tasks: [source, audit] })).toBeNull();
    const changed = { ...source, description: 'новый критерий' };
    expect(planBacklogReview({ tasks: [changed, audit] })).not.toBeNull();
    expect(planBacklogReview({ tasks: [changed, { ...audit, status: 'token-limit' }] })).toBeNull();
  });
  it('ограничивает пакет и учитывает результаты связанной задачи', () => {
    const tasks = Array.from({ length: 12 }, (_, i) => ({
      ...source,
      id: `${i.toString().padStart(4, '0')}-one`,
    }));
    expect(Object.keys(planBacklogReview({ tasks }).fingerprints)).toHaveLength(8);
    const linked = { ...source, links: { related: ['0002-done'] } };
    expect(backlogFingerprint(linked, [{ id: '0002-done', status: 'new' }])).not.toBe(
      backlogFingerprint(linked, [{ id: '0002-done', status: 'completed' }]),
    );
  });
  it('создаёт обычную бюджетируемую заметку обслуживания и не повторяет её после потери ответа', async () => {
    const tasks = [source];
    const action = planBacklogReview({ tasks });
    const io = {
      now: '2026-09-12T00:00:00Z',
      allTaskIds: () => tasks.map((t) => t.id),
      readTask: (id) => tasks.find((t) => t.id === id),
      createTask: async (t) => {
        tasks.push(t);
        return { ok: true };
      },
    };
    expect((await queueBacklogReview(action, io)).result).toBe('done');
    expect(tasks[1]).toMatchObject({
      type: 'note',
      area: 'pipeline',
      status: 'maintenance',
      backlogReview: { fingerprints: action.fingerprints },
    });
    expect((await queueBacklogReview(action, io)).result).toBe('skipped');
  });
  it('классифицирует только незанятого кандидата с доказательством', () => {
    const item = {
      taskId: source.id,
      area: 'pipeline',
      evidence: 'Правка supervisor/skills/implement.md',
    };
    const ctx = {
      tasks: [source],
      originId: '0002-review',
      stage: 'triage',
      now: '2026-09-12T00:00:00Z',
      busy: () => false,
    };
    expect(planClassifications([item], ctx).operations[0].task).toMatchObject({
      status: 'maintenance',
      area: 'pipeline',
      workKind: 'service',
      workReason: item.evidence,
    });
    expect(
      planClassifications([item], {
        ...ctx,
        tasks: [{ ...source, workKind: 'game', workReason: 'Прежняя оценка' }],
      }).operations[0].task.workKind,
    ).toBe('service');
    expect(planClassifications([item], { ...ctx, busy: () => true }).operations).toEqual([]);
    expect(planClassifications([{ ...item, evidence: '' }], ctx).operations).toEqual([]);
  });
});

describe('доказанный возврат остановленной работы', () => {
  const stopped = {
    ...source,
    status: 'failed',
    returnTo: 'design',
    spentUsd: 37,
    recovery: { returns: 1 },
    attempts: { cycleFailures: 9 },
  };
  const ctx = {
    tasks: [stopped],
    originId: '0002-review',
    stage: 'triage',
    now: '2026-09-12T00:00:00Z',
    busy: () => false,
    machine: 'station',
  };
  const item = {
    taskId: source.id,
    stage: 'design',
    evidence: 'Противоречие в плане снято существующим amendments',
  };
  it('возвращает только на сохранённый этап с сохранением расхода и предела возвратов', () => {
    expect(planResumptions([item], ctx).operations[0].task).toMatchObject({
      status: 'design',
      spentUsd: 37,
      recovery: { returns: 2 },
      attempts: { cycleFailures: 0 },
    });
    expect(planResumptions([{ ...item, stage: 'implement' }], ctx).operations).toEqual([]);
  });
  it('не обходит бюджет, занятость и исчерпанные возвраты', () => {
    for (const patch of [
      { tokenHold: { reason: 'cost' } },
      { recovery: { returns: 2 } },
      { owner: 'foreign' },
    ])
      expect(
        planResumptions([item], { ...ctx, tasks: [{ ...stopped, ...patch }] }).operations,
      ).toEqual([]);
    expect(planResumptions([item], { ...ctx, busy: () => true }).operations).toEqual([]);
  });
});
