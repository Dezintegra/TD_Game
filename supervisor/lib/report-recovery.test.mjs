import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createSupervisor } from './supervisor.mjs';
import { openReportStore } from './report-store.mjs';
import { scan } from './scan.mjs';
import { execute } from './execute.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { deliveryFixture } from './testing/report-delivery-fixture.mjs';
import { openRecipient, seedRecipient } from './testing/report-recipient.mjs';

const fixtures = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));
const { config } = resolveConfig({ commands: { verify: 'x', deploy: 'x', perf: 'x' } });

async function scenario(options) {
  const f = deliveryFixture(options);
  fixtures.push(f);
  openReportStore(f.queuePath).acknowledge(f.entry.reportId);
  const stagesPath = join(f.root, 'stages.json');
  writeFileSync(stagesPath, '{}');
  let launches = 0;
  let child;
  function restart() {
    const recipient = openRecipient(f.boardPath);
    const store = openReportStore(f.queuePath);
    const supervisor = createSupervisor({
      config,
      root: f.root,
      machine: 'test',
      now: () => f.now,
      nowMs: () => 1_000,
      reportStore: store,
      stages: JSON.parse(readFileSync(stagesPath, 'utf8')),
      saveStages: (value) => writeFileSync(stagesPath, JSON.stringify(value)),
      probe: () => ({ known: true, alive: false }),
      spawn: () => {
        launches += 1;
        child = new EventEmitter();
        child.pid = 1234;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        return child;
      },
    });
    const io = {
      ...recipient.store,
      now: f.now,
      reportStore: store,
      forgetSession: supervisor.forgetSession,
    };
    const actions = (paused = false) =>
      scan({
        config,
        tasks: [recipient.store.readTask(f.task.id)],
        reports: supervisor.reports,
        running: [],
        orphans: supervisor.orphanOutcomes,
        paused,
      }).actions;
    return { recipient, store, supervisor, io, actions };
  }
  const first = restart();
  expect(
    first.supervisor.spawnStage({
      taskId: f.task.id,
      stage: f.report.stage,
      task: f.task,
      path: f.root,
      branch: 'test',
      journal: '',
      board: [],
      ...(f.report.batch ? { batch: f.report.batch } : {}),
    }).ok,
  ).toBe(true);
  const staleStages = readFileSync(stagesPath, 'utf8');
  child.stdout.emit(
    'data',
    JSON.stringify({
      is_error: false,
      session_id: 'session',
      total_cost_usd: 3,
      result: JSON.stringify(f.report),
    }),
  );
  child.emit('close', 0);
  await sleep(0);
  expect(first.actions(true)).toEqual([]);
  expect(first.store.entries()).toHaveLength(1);
  expect(first.recipient.state()).toMatchObject({ puts: 0, posts: 0 });
  // Model a crash after the queue rename but before the live descriptor update.
  writeFileSync(stagesPath, staleStages);
  const next = restart();
  expect(next.supervisor.orphanOutcomes).toEqual([]);
  expect(next.actions(true)).toEqual([]);
  expect(next.recipient.store.readTask(f.task.id).attempts.continuations).toBe(2);
  const pending = next.actions();
  expect(pending).toHaveLength(1);
  expect(pending[0].kind).toBe('transfer-report');
  const action = pending[0];
  const deliver = async (opened) => (await execute([action], opened.io))[0];
  function assertSettled(opened, expected) {
    expect(opened.recipient.state()).toMatchObject(expected);
    expect(opened.store.entries()).toEqual([]);
    expect(launches).toBe(1);
    const snapshot = opened.recipient.state();
    const again = restart();
    expect(again.supervisor.reports).toEqual([]);
    expect(again.recipient.state()).toEqual(snapshot);
    expect(again.actions().some((a) => a.kind === 'transfer-report')).toBe(false);
    expect(launches).toBe(1);
  }
  return { f, next, restart, deliver, assertSettled };
}

describe('paused completion survives full supervisor and recipient restart', () => {
  it('досылает хвост перед однократным переносом сохранённого отчёта', async () => {
    const s = await scenario();
    const branch = `worktree-${s.f.task.id}`;
    const entry = { taskId: s.f.task.id, branch, path: s.f.root };
    let commits = 1;
    let pushes = 0;
    const actions = (opened, running = []) =>
      scan({
        config,
        tasks: [opened.recipient.store.readTask(s.f.task.id)],
        reports: opened.supervisor.reports,
        registry: { entries: [entry] },
        tails: { main: 0, branches: { [branch]: commits } },
        running,
      }).actions;
    const tail = {
      kind: 'push-tail',
      scope: 'branch',
      branch,
      taskId: s.f.task.id,
      commits: 1,
    };
    expect(actions(s.next)).toEqual([tail]);
    expect(
      actions(s.next, [{ taskId: s.f.task.id, stage: 'implement' }]).some(
        (action) => action.kind === 'push-tail',
      ),
    ).toBe(false);
    const attachPush = (opened, ok) => {
      opened.io.registryEntry = (id) => (id === entry.taskId ? entry : null);
      opened.io.pushBranchTail = (name, path) => {
        expect([name, path]).toEqual([branch, s.f.root]);
        pushes += 1;
        if (ok) commits = 0;
        return ok ? { ok: true } : { ok: false, why: 'push rejected' };
      };
    };
    attachPush(s.next, false);
    expect((await execute(actions(s.next), s.next.io))[0].result).toBe('failed');
    expect(s.next.store.entries()).toHaveLength(1);
    expect(s.next.recipient.state()).toMatchObject({ puts: 0, posts: 0 });

    const final = s.restart();
    expect(actions(final)).toEqual([tail]);
    attachPush(final, true);
    expect((await execute(actions(final), final.io))[0].result).toBe('done');
    const competing = ['continue-stage', 'fail-stage', 'answer-question'].map((kind) => ({
      kind,
      taskId: s.f.task.id,
      stage: 'implement',
    }));
    expect((await execute(competing, final.io)).map((result) => result.result)).toEqual([
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(final.recipient.store.readTask(s.f.task.id).attempts.continuations).toBe(2);
    expect(final.recipient.state()).toMatchObject({ puts: 0, posts: 0 });
    const pending = actions(final);
    expect(pending.map((action) => action.kind)).toEqual(['transfer-report']);
    expect((await execute(pending, final.io))[0].result).toBe('done');
    expect((await execute(pending, final.io))[0].result).toBe('skipped');
    expect(final.recipient.store.readTask(s.f.task.id)).toMatchObject({
      status: 'pr',
      spentUsd: 7,
      attempts: { continuations: 0 },
    });
    expect(pushes).toBe(2);
    s.assertSettled(final, { puts: 1, posts: 1 });
  });

  it.each(['none', 'before-put', 'after-put', 'after-comment', 'progress', 'acknowledge'])(
    'delivers once after %s failure',
    async (point) => {
      const s = await scenario();
      if (point === 'before-put') s.next.recipient.fail('PUT', 'cards/');
      if (point === 'after-put') s.next.recipient.fail('POST', '/actions/comments');
      if (point === 'after-comment') s.next.recipient.fail('POST', '/actions/comments', 'after');
      if (point === 'progress') {
        const update = s.next.store.update;
        s.next.store.update = (id, changes) => {
          if (changes.progress?.at(-1) && !changes.progress.at(-1).startsWith('intent:'))
            throw new Error('lost local progress');
          return update(id, changes);
        };
      }
      if (point === 'acknowledge')
        s.next.store.acknowledge = () => {
          throw new Error('lost ack');
        };
      const result = await s.deliver(s.next);
      expect(result.result, result.why).toBe(point === 'none' ? 'done' : 'failed');
      if (point !== 'none') expect(s.next.store.entries()).toHaveLength(1);
      const final = point === 'none' ? s.next : s.restart();
      if (point !== 'none') expect((await s.deliver(final)).result).toBe('done');
      expect(final.recipient.store.readTask(s.f.task.id)).toMatchObject({
        status: 'pr',
        spentUsd: 7,
        attempts: { continuations: 0 },
      });
      expect(final.recipient.state().comments[0].text).toContain('completed stage');
      s.assertSettled(final, { puts: 1, posts: 1 });
    },
  );

  it.each([
    [{ stage: 'audit', outcome: 'rejected' }, 'design'],
    [{ stage: 'implement', outcome: 'rejected' }, 'postmortem'],
  ])('replays rejected and invalid reports: %j', async (options, status) => {
    const s = await scenario(options);
    s.next.recipient.fail('POST', '/actions/comments', 'after');
    expect((await s.deliver(s.next)).result).toBe('failed');
    const final = s.restart();
    expect((await s.deliver(final)).result).toBe('done');
    expect(final.recipient.store.readTask(s.f.task.id).status).toBe(status);
    s.assertSettled(final, { puts: 1, posts: 1 });
  });

  it('reconciles requests and amendments with new clients', async () => {
    const s = await scenario({ requests: true });
    s.next.recipient.fail('POST', '/actions/comments', 'after');
    expect((await s.deliver(s.next)).result).toBe('failed');
    const final = s.restart();
    expect((await s.deliver(final)).result).toBe('done');
    expect(final.recipient.state().cards).toHaveLength(3);
    s.assertSettled(final, { puts: 1, posts: 3 });
  });

  it('finishes the journal of an already moved batch member before the lead', async () => {
    const s = await scenario({ stage: 'deploy', batch: true });
    s.next.recipient.fail('POST', '/actions/comments');
    expect((await s.deliver(s.next)).result).toBe('failed');
    expect(s.next.recipient.store.readTask(s.f.member.id).status).toBe('cleanup');
    expect(s.next.recipient.store.readTask(s.f.task.id).status).toBe('deploy');
    const final = s.restart();
    expect((await s.deliver(final)).result).toBe('done');
    expect(final.recipient.store.readTask(s.f.member.id)).toMatchObject({
      status: 'cleanup',
      spentUsd: 4,
    });
    expect(final.recipient.store.readTask(s.f.task.id)).toMatchObject({
      status: 'cleanup',
      spentUsd: 7,
    });
    expect(final.recipient.state().comments).toHaveLength(2);
    s.assertSettled(final, { puts: 2, posts: 2 });
  });

  it('does not apply an old report to a newer visit of the same stage', async () => {
    const s = await scenario();
    seedRecipient(s.f.boardPath, [{ ...s.f.task, statusChangedAt: '2026-09-07T00:00:00Z' }]);
    const final = s.restart();
    expect((await s.deliver(final)).result).toBe('failed');
    expect(final.store.entries()).toHaveLength(1);
    expect(final.recipient.state()).toMatchObject({ puts: 0, posts: 0 });
  });
});
