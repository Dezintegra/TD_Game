import { expect, it } from 'vitest';
import { execute } from './execute.mjs';
import { createTrelloBacklog } from './backlog-trello.mjs';
import { joinDescription, metaOf } from './card.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { scan } from './scan.mjs';
import { judgeSelfUpdate } from './self-update.mjs';

const now = '2026-09-08T09:00:00.000Z';
const { config } = resolveConfig({ trello: { board: 'board' } });
const source = {
  id: '0027-silent-nuke',
  type: 'note',
  title: 'Нет диагностики',
  status: 'triage',
  owner: 'station',
  createdAt: now,
  statusChangedAt: now,
  categories: ['infrastructure'],
  links: { change: 'silent-nuke', pr: 117 },
  attempts: { continuations: 1, rejections: 0 },
  spentUsd: 7,
};
const report = {
  taskId: source.id,
  stage: 'triage',
  outcome: 'blocked',
  routingVersion: 1,
  categories: ['infrastructure'],
  summary: 'Нужен результат 0030',
  decisions: ['Проверен незавершённый PR 117'],
  links: { pr: 117 },
  blockers: [{ taskId: '0030-diagnostics', reason: 'Нет диагностики', result: 'Влитый PR 117' }],
  requests: [],
  denials: [],
  costUsd: 2,
};

/** Настоящее хранилище поверх памяти: повтор перечитывает карточку и комментарии. */
function world({ stage = 'triage', predecessor = 'closed', value = report } = {}) {
  const tasks = [
    { ...source, status: stage },
    { ...source, id: '0030-diagnostics', status: predecessor },
  ];
  const cards = tasks.map((t, i) => ({
    id: `card-${i}`,
    name: `${t.id} · ${t.title}`,
    desc: joinDescription('Проверить отсутствие диагностики.', metaOf(t)),
    idList: `list-${t.status}`,
    idLabels: ['label-note', 'label-category-infrastructure'],
    idMembers: ['me'],
    pos: 10,
    closed: false,
  }));
  const comments = [];
  const reports = [globalThis.structuredClone(value)];
  const forgotten = [];
  const w = { cards, comments, reports, forgotten, fail: null, commentAttempts: 0, transitions: 0 };
  const offline = { ok: false, kind: 'offline', why: 'offline: test' };
  const trello = {
    async get(path) {
      if (path === 'members/me') return { ok: true, data: { id: 'me' } };
      if (path.endsWith('/actions'))
        return {
          ok: true,
          data: comments.map((c) => ({ id: c.id, data: { text: c.text } })).reverse(),
        };
      return { ok: true, data: cards.find((c) => path === `cards/${c.id}`) };
    },
    async put(path, body) {
      if (w.fail === 'put') return offline;
      if (w.fail === 'clear' && !body.idList) return offline;
      if (body.desc?.length > 16384)
        return { ok: false, kind: 'refused', why: 'description too long' };
      const card = cards.find((c) => path === `cards/${c.id}`);
      if (body.idList && body.idList !== card.idList) w.transitions++;
      Object.assign(card, body);
      return { ok: true, data: {} };
    },
    async post(path, body) {
      w.commentAttempts++;
      if (w.fail === 'comment' || w.fail === w.commentAttempts) return offline;
      if (w.fail === 'transition-comment' && body.text.includes('**triage → postmortem**'))
        return offline;
      comments.push({
        id: `comment-${comments.length}`,
        cardId: path.split('/')[1],
        date: now,
        text: body.text,
      });
      return { ok: true, data: {} };
    },
    async delete() {
      if (w.fail === 'release') return offline;
      return { ok: true, data: {} };
    },
  };
  w.io = () => {
    const store = createTrelloBacklog({
      trello,
      config: { ...config, trello: { ...config.trello, maxTextLength: 650 } },
      machine: 'station',
      snapshot: {
        lists: Object.entries(config.trello.lists).map(([state, name]) => ({
          id: `list-${state}`,
          name,
          closed: false,
        })),
        labels: Object.entries(config.trello.labels).map(([key, label]) => ({
          id: `label-${key}`,
          ...label,
        })),
        cards: globalThis.structuredClone(cards),
        comments: globalThis.structuredClone(comments),
      },
    });
    return {
      ...store,
      now: '2026-09-08T10:00:00.000Z',
      readReport: () => reports[0],
      removeReport: () => reports.splice(0, 1),
      forgetSession: (id, stage) => forgotten.push({ id, stage }),
    };
  };
  w.transfer = () =>
    execute([{ kind: 'transfer-report', taskId: source.id, stage: value.stage }], w.io());
  return w;
}

it('отказ зависимости сохраняет полный отчёт, завершает очередь и разрешает самообновление', async () => {
  const w = world();
  const before = globalThis.structuredClone(w.cards[1]);
  const decision = scan({
    config,
    machine: 'station',
    now,
    tasks: w
      .io()
      .allTaskIds()
      .map((id) => w.io().readTask(id)),
    reports: w.reports,
    draining: true,
  });
  expect(decision.actions).toContainEqual(expect.objectContaining({ kind: 'transfer-report' }));
  expect(await w.transfer()).toMatchObject([{ result: 'done', status: 'postmortem' }]);
  const io = w.io();
  const saved = io.readTask(source.id);
  expect(saved).toMatchObject({ status: 'postmortem', returnTo: 'triage', spentUsd: 9 });
  expect(saved.delayJournal).toBeUndefined();
  const text = io.readJournal(source.id);
  expect(text).toContain('остановлен без результата');
  expect(JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1])).toEqual(report);
  expect(w.reports).toEqual([]);
  expect(w.cards[1]).toEqual(before);
  expect(
    judgeSelfUpdate({
      git: { treeOf: () => 'new' },
      ownDir: 'supervisor',
      loadedTree: 'old',
      pending: w.reports.length,
    }).verdict,
  ).toBe('restart');
});

it.each(['put', 'comment', 'transition-comment', 'clear', 2])(
  'сбой %s удерживает отчёт; повтор доставляет его без повторного расхода и частей',
  async (failure) => {
    const w = world();
    w.fail = failure;
    expect((await w.transfer())[0]).toMatchObject({ result: 'failed' });
    expect(w.reports).toHaveLength(1);
    expect(w.forgotten).toEqual([]);
    const delivered = w.comments.map((c) => c.text);
    w.fail = null;
    expect(await w.transfer()).toMatchObject([{ result: 'done', status: 'postmortem' }]);
    expect(w.io().readTask(source.id).spentUsd).toBe(9);
    expect(w.transitions).toBe(1);
    expect(w.reports).toEqual([]);
    for (const part of delivered) expect(w.comments.filter((c) => c.text === part)).toHaveLength(1);
    expect(w.io().readTask(source.id).delayJournal).toBeUndefined();
  },
);

it('временный сбой принятия годного отчёта не становится отказом содержания', async () => {
  const w = world({ predecessor: 'failed' });
  w.fail = 'put';
  expect((await w.transfer())[0]).toMatchObject({ result: 'failed', why: 'offline: test' });
  expect(w.io().readTask(source.id)).toMatchObject({ status: 'triage', spentUsd: 7 });
  expect(w.io().readTask(source.id).reportRejection).toBeUndefined();
  expect(w.reports).toHaveLength(1);
  w.fail = null;
  expect(await w.transfer()).toMatchObject([{ result: 'done', status: 'blocked' }]);
});

it('ошибка категорий у postmortem не запускает разбор разбора', async () => {
  const value = { ...report, stage: 'postmortem', outcome: 'done', categories: ['invalid'] };
  const w = world({ stage: 'postmortem', value });
  expect(await w.transfer()).toMatchObject([{ result: 'done', status: 'failed' }]);
  expect(w.reports).toEqual([]);
  expect(w.io().readJournal(source.id)).toContain('"categories": [');
});

it('устаревший отчёт сохраняется без отката сменившегося этапа', async () => {
  const w = world({ stage: 'design' });
  expect(await w.transfer()).toMatchObject([{ result: 'done', status: 'design' }]);
  expect(w.transitions).toBe(0);
  expect(w.io().readTask(source.id).statusChangedAt).toBe(now);
  expect(w.io().readJournal(source.id)).toContain('отчёт о другом этапе');
});

it('уже доставленный отказ не применяется повторно после перечитывания', async () => {
  const w = world();
  await w.transfer();
  const before = globalThis.structuredClone(w.cards);
  const count = w.comments.length;
  w.reports.push(globalThis.structuredClone(report));
  await w.transfer();
  expect(w.cards).toEqual(before);
  expect(w.comments).toHaveLength(count);
  expect(w.reports).toEqual([]);
});

it('большой отчёт доставляется целиком без переполнения описания карточки', async () => {
  const value = { ...report, decisions: ['Полный подробный результат. '.repeat(900)] };
  const w = world({ value });
  expect(await w.transfer()).toMatchObject([{ result: 'done', status: 'postmortem' }]);
  const text = w.io().readJournal(source.id);
  expect(JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1])).toEqual(value);
  expect(w.cards[0].desc.length).toBeLessThan(16384);
  expect(w.reports).toEqual([]);
});
