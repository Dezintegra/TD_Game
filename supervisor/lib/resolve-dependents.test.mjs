import { describe, expect, it } from 'vitest';
import { planEdgeResolutions, resolveDependents } from './resolve-dependents.mjs';

const now = '2026-09-10T12:00:00Z';

const task = (over = {}) => ({
  id: '0143-waiting',
  type: 'feature',
  status: 'blocked',
  title: 'Ждущая',
  priority: 1,
  createdAt: now,
  statusChangedAt: now,
  ...over,
});

const closed = (over = {}) => ({
  id: '0117-permit',
  type: 'feature',
  status: 'closed',
  title: 'Закрытая',
  priority: 2,
  createdAt: now,
  statusChangedAt: now,
  closureReason: 'Предмет снят: разрешения выкладки уже в origin/main.',
  ...over,
});

function harness(tasks) {
  const saved = [];
  const io = {
    now,
    machine: 'station',
    readTask: (id) => tasks.find((item) => item.id === id),
    saveTask: async (next, entry) => {
      saved.push({ next, entry });
      const at = tasks.findIndex((item) => item.id === next.id);
      tasks[at] = next;
      return { ok: true };
    },
  };
  return { io, saved, tasks };
}

describe('план снятия ожиданий', () => {
  it('находит рёбра в закрытую карточку и называет причину её закрытия', () => {
    const plans = planEdgeResolutions({
      tasks: [task({ dependsOn: ['0117-permit'] }), closed()],
    });
    expect(plans).toHaveLength(1);
    expect(plans[0].taskId).toBe('0143-waiting');
    expect(plans[0].edges[0]).toMatchObject({
      dependencyId: '0117-permit',
      field: 'dependsOn',
      reason: 'Предмет снят: разрешения выкладки уже в origin/main.',
    });
  });

  it('видит починку конвейера наравне с предусловием', () => {
    const plans = planEdgeResolutions({
      tasks: [
        task({ status: 'failed', recovery: { causedBy: 'pipeline', fixedBy: ['0117-permit'] } }),
        closed(),
      ],
    });
    expect(plans[0].edges[0]).toMatchObject({
      field: 'recovery.fixedBy',
      what: 'починка конвейера',
    });
  });

  it('не трогает закрытие дроблением: работа переехала в части, а не отпала', () => {
    expect(
      planEdgeResolutions({
        tasks: [task({ dependsOn: ['0117-permit'] }), closed({ splitInto: ['0243-part'] })],
      }),
    ).toEqual([]);
  });

  it('не трогает выполненную карточку и двусмысленный номер', () => {
    expect(
      planEdgeResolutions({
        tasks: [task({ dependsOn: ['0117-permit'] }), closed({ status: 'completed' })],
      }),
    ).toEqual([]);
    // Две карточки под одним идентификатором: какая из них закрыта — неизвестно,
    // и снимать ожидание вслепую нельзя.
    expect(
      planEdgeResolutions({
        tasks: [task({ dependsOn: ['0117-permit'] }), closed(), closed({ status: 'design' })],
      }),
    ).toEqual([]);
  });

  it('называет отсутствие причины прямо, а не выдумывает её', () => {
    const plans = planEdgeResolutions({
      tasks: [task({ dependsOn: ['0117-permit'] }), closed({ closureReason: undefined })],
    });
    expect(plans[0].edges[0].reason).toContain('не сохранилась');
  });

  it('берёт закрытые карточки и из архивных записей', () => {
    const plans = planEdgeResolutions({
      tasks: [task({ dependsOn: ['0117-permit'] })],
      records: [closed()],
    });
    expect(plans[0].edges[0].dependencyId).toBe('0117-permit');
  });
});

describe('снятие ожидания', () => {
  it('снимает ребро и пишет оба обоснования', async () => {
    const h = harness([task({ dependsOn: ['0117-permit'] }), closed()]);
    const [plan] = planEdgeResolutions({ tasks: h.tasks });
    const result = await resolveDependents({ kind: 'resolve-dependents', ...plan }, h.io);
    expect(result.result).toBe('done');
    expect(h.tasks[0].dependsOn).toEqual([]);
    const what = h.saved[0].entry.what;
    expect(what).toContain('Почему закрыта ожидаемая задача');
    expect(what).toContain('разрешения выкладки уже в origin/main');
    expect(what).toContain('Почему ожидание снято');
    expect(h.saved[0].entry.source).toBe('supervisor');
  });

  it('снимает вместе с ребром и ожидаемый влитый PR', async () => {
    const h = harness([
      task({
        dependsOn: ['0117-permit', '0200-live'],
        dependencyResults: [{ taskId: '0117-permit', kind: 'merged-pr', pr: 123 }],
      }),
      closed(),
    ]);
    const [plan] = planEdgeResolutions({ tasks: h.tasks });
    await resolveDependents({ kind: 'resolve-dependents', ...plan }, h.io);
    expect(h.tasks[0].dependsOn).toEqual(['0200-live']);
    expect(h.tasks[0].dependencyResults).toEqual([]);
  });

  it('повтор на неизменном снимке ничего не пишет', async () => {
    const h = harness([task({ dependsOn: ['0117-permit'] }), closed()]);
    const [plan] = planEdgeResolutions({ tasks: h.tasks });
    await resolveDependents({ kind: 'resolve-dependents', ...plan }, h.io);
    const again = await resolveDependents({ kind: 'resolve-dependents', ...plan }, h.io);
    expect(again.result).toBe('skipped');
    expect(h.saved).toHaveLength(1);
  });

  it('сохранённое основание ожидания переживает снятие', async () => {
    const blockedContext = {
      operation: 'wait',
      priority: 1,
      from: 'design',
      reasons: [{ taskId: '0117-permit', reason: 'нужны разрешения', result: 'этап поедет' }],
    };
    const h = harness([task({ dependsOn: ['0117-permit'], blockedContext }), closed()]);
    const [plan] = planEdgeResolutions({ tasks: h.tasks });
    await resolveDependents({ kind: 'resolve-dependents', ...plan }, h.io);
    // Основание — запись о том, чего задача ждала, и она верна после снятия.
    // Схема требует от неё непустоты, а разблокировка узнаёт по ней законное
    // ожидание: сотри её — и задача осталась бы в «Заблокированы» навсегда.
    expect(h.tasks[0].blockedContext).toEqual(blockedContext);
  });

  it('чужую задачу не трогает', async () => {
    const h = harness([task({ dependsOn: ['0117-permit'], owner: 'other' }), closed()]);
    const [plan] = planEdgeResolutions({ tasks: h.tasks });
    const result = await resolveDependents({ kind: 'resolve-dependents', ...plan }, h.io);
    expect(result.result).toBe('skipped');
    expect(h.saved).toEqual([]);
  });
});
