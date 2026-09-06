import { createTrelloBacklog } from './backlog-trello.mjs';
import { joinDescription } from './card.mjs';
import { resolveConfig } from '../config/defaults.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Независимые снимки поверх одного подставного сервера ловят гонки между станциями. */
export function dependencyFixture() {
  const { config } = resolveConfig({ trello: { board: 'b' } });
  const calls = [];
  const cards = [
    {
      id: 'card-target',
      idBoard: 'b',
      name: '0003-consumer · Consumer',
      idList: 'list-new',
      idLabels: ['label-feature'],
      idMembers: [],
      pos: 100,
      closed: false,
      desc: joinDescription('Текст человека.\n\nЕщё абзац.', {
        id: '0003-consumer',
        owner: null,
        returnTo: null,
        statusChangedAt: '2026-09-01T00:00:00.000Z',
        links: { pr: null },
        attempts: { continuations: 0, cycleFailures: 0 },
        extra: { nested: ['не терять'] },
      }),
    },
  ];
  const state = { calls, cards, hook: null };
  async function request(method, path, body) {
    calls.push({ method, path, body: clone(body ?? {}) });
    const override = await state.hook?.(method, path, body);
    if (override) return override;
    if (path === 'members/me') return { ok: true, data: { id: 'me' } };
    if (path === 'boards/b/cards') return { ok: true, data: clone(cards) };
    const raw = cards.find(
      (item) => path === `cards/${item.id}` || path.startsWith(`cards/${item.id}/`),
    );
    if (!raw) return { ok: false, why: 'missing' };
    if (method === 'GET') return { ok: true, data: clone(raw) };
    if (method === 'POST' && path.endsWith('/idMembers')) {
      if (raw.idMembers.includes(body.value))
        return { ok: false, why: 'member is already on the card' };
      raw.idMembers.push(body.value);
    }
    if (method === 'DELETE') raw.idMembers = raw.idMembers.filter((id) => !path.endsWith(`/${id}`));
    if (method === 'PUT') Object.assign(raw, clone(body));
    return { ok: true, data: clone(raw) };
  }
  const trello = Object.fromEntries(
    ['get', 'post', 'put', 'delete'].map((method) => [
      method,
      (path, body) => request(method.toUpperCase(), path, body),
    ]),
  );
  state.store = (machine = 'A') =>
    createTrelloBacklog({
      trello,
      config,
      machine,
      snapshot: {
        cards: clone(cards),
        comments: [],
        lists: Object.entries(config.trello.lists).map(([key, name]) => ({
          id: `list-${key}`,
          name,
          closed: false,
        })),
        labels: Object.entries(config.trello.labels).map(([key, label]) => ({
          id: `label-${key}`,
          ...label,
        })),
      },
    });
  state.update = {
    taskId: '0003-consumer',
    dependsOn: ['0002-producer'],
    dependencyResults: [{ taskId: '0002-producer', kind: 'merged-pr', pr: 42 }],
    reason: 'Поручено задачей',
  };
  state.invalidated = [];
  state.context = {
    sourceId: '0001-source',
    invalidate: (id) => {
      state.invalidated.push(id);
      calls.push({ method: 'INVALIDATE', path: id });
    },
  };
  return state;
}
