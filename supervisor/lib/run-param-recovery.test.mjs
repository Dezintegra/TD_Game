import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTrelloBacklog } from './backlog-trello.mjs';
import { joinDescription, labelKeysOf, metaOf } from './card.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { hasReceipt } from './report-receipts.mjs';
import { recoverRunParams, recoveryKey, runParamRecoveries } from './run-param-recovery.mjs';

const recipe = runParamRecoveries[0];
const { config } = resolveConfig({ trello: { board: 'test' } });
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
  const state = { fail: null, lost: null, writes: 0, posts: 0, failWriteAt: 0, failPostAt: 0 };
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
      if (state.fail === 'put' || state.writes === state.failWriteAt)
        return { ok: false, why: 'put failed' };
      Object.assign(
        cards.find((c) => c.id === path.split('/')[1]),
        clone(body),
      );
      return state.lost === 'put' ? { ok: false, why: 'lost put response' } : { ok: true };
    },
    async post(path, body) {
      state.posts++;
      if (state.fail === 'post' || state.posts === state.failPostAt)
        return { ok: false, why: 'post failed' };
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

describe('адресное восстановление', () => {
  it.each([1, 2, 3])('повторяет сбой записи/комментария части %s', async (part) => {
    for (const field of ['failWriteAt', 'failPostAt']) {
      const f = fixture();
      f.state[field] = part;
      await recoverRunParams(f.fresh());
      const second = await recoverRunParams(f.fresh());
      if (part > 1) expect(second.deferred.has(recipe.targetTaskId)).toBe(true);
      f.state[field] = 0;
      for (let i = 0; i < 3; i++) await recoverRunParams(f.fresh());
      expect(
        hasReceipt(f.fresh().store.readTask(recipe.targetTaskId), recoveryKey(recipe, 'ready')),
      ).toBe(true);
      expect(new Set(f.comments.map((c) => c.text)).size).toBe(f.comments.length);
    }
  });
  it('рецепт точно совпадает с проверенной выдержкой design 0095', () => {
    const design = readFileSync(
      new URL('../../openspec/changes/preserve-run-params/design.md', import.meta.url),
      'utf8',
    );
    const params = JSON.parse(design.match(/```json\n([\s\S]*?)\n```/)[1]);
    expect(recipe.params).toEqual(params);
    expect(recipe).toMatchObject({
      sourceStage: 'design',
      launchId: '3f106aea-07c1-4e67-a4f8-17c496a49bd7',
      requestKey: 'screen-reference-pairs',
    });
  });
  it('сначала пишет, затем подтверждает новым снимком, сохраняя все связи', async () => {
    const f = fixture();
    const sourceBefore = clone(f.cards[1]);
    const before = f.fresh().store.readTask(recipe.targetTaskId);
    const first = await recoverRunParams(f.fresh());
    expect(first.deferred.has(recipe.targetTaskId)).toBe(true);
    const written = f.fresh().store.readTask(recipe.targetTaskId);
    expect(written.run.params).toEqual(recipe.params);
    expect(written.recovery).toEqual(before.recovery);
    expect(hasReceipt(written, recoveryKey(recipe, 'ready'))).toBe(false);
    expect((await recoverRunParams(f.fresh())).notes).toEqual([]);
    const ready = f.fresh().store.readTask(recipe.targetTaskId);
    expect(ready).toMatchObject({
      status: 'failed',
      returnTo: 'benchmark',
      attempts: before.attempts,
      recovery: { causedBy: 'pipeline', fixedBy: ['other-fix', recipe.fixedByTaskId], returns: 1 },
    });
    expect(ready.description).toBe(before.description);
    expect(ready.links).toEqual(before.links);
    expect(hasReceipt(ready, recoveryKey(recipe, 'ready'))).toBe(true);
    expect(f.comments.map((c) => c.text).join('\n')).toContain(
      JSON.stringify(recipe.params, null, 2),
    );
    const count = f.comments.length;
    expect((await recoverRunParams(f.fresh())).deferred.size).toBe(0);
    expect(f.comments).toHaveLength(count);
    expect(f.cards[1]).toEqual(sourceBefore);
  });
  it.each(['get', 'put', 'post', 'lost-put', 'lost-post'])(
    'восстанавливается после %s без дубликата',
    async (failure) => {
      for (const afterWrite of [false, true]) {
        const f = fixture();
        if (afterWrite) await recoverRunParams(f.fresh());
        if (failure.startsWith('lost-')) f.state.lost = failure.slice(5);
        else f.state.fail = failure;
        expect((await recoverRunParams(f.fresh())).notes.join(' ')).toContain(
          failure.startsWith('lost-') ? `lost ${failure.slice(5)} response` : `${failure} failed`,
        );
        f.state.fail = f.state.lost = null;
        for (let cycle = 0; cycle < 3; cycle++) await recoverRunParams(f.fresh());
        const task = f.fresh().store.readTask(recipe.targetTaskId);
        expect(task.run.params).toEqual(recipe.params);
        expect(hasReceipt(task, recoveryKey(recipe, 'ready'))).toBe(true);
        expect(new Set(f.comments.map((c) => c.text)).size).toBe(f.comments.length);
        expect(f.cards).toHaveLength(2);
      }
    },
  );
  it.each([
    { mayWrite: false },
    { ownsCycle: false },
    { snapshot: { ok: false } },
    { running: [{ taskId: recipe.targetTaskId }] },
    { reports: [{ taskId: recipe.targetTaskId }] },
    { running: [{ taskId: 'batch', batch: [recipe.targetTaskId] }] },
  ])('отказывает до записи при %j', async (over) => {
    const f = fixture();
    expect(
      (await recoverRunParams({ ...f.fresh(), ...over })).deferred.has(recipe.targetTaskId),
    ).toBe(true);
    expect(f.state.writes).toBe(0);
    expect(f.state.posts).toBe(0);
  });
  it.each([
    (t) => {
      t.owner = 'foreign';
    },
    (t) => {
      t.run.params = { matches: 1 };
    },
    (t) => {
      t.returnTo = 'design';
    },
    (t) => {
      t.recovery.returns = 2;
    },
    (t) => {
      t.links.related = [];
    },
    (t) => {
      t.run.params = null;
    },
  ])('не затирает конфликтующее состояние #%#', async (change) => {
    const f = fixture();
    f.change(change);
    const before = clone(f.cards);
    expect((await recoverRunParams(f.fresh())).notes.length).toBeGreaterThan(0);
    expect(f.cards).toEqual(before);
    expect(f.state.writes).toBe(0);
  });
  it('не выбирает одну из двух карточек и не подтверждает испорченный промпт', async () => {
    const f = fixture();
    f.cards.push({ ...f.cards[0], id: 'duplicate' });
    expect((await recoverRunParams(f.fresh())).notes.join(' ')).toContain('неоднозначен');
    expect(f.state.writes).toBe(0);
    f.cards.pop();
    await recoverRunParams(f.fresh());
    const makePrompt = vi.fn(() => '## Задача\n\n```json\n{"run":{}}\n```');
    expect((await recoverRunParams({ ...f.fresh(), makePrompt })).notes.join(' ')).toContain(
      'промпт',
    );
    expect(makePrompt).toHaveBeenCalledOnce();
    expect(
      hasReceipt(f.fresh().store.readTask(recipe.targetTaskId), recoveryKey(recipe, 'ready')),
    ).toBe(false);
  });
  it('не вооружает новый возврат после уже выполненного возврата', async () => {
    const f = fixture();
    await recoverRunParams(f.fresh());
    await recoverRunParams(f.fresh());
    f.change((t) => {
      t.recovery = { causedBy: null, fixedBy: [], returns: 2 };
    });
    const count = f.state.writes;
    expect((await recoverRunParams(f.fresh())).notes).toEqual([]);
    expect(f.state.writes).toBe(count);
  });
});
