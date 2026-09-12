import { afterEach, describe, expect, it } from 'vitest';
import { execute } from './execute.mjs';
import { deliveryFixture } from './testing/report-delivery-fixture.mjs';
import { prepareReportPlan } from './report-plan.mjs';

const fixtures = [];
const fixture = (options) => {
  const f = deliveryFixture(options);
  fixtures.push(f);
  return f;
};
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});
const deliver = async (f, opened) => (await execute([f.action], opened.io))[0];

describe('durable report execution', () => {
  it.each(['response', 'progress'])(
    'keeps same-slug request identities after collision and lost %s',
    async (point) => {
      const f = fixture({
        reportOverrides: {
          requests: [0, 1].map((index) => ({
            type: 'note',
            title: 'Same title',
            description: `Request ${index}`,
            priority: 50,
          })),
        },
      });
      const first = f.open();
      const plan = await prepareReportPlan(f.action, first.io);
      first.store.update(f.entry.reportId, { plan });
      expect(plan.result.created).toEqual(['0003-same-title', '0004-same-title']);
      await first.recipient.store.createTask({ ...f.member, id: '0003-occupied' });
      const resumed = f.open();
      if (point === 'response') resumed.recipient.fail('POST', 'cards', 'after');
      else {
        const update = resumed.store.update;
        resumed.store.update = (id, changes) => {
          if (changes.progress?.at(-1) === plan.operations[0].key)
            throw new Error('lost creation progress');
          return update(id, changes);
        };
      }
      expect((await deliver(f, resumed)).result).toBe('failed');
      const afterFirst = f.open();
      const born = afterFirst.recipient.store
        .allTaskIds()
        .filter((id) => id.endsWith('same-title'));
      // Номер второй заявки зарезервирован всем планом, первая его не забирает.
      expect(born).toEqual(['0005-same-title']);
      await afterFirst.recipient.store.createTask({ ...f.member, id: '0004-occupied' });
      const second = f.open();
      second.recipient.fail('POST', 'cards', 'after');
      expect((await deliver(f, second)).result).toBe('failed');
      const pending = second.store.entries()[0];
      expect(pending.progress).toContain(plan.operations[0].key);
      expect(pending.plan.operations[0]).toEqual(resumed.store.entries()[0].plan.operations[0]);
      const final = f.open();
      expect(await deliver(f, final)).toMatchObject({
        result: 'done',
        created: ['0005-same-title', '0006-same-title'],
      });
      expect(final.recipient.store.readTask(f.task.id).links.related).toEqual([
        '0005-same-title',
        '0006-same-title',
      ]);
      expect(final.recipient.store.readTask('0005-same-title').description).toContain('Request 0');
      expect(final.recipient.store.readTask('0006-same-title').description).toContain('Request 1');
      expect(final.recipient.state().cards).toHaveLength(6);
      expect(final.recipient.state()).toMatchObject({ puts: 1, posts: 5 });
      expect(f.open().store.entries()).toEqual([]);
      expect((await deliver(f, f.open())).result).toBe('skipped');
    },
  );
  it.each(['journal', 'release'])('recovers blocked delivery after %s failure', async (point) => {
    const f = fixture({
      outcome: 'blocked',
      taskOverrides: { categories: ['infrastructure'] },
      memberOverrides: { status: 'candidate', categories: ['infrastructure'] },
      reportOverrides: {
        routingVersion: 1,
        categories: ['infrastructure'],
        blockers: [
          {
            taskId: '0002-member',
            reason: 'Required repair',
            result: 'Repair merged',
            dependencyResult: { kind: 'merged-pr', pr: 215 },
          },
        ],
      },
    });
    const first = f.open();
    first.recipient.fail(
      point === 'release' ? 'DELETE' : 'POST',
      point === 'release' ? '/idMembers/' : '/actions/comments',
      'after',
    );
    expect((await deliver(f, first)).result).toBe('failed');
    const savedPlan = first.store.entries()[0].plan;
    expect(savedPlan.operations.map((op) => op.kind)).toEqual(['saveTask', 'saveTask', 'release']);
    const second = f.open();
    expect(await deliver(f, second)).toMatchObject({ result: 'done', status: 'blocked' });
    expect(second.recipient.store.readTask(f.task.id)).toMatchObject({
      status: 'blocked',
      spentUsd: 7,
      dependsOn: [f.member.id],
      dependencyResults: [{ taskId: f.member.id, kind: 'merged-pr', pr: 215 }],
    });
    expect(second.recipient.store.readTask(f.member.id)).toMatchObject({ status: 'new' });
    expect(second.recipient.state().cards[1].pos).toBe('top');
    expect(second.recipient.state()).toMatchObject({ puts: 2, posts: 2, deletes: 1 });
    expect(f.open().store.entries()).toEqual([]);
    expect((await deliver(f, f.open())).result).toBe('skipped');
  });
  it.each([false, true])('delivers delay diagnosis once, invalid=%s', async (invalid) => {
    const f = fixture({
      stage: 'postmortem',
      taskOverrides: {
        categories: ['infrastructure'],
        returnTo: 'implement',
        delayAnalysis: {
          phase: 'analyzing',
          episode: 'test-delay',
          originStatus: 'implement',
          originSince: '2026-09-05T00:00:00Z',
          originAttempts: { continuations: 2, cycleFailures: 0 },
        },
      },
      reportOverrides: {
        routingVersion: 1,
        categories: ['infrastructure'],
        ...(invalid
          ? {}
          : {
              delayAnalysis: {
                cause: 'Temporary external failure',
                evidence: ['Confirmed response'],
                nextAction: 'Retry original stage',
                resolution: 'monitor',
              },
            }),
      },
    });
    const first = f.open();
    first.recipient.fail('POST', '/actions/comments', 'after');
    expect((await deliver(f, first)).result).toBe('failed');
    expect(first.store.entries()).toHaveLength(1);
    const second = f.open();
    expect((await deliver(f, second)).result).toBe(invalid ? 'failed' : 'done');
    expect(second.recipient.store.readTask(f.task.id)).toMatchObject({
      spentUsd: 7,
      status: invalid ? 'postmortem' : 'implement',
    });
    expect(second.recipient.state()).toMatchObject({ puts: 1, posts: 1 });
    expect(f.open().store.entries()).toEqual([]);
    expect((await deliver(f, f.open())).result).toBe('skipped');
  });
  it.each(['plan', 'intent', 'progress', 'acknowledge', 'cleanup'])(
    'retries local %s failure without repeating effects',
    async (point) => {
      const f = fixture();
      const first = f.open();
      const update = first.store.update;
      let failed = false;
      first.store.update = (id, changes) => {
        const hit =
          (point === 'plan' && changes.plan) ||
          (point === 'intent' && changes.progress?.at(-1)?.startsWith('intent:')) ||
          (point === 'progress' &&
            changes.progress?.length > 0 &&
            !changes.progress.at(-1).startsWith('intent:'));
        if (hit && !failed) {
          failed = true;
          throw new Error('injected local write');
        }
        return update(id, changes);
      };
      if (point === 'acknowledge')
        first.store.acknowledge = () => {
          throw new Error('injected acknowledge');
        };
      if (point === 'cleanup')
        first.io.forgetSession = () => {
          throw new Error('injected cleanup');
        };
      expect((await deliver(f, first)).result).toBe('failed');
      expect(f.open().store.entries()).toHaveLength(1);
      const second = f.open();
      expect((await deliver(f, second)).result).toBe('done');
      expect(second.recipient.state()).toMatchObject({ puts: 1, posts: 1 });
      expect(second.recipient.store.readTask(f.task.id)).toMatchObject({
        status: 'pr',
        spentUsd: 7,
        attempts: { continuations: 0 },
      });
      expect(f.open().store.entries()).toEqual([]);
      expect((await deliver(f, f.open())).result).toBe('skipped');
    },
  );
  it('retries requests and amendments without creating extra cards or comments', async () => {
    const f = fixture({ requests: true });
    const first = f.open();
    first.recipient.fail('POST', '/actions/comments', 'after');
    expect((await deliver(f, first)).result).toBe('failed');
    const second = f.open();
    expect((await deliver(f, second)).result).toBe('done');
    expect(second.recipient.state()).toMatchObject({ puts: 1, posts: 3 });
    expect(second.recipient.state().cards).toHaveLength(3);
  });
  it('retries the saved halt plan after its journal failed', async () => {
    const f = fixture({ denials: [{ tool_name: 'AskUserQuestion' }] });
    const first = f.open();
    first.recipient.fail('POST', '/actions/comments', 'after');
    expect((await deliver(f, first)).result).toBe('failed');
    const second = f.open();
    expect((await deliver(f, second)).result).toBe('done');
    expect(second.recipient.store.readTask(f.task.id).status).toBe('postmortem');
    expect(second.recipient.state()).toMatchObject({ puts: 1, posts: 1 });
  });
  it('retains an unplanned report when the task has entered a newer visit', async () => {
    const f = fixture();
    const first = f.open();
    first.io.readTask = () => ({ ...f.task, statusChangedAt: '2026-09-07T00:00:00Z' });
    expect(await deliver(f, first)).toMatchObject({
      result: 'failed',
      why: expect.stringContaining('conflicts'),
    });
    expect(first.store.entries()).toHaveLength(1);
    expect(first.recipient.state()).toMatchObject({ puts: 0, posts: 0 });
  });
});

describe('отметка о состоявшейся выкладке', () => {
  it('ставится после применения всего плана', async () => {
    const f = fixture({ stage: 'deploy', batch: true });
    const opened = f.open();
    const marks = [];
    opened.io.markDeployed = (at) => marks.push(at);
    expect((await deliver(f, opened)).result).toBe('done');
    expect(marks).toEqual([opened.io.now]);
  });

  it('упавшая выкладка срок следующего пакета не двигает', async () => {
    const f = fixture({ stage: 'deploy', batch: true, outcome: 'failed' });
    const opened = f.open();
    const marks = [];
    opened.io.markDeployed = (at) => marks.push(at);
    await deliver(f, opened);
    expect(marks).toEqual([]);
  });

  it('обычный этап отметки не ставит', async () => {
    const f = fixture();
    const opened = f.open();
    const marks = [];
    opened.io.markDeployed = (at) => marks.push(at);
    expect((await deliver(f, opened)).result).toBe('done');
    expect(marks).toEqual([]);
  });
});

describe('durable consolidation', () => {
  it('retains requirements and closes source once after lost delivery acknowledgement', async () => {
    const f = fixture({
      stage: 'triage',
      taskOverrides: { type: 'note' },
      memberOverrides: {
        status: 'candidate',
        description: 'Distinct acceptance criterion',
        links: {},
      },
      reportOverrides: {
        links: {},
        consolidations: [
          {
            sourceId: '0002-member',
            targetId: '0003-target',
            mode: 'absorb',
            evidence: 'Same diagnosed defect',
            coverage: 'Preserve the distinct acceptance criterion',
          },
        ],
      },
    });
    const first = f.open();
    await first.recipient.store.createTask({
      ...f.member,
      id: '0003-target',
      description: 'Original target',
      status: 'candidate',
    });
    const open = () => {
      const r = f.open();
      r.io.tokenActionBlocked = () => false;
      r.io.registryEntry = () => null;
      return r;
    };
    const delivery = open();
    delivery.recipient.fail('PUT', 'cards', 'after');
    expect((await deliver(f, delivery)).result).toBe('failed');
    const resumed = open();
    expect((await deliver(f, resumed)).result).toBe('done');
    const target = resumed.recipient.store.readTask('0003-target');
    expect(target.description.split('Distinct acceptance criterion')).toHaveLength(2);
    expect(resumed.recipient.store.readTask('0002-member')).toMatchObject({
      status: 'closed',
      splitInto: ['0003-target'],
    });
    expect((await deliver(f, open())).result).toBe('skipped');
  });
});
