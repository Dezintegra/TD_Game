import { afterEach, describe, expect, it } from 'vitest';
import { execute } from './execute.mjs';
import { deliveryFixture } from './testing/report-delivery-fixture.mjs';

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
