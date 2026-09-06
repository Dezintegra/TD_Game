import { readFileSync, writeFileSync } from 'node:fs';
import { resolveConfig } from '../../config/defaults.mjs';
import { createTrelloBacklog } from '../backlog-trello.mjs';
import { joinDescription, metaOf } from '../card.mjs';

export const { config: receiptConfig } = resolveConfig({ trello: { board: 'test-board' } });
const clone = (value) => JSON.parse(JSON.stringify(value));

export function seedRecipient(path, tasks) {
  const config = receiptConfig;
  const state = {
    lists: Object.entries(config.trello.lists).map(([status, name]) => ({
      id: `list-${status}`,
      name,
      closed: false,
    })),
    labels: Object.entries(config.trello.labels).map(([key, label]) => ({
      id: `label-${key}`,
      ...label,
    })),
    cards: tasks.map((task, index) => ({
      id: `66000000000000000000000${index}`,
      name: task.title,
      desc: joinDescription(task.description ?? '', metaOf(task)),
      idList: `list-${task.status}`,
      idLabels: [`label-${task.type}`],
      pos: 10,
      closed: false,
    })),
    comments: [],
    puts: 0,
    posts: 0,
  };
  writeFileSync(path, JSON.stringify(state));
}

/** Каждый экземпляр читает получателя с диска: кеш старого адаптера недоступен. */
export function openRecipient(path, config = receiptConfig) {
  const state = JSON.parse(readFileSync(path, 'utf8'));
  let fault = null;
  const calls = [];
  const failed = { ok: false, kind: 'offline', why: 'injected recipient failure' };
  function request(method, route, data = {}) {
    calls.push({ method, route, data });
    const hit = fault && fault.method === method && route.includes(fault.route);
    if (hit && fault.when === 'before') {
      fault = null;
      return failed;
    }
    let result;
    const cardId = route.split('/')[1];
    const card = state.cards.find((item) => item.id === cardId);
    if (method === 'GET' && route.startsWith('boards/')) result = state.cards;
    else if (method === 'GET' && route.endsWith('/actions')) {
      let all = state.comments.filter((item) => item.cardId === cardId).toReversed();
      if (data.before) all = all.slice(all.findIndex((item) => item.id === data.before) + 1);
      result = all
        .slice(0, data.limit ?? 1000)
        .map((item) => ({ ...item, data: { text: item.text } }));
    } else if (method === 'GET') result = card;
    else if (method === 'PUT' && card) {
      Object.assign(card, data);
      state.puts += 1;
      result = card;
    } else if (method === 'POST' && route === 'cards') {
      result = {
        id: `6600000000000000${String(state.cards.length).padStart(8, '0')}`,
        pos: 10,
        closed: false,
        ...data,
      };
      state.cards.push(result);
      state.posts += 1;
    } else if (method === 'POST' && card && route.endsWith('/actions/comments')) {
      result = {
        id: `comment-${state.comments.length}`,
        cardId,
        date: '2026-09-06T00:00:00Z',
        text: data.text,
      };
      state.comments.push(result);
      state.posts += 1;
    } else throw new Error(`unsupported test request ${method} ${route}`);
    if (method !== 'GET') writeFileSync(path, JSON.stringify(state));
    if (hit) {
      fault = null;
      return failed;
    }
    return { ok: true, data: clone(result) };
  }
  const trello = {
    get: (route, data) => request('GET', route, data),
    put: (route, data) => request('PUT', route, data),
    post: (route, data) => request('POST', route, data),
  };
  return {
    store: createTrelloBacklog({ trello, config, snapshot: clone(state) }),
    trello,
    calls,
    state: () => clone(state),
    fail: (method, route, when = 'before') => {
      fault = { method, route, when };
    },
  };
}
