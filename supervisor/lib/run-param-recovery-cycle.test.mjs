import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createTrelloBacklog } from './backlog-trello.mjs';
import { joinDescription, labelKeysOf, metaOf } from './card.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import {
  recoverRunParams,
  afterRunParamRecovery,
  paramsFromPrompt,
  runParamRecoveries,
} from './run-param-recovery.mjs';
import { createAssignmentPreparer } from './benchmark-source.mjs';
import { createSupervisor } from './supervisor.mjs';
import { scan } from './scan.mjs';
import { execute } from './execute.mjs';

const recipe = runParamRecoveries[0];
const { config } = resolveConfig({
  provider: 'claude',
  trello: { board: 'test' },
  commands: { verify: 'x', deploy: 'x', perf: 'x' },
});
const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
  const source = {
    id: recipe.sourceTaskId,
    type: 'feature',
    title: 'Исходная задача',
    status: 'blocked',
    description: 'Не переписывать',
    dependsOn: [recipe.targetTaskId],
    categories: ['infrastructure'],
  };
  const target = {
    id: recipe.targetTaskId,
    type: 'run',
    title: 'Заказ',
    status: 'failed',
    description: 'Человеческий текст\n\n## Ожидаемый результат\n\nСравнить пары',
    categories: ['infrastructure'],
    run: { kind: 'arena', expectation: 'Сравнить пары' },
    owner: 'test-machine',
    returnTo: 'benchmark',
    recovery: { causedBy: null, fixedBy: ['other-fix'], returns: 1 },
    attempts: { continuations: 3 },
    links: { related: [recipe.sourceTaskId], run: null },
  };
  const cards = [target, source].map((task, i) => ({
    id: `card-${i}`,
    name: task.title,
    closed: false,
    idList: task.status,
    idLabels: labelKeysOf(task),
    desc: joinDescription(task.description, metaOf(task)),
  }));
  const comments = [];
  const state = { fail: null, lost: null, writes: 0, posts: 0 };
  const trello = {
    async get(path) {
      if (state.fail === 'get') return { ok: false, why: 'get failed' };
      if (path.endsWith('/actions'))
        return {
          ok: true,
          data: comments
            .filter((c) => c.cardId === path.split('/')[1])
            .map((c) => ({ data: { text: c.text } })),
        };
      return { ok: true, data: clone(cards.find((c) => c.id === path.split('/')[1])) };
    },
    async put(path, body) {
      state.writes++;
      if (state.fail === 'put') return { ok: false, why: 'put failed' };
      Object.assign(
        cards.find((c) => c.id === path.split('/')[1]),
        clone(body),
      );
      return state.lost === 'put' ? { ok: false, why: 'lost put response' } : { ok: true };
    },
    async post(path, body) {
      state.posts++;
      if (state.fail === 'post') return { ok: false, why: 'post failed' };
      comments.push({ cardId: path.split('/')[1], text: body.text, date: '2026-09-09T00:00:00Z' });
      return state.lost === 'post' ? { ok: false, why: 'lost post response' } : { ok: true };
    },
  };
  const fresh = () => {
    const snapshot = {
      ok: true,
      cards: clone(cards),
      comments: clone(comments),
      lists: Object.entries(config.trello.lists).map(([id, name]) => ({ id, name })),
      labels: Object.entries(config.trello.labels).map(([id, label]) => ({ id, ...label })),
    };
    const store = createTrelloBacklog({ trello, config, snapshot, machine: 'test-machine' });
    return {
      store,
      snapshot,
      mayWrite: true,
      ownsCycle: true,
      machine: 'test-machine',
      maxAutoReturns: 2,
      now: '2026-09-09T00:00:00Z',
    };
  };
  const change = (fn) => {
    const task = fresh().store.readTask(recipe.targetTaskId);
    fn(task);
    cards[0].desc = joinDescription(task.description, metaOf(task));
    cards[0].idList = task.status;
  };
  return { cards, comments, state, fresh, change };
}

function cycleFixture() {
  const f = fixture();
  const fix = {
    id: recipe.fixedByTaskId,
    type: 'feature',
    title: 'Исправление',
    status: 'implement',
    categories: ['infrastructure'],
  };
  f.cards.push({
    id: 'fix',
    name: fix.title,
    closed: false,
    idList: fix.status,
    idLabels: labelKeysOf(fix),
    desc: joinDescription('', metaOf(fix)),
  });
  f.change((t) => {
    t.recovery.fixedBy = [];
  });
  const children = [];
  const forgotten = vi.fn();
  const runtime = createSupervisor({
    config,
    root: '.',
    home: fileURLToPath(new URL('..', import.meta.url)),
    prepareAssignment: createAssignmentPreparer('.', config),
    spawn: () => {
      const child = new EventEmitter();
      child.pid = 4242;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdin.end = (text) => {
        child.prompt = text;
      };
      children.push(child);
      return child;
    },
    killTree: vi.fn(),
  });
  const cycle = async (over = {}) => {
    const context = f.fresh();
    const recovery = await recoverRunParams({
      ...context,
      running: runtime.running(),
      reports: runtime.reports,
      ...over,
    });
    const tasks = context.store.parsedCards().map((item) => item.task);
    const planned = scan({
      config,
      machine: 'test-machine',
      tasks,
      running: runtime.running(),
      reports: runtime.reports,
    });
    const actions = afterRunParamRecovery(planned.actions, recovery.deferred).filter(
      (a) => a.taskId === recipe.targetTaskId,
    );
    const results = await execute(actions, {
      ...context.store,
      now: context.now,
      maxAutoReturns: 2,
      registryEntry: () => null,
      readExternal: () => ({ state: 'pending', why: 'прогон ещё не запущен' }),
      boardDigest: () => tasks,
      lastSession: () => null,
      forgetSession: forgotten,
      spawnStage: (a) => runtime.spawnStage(a),
    });
    return { recovery, actions, results };
  };
  return {
    ...f,
    cycle,
    children,
    forgotten,
    runtime,
    completeFix: () => {
      f.cards[2].idList = 'completed';
    },
  };
}

describe('цикл восстановления до штатного назначения', () => {
  it('новые снимки, ожидание 0310, returnTask и настоящий промпт без измерения', async () => {
    const f = cycleFixture();
    const source = clone(f.cards[1]);
    expect((await f.cycle()).actions).toEqual([]);
    expect((await f.cycle()).actions).toEqual([]);
    expect((await f.cycle()).actions).toEqual([]);
    expect(f.children).toHaveLength(0);
    f.completeFix();
    const returned = await f.cycle();
    expect(returned.actions.map((a) => a.kind)).toEqual(['return-task']);
    expect(returned.results[0].result).toBe('done');
    expect(f.forgotten).toHaveBeenCalledWith(recipe.targetTaskId, 'benchmark');
    expect(f.fresh().store.readTask(recipe.targetTaskId)).toMatchObject({
      status: 'benchmark',
      recovery: { causedBy: null, returns: 2, fixedBy: [] },
    });
    const launched = await f.cycle();
    expect(
      launched.results.some((item) => item.result === 'done'),
      JSON.stringify(launched.results),
    ).toBe(true);
    expect(f.children).toHaveLength(1);
    expect(paramsFromPrompt(f.children[0].prompt)).toEqual(recipe.params);
    expect(f.children[0].prompt).toContain('run.params сверены при подготовке benchmark');
    const count = f.state.writes;
    await f.cycle();
    expect(f.children).toHaveLength(1);
    expect(f.state.writes).toBe(count);
    expect(f.cards[1]).toEqual(source);
  });
  it('ошибка нового чтения или комментария не открывает ранний возврат', async () => {
    const f = cycleFixture();
    await f.cycle();
    f.completeFix();
    expect((await f.cycle({ snapshot: { ok: false } })).actions).toEqual([]);
    f.state.fail = 'post';
    expect((await f.cycle()).actions).toEqual([]);
    expect(f.fresh().store.readTask(recipe.targetTaskId).recovery.causedBy).toBeNull();
    f.state.fail = null;
    await f.cycle();
    await f.cycle();
    await f.cycle();
    expect(f.children).toHaveLength(1);
    expect(paramsFromPrompt(f.children[0].prompt)).toEqual(recipe.params);
    expect(new Set(f.comments.map((c) => c.text)).size).toBe(f.comments.length);
  });
  it.each(['interpret', 'completed'])(
    'не повторяет уже завершённый benchmark в %s',
    async (status) => {
      const f = cycleFixture();
      f.change((t) => {
        t.status = status;
        t.links.run = '12345';
      });
      const before = clone(f.cards);
      const context = f.fresh();
      expect((await recoverRunParams(context)).deferred.size).toBe(0);
      expect(f.cards).toEqual(before);
      expect(f.state.writes).toBe(0);
      expect(f.children).toHaveLength(0);
    },
  );
  it('блокирует изменённый заказ при реальном допуске, сохраняя готовый отчёт', async () => {
    const f = cycleFixture();
    await f.cycle();
    await f.cycle();
    f.completeFix();
    await f.cycle();
    f.change((t) => {
      t.run.params.profilePairs.reverse();
    });
    const input = {
      taskId: recipe.targetTaskId,
      stage: 'benchmark',
      task: f.fresh().store.readTask(recipe.targetTaskId),
    };
    expect(f.runtime.spawnStage(input)).toMatchObject({
      ok: false,
      why: expect.stringContaining('run.params'),
    });
    expect(f.children).toHaveLength(0);
    const transfer = { kind: 'transfer-report', taskId: recipe.targetTaskId };
    expect(
      afterRunParamRecovery(
        [transfer, { kind: 'continue-stage', taskId: recipe.targetTaskId }],
        new Set([recipe.targetTaskId]),
      ),
    ).toEqual([transfer]);
  });
  it('entrypoint использует снимок владельца и откладывает действия и починку', () => {
    const code = readFileSync(new URL('../bin/supervise.mjs', import.meta.url), 'utf8');
    expect(code).toContain('snapshot: board');
    expect(code).toMatch(/ownsCycle:\s*readLock\(\)\?\.pid === process\.pid/);
    expect(code).toContain('afterRunParamRecovery(result.actions, runRecovery.deferred)');
    expect(code).toContain('!runRecovery.deferred.has(repair.taskId)');
    expect(code.indexOf('await recoverRunParams')).toBeLessThan(
      code.indexOf('const result = runCycle'),
    );
  });
});
