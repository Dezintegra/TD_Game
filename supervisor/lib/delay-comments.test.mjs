import { expect, it } from 'vitest';
import { createTrelloBacklog } from './backlog-trello.mjs';
import { joinDescription, metaOf, splitDescription } from './card.mjs';
import { delayEntry } from './delay-analysis.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { scan } from './scan.mjs';

const now = '2026-09-07T12:00:00Z';
const config = resolveConfig({ trello: { board: 'b', maxTextLength: 700 } }).config;
function board() {
  const source = {
    id: '0001-source',
    title: 'Задача',
    type: 'feature',
    status: 'postmortem',
    priority: 1,
    createdAt: now,
    statusChangedAt: now,
    delayAnalysis: { episode: 'implement:2026-09-07T06:00:00Z', phase: 'analyzing' },
  };
  const raw = {
    id: '6a9084b276c945372833816f',
    name: 'Задача',
    pos: 1,
    closed: false,
    desc: joinDescription('Не менять постановку', metaOf(source)),
    idList: 'postmortem',
    idLabels: ['feature'],
  };
  const comments = [];
  let postCount = 0;
  let failPart = 0;
  let failClear = false;
  let acceptThenFail = false;
  const api = {
    post: async (path, body) => {
      postCount += 1;
      if (postCount !== failPart || acceptThenFail)
        comments.push({ cardId: raw.id, text: body.text, date: now });
      return postCount === failPart ? { ok: false, kind: 'offline' } : { ok: true, data: {} };
    },
    put: async (path, body) => {
      if (failClear && !splitDescription(body.desc).meta?.delayJournal)
        return { ok: false, kind: 'offline' };
      Object.assign(raw, body);
      return { ok: true, data: {} };
    },
  };
  const restart = () =>
    createTrelloBacklog({
      trello: api,
      config,
      snapshot: {
        lists: Object.entries(config.trello.lists).map(([id, name]) => ({ id, name })),
        labels: Object.entries(config.trello.labels).map(([id, value]) => ({ id, ...value })),
        cards: [globalThis.structuredClone(raw)],
        comments: globalThis.structuredClone(comments),
      },
    });
  return {
    source,
    raw,
    comments,
    restart,
    count: () => postCount,
    fail: (part, clear = false, accepted = false) => {
      failPart = part;
      failClear = clear;
      acceptThenFail = accepted;
    },
  };
}

it('восстанавливает видимый комментарий после PUT без повторной диагностики', async () => {
  const state = board();
  state.fail(1);
  const store = state.restart();
  const entry = delayEntry(state.source, 'Причина: отказ разрешения. Следующий шаг: исправление.', {
    at: now,
  });
  expect((await store.saveTask(state.source, entry)).ok).toBe(false);
  const restarted = state.restart();
  const task = restarted.readTask(state.source.id);
  expect(task.delayJournal.entry.deliveryKey).toBe(entry.deliveryKey);
  expect(
    scan({
      now,
      config,
      tasks: [task],
      reports: [{ taskId: task.id, stage: 'postmortem' }],
    }).actions.map((a) => a.kind),
  ).toEqual(['flush-delay-journal']);
  state.fail(0);
  expect((await restarted.flushDelayJournal(task)).ok).toBe(true);
  expect(state.comments).toHaveLength(1);
  expect(state.comments[0].text).toContain('Причина: отказ разрешения');
  expect(state.restart().readTask(task.id).delayJournal).toBeUndefined();
  expect(splitDescription(state.raw.desc).human).toBe('Не менять постановку');
});

it('не повторяет опубликованный комментарий, если оборвалось подтверждение POST или снятие конверта', async () => {
  for (const accepted of [false, true]) {
    const state = board();
    state.fail(accepted ? 1 : 0, !accepted, accepted);
    const entry = delayEntry(state.source, 'Причина и проверяемый следующий шаг.', { at: now });
    expect((await state.restart().saveTask(state.source, entry)).ok).toBe(false);
    expect(state.comments).toHaveLength(1);
    state.fail(0);
    const store = state.restart();
    expect((await store.flushDelayJournal(store.readTask(state.source.id))).ok).toBe(true);
    expect(state.comments).toHaveLength(1);
    expect(state.count()).toBe(1);
  }
});

it('после частичной публикации доставляет только недостающие части разбора', async () => {
  const state = board();
  state.fail(2);
  const entry = delayEntry(state.source, 'Подробный факт с доказательством.\n'.repeat(80), {
    at: now,
  });
  expect((await state.restart().saveTask(state.source, entry)).ok).toBe(false);
  expect(state.comments).toHaveLength(1);
  state.fail(0);
  const store = state.restart();
  const pending = store.readTask(state.source.id);
  expect(pending.delayJournal.parts.length).toBeGreaterThan(2);
  expect((await store.flushDelayJournal(pending)).ok).toBe(true);
  expect(state.comments.map((c) => c.text)).toEqual(pending.delayJournal.parts);
  expect(new Set(state.comments.map((c) => c.text)).size).toBe(state.comments.length);
});
