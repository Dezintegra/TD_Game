import { describe, expect, it } from 'vitest';
import { dependencyFixture } from './dependency-updates-fixture.mjs';
import { deliveryFixture } from './testing/report-delivery-fixture.mjs';
import { execute } from './execute.mjs';
import { prepareReportPlan } from './report-plan.mjs';
import { joinDescription, splitDescription } from './card.mjs';

describe('адресные зависимости в устойчивом плане доставки', () => {
  it('повторяет сохранённый отчёт для failed-адресата под своим неактивным захватом', async () => {
    const dependencies = dependencyFixture();
    const old = splitDescription(dependencies.cards[0].desc);
    dependencies.cards[0].idList = 'list-failed';
    dependencies.cards[0].idMembers = ['me'];
    dependencies.cards[0].desc = joinDescription(old.human, { ...old.meta, owner: 'A' });
    const f = deliveryFixture({ reportOverrides: { dependencyUpdates: [dependencies.update] } });
    try {
      dependencies.cards.push({ ...f.open().recipient.state().cards[0], idBoard: 'b' });
      const io = (activity) => ({
        ...dependencies.store('A'),
        now: f.now,
        reportStore: f.open().store,
        readReport: () => f.report,
        ...(activity ? { tokenActionBlocked: activity } : {}),
      });
      expect((await execute([f.action], io()))[0]).toMatchObject({ result: 'failed' });
      expect(f.open().store.get(f.entry.reportId)).toMatchObject({
        plan: { version: 1 },
        progress: [],
      });
      expect(splitDescription(dependencies.cards[0].desc).meta.dependsOn).toBeUndefined();
      const checks = [];
      const result = await execute(
        [f.action],
        io((targetId, reportId) => {
          checks.push([targetId, reportId]);
          return false;
        }),
      );
      expect(result[0]).toMatchObject({ result: 'done', status: 'pr' });
      expect(checks).toContainEqual([dependencies.update.taskId, f.entry.reportId]);
      expect(dependencies.cards[0].idMembers).toEqual(['me']);
      expect(dependencies.cards[0].idList).toBe('list-failed');
      expect(splitDescription(dependencies.cards[0].desc).meta).toMatchObject({
        owner: 'A',
        dependsOn: ['0002-producer'],
        dependencyResults: dependencies.update.dependencyResults,
      });
      expect(f.open().store.entries()).toEqual([]);
    } finally {
      f.cleanup();
    }
  });
  it('продвижение адресата-предшественника сохраняет дополнение из того же отчёта', async () => {
    const dependencies = dependencyFixture();
    dependencies.cards[0].idList = 'list-candidate';
    dependencies.cards[0].idLabels.push('label-category-infrastructure');
    const f = deliveryFixture({
      outcome: 'blocked',
      taskOverrides: { categories: ['infrastructure'] },
      reportOverrides: {
        routingVersion: 1,
        categories: ['infrastructure'],
        dependencyUpdates: [dependencies.update],
        blockers: [
          {
            taskId: dependencies.update.taskId,
            reason: 'Нужен результат',
            result: 'Готовый канал',
          },
        ],
      },
    });
    try {
      const opened = f.open();
      dependencies.cards.push({ ...opened.recipient.state().cards[0], idBoard: 'b' });
      const io = {
        ...dependencies.store(),
        now: f.now,
        reportStore: opened.store,
        readReport: () => f.report,
      };
      expect((await execute([f.action], io))[0]).toMatchObject({
        result: 'done',
        status: 'blocked',
      });
      expect(io.readTask(dependencies.update.taskId)).toMatchObject({
        status: 'new',
        dependsOn: ['0002-producer'],
        dependencyResults: dependencies.update.dependencyResults,
      });
    } finally {
      f.cleanup();
    }
  });
  it.each(['write-response', 'readback', 'source-journal'])(
    'подтверждает адресата заново после %s и сохраняет единственный переход',
    async (point) => {
      const dependencies = dependencyFixture();
      const f = deliveryFixture({
        reportOverrides: { dependencyUpdates: [dependencies.update] },
      });
      try {
        const source = f.open().recipient.state().cards[0];
        dependencies.cards.push({ ...source, idBoard: 'b' });
        const open = () => {
          const { store } = f.open();
          const io = {
            ...dependencies.store(),
            now: f.now,
            reportStore: store,
            readReport: () => f.report,
          };
          return { io, store };
        };
        const first = open();
        const plan = await prepareReportPlan(f.action, first.io);
        expect(plan.operations[0].kind).toBe('appendTaskDependencies');
        expect(dependencies.calls.some((call) => call.method !== 'GET')).toBe(false);
        first.store.update(f.entry.reportId, { plan });
        let written = false;
        let injected = false;
        dependencies.hook = (method, path, body) => {
          if (method === 'PUT' && path === 'cards/card-target') {
            written = true;
            if (point === 'write-response' && !injected) {
              injected = true;
              Object.assign(dependencies.cards[0], body);
              return { ok: false, why: 'lost PUT response' };
            }
          }
          if (
            !injected &&
            ((point === 'readback' &&
              written &&
              method === 'GET' &&
              path === 'cards/card-target') ||
              (point === 'source-journal' &&
                method === 'POST' &&
                path.endsWith('/actions/comments')))
          ) {
            injected = true;
            return { ok: false, why: 'lost confirmation' };
          }
        };
        const results = await execute(
          [f.action, { kind: 'start-stage', taskId: dependencies.update.taskId, stage: 'design' }],
          first.io,
        );
        expect(results.map((result) => result.result)).toEqual(['failed', 'skipped']);
        expect(first.store.entries()).toHaveLength(1);
        expect(splitDescription(dependencies.cards[0].desc).meta.dependsOn).toEqual([
          '0002-producer',
        ]);
        if (point !== 'source-journal')
          expect(first.io.readTask(f.task.id).status).toBe('implement');
        else {
          // Квитанция источника не разрешает обойти захват адресата при повторе.
          dependencies.cards[0].idMembers = ['other'];
          expect((await execute([f.action], open().io))[0].result).toBe('failed');
          expect(dependencies.cards[0].idMembers).toEqual(['other']);
          dependencies.cards[0].idMembers = [];
        }
        dependencies.hook = null;
        dependencies.calls.length = 0;
        const second = open();
        expect((await execute([f.action], second.io))[0]).toMatchObject({
          result: 'done',
          status: 'pr',
        });
        expect(
          dependencies.calls.some(
            (call) => call.method === 'PUT' && call.path === 'cards/card-target',
          ),
        ).toBe(false);
        expect(second.io.readTask(f.task.id)).toMatchObject({ status: 'pr', spentUsd: 7 });
        expect(second.store.entries()).toEqual([]);
        expect(splitDescription(dependencies.cards[0].desc).meta.extra).toEqual({
          nested: ['не терять'],
        });
      } finally {
        f.cleanup();
      }
    },
  );
});
