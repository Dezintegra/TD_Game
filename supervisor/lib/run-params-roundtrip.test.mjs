import { describe, expect, it } from 'vitest';
import { createTrelloBacklog } from './backlog-trello.mjs';
import { joinDescription, splitDescription } from './card.mjs';
import { taskFromRequest } from './requests.mjs';
import { stagePrompt } from './stage-prompt.mjs';
import { resolveConfig } from '../config/defaults.mjs';

const { config } = resolveConfig({ trello: { board: 'test' } });
const arena = {
  ref: 'b08fd3b648db710725e8751d8bdaf4f41fc0597f',
  matches: 20,
  seed: 1,
  seconds: 1200,
  tuning_args: '',
  profilePairs: [
    ['baseline-2026-08', 'wall-light-2026-08'],
    ['wall-light-2026-08', 'baseline-2026-08'],
    ['baseline-2026-08', 'combined-2026-08'],
    ['combined-2026-08', 'baseline-2026-08'],
    ['baseline-2026-08', 'economy-2026-08'],
    ['economy-2026-08', 'baseline-2026-08'],
  ],
};

async function roundtrip(kind, params, defect) {
  let raw;
  const trello = {
    post: async (path, body) => {
      if (path === 'cards') raw = { id: 'abcdef123456', closed: false, ...body };
      return { ok: true, data: { id: 'abcdef123456' } };
    },
    put: async (_path, body) => {
      raw = { ...raw, ...body };
      return { ok: true };
    },
  };
  const fresh = () => {
    if (raw && defect === 'metaOf') {
      const { human, meta } = splitDescription(raw.desc);
      delete meta.run;
      raw.desc = joinDescription(human, meta);
    }
    const store = createTrelloBacklog({
      trello,
      config,
      snapshot: {
        lists: Object.entries(config.trello.lists).map(([id, name]) => ({ id, name })),
        labels: Object.entries(config.trello.labels).map(([id, label]) => ({ id, ...label })),
        cards: raw ? [JSON.parse(JSON.stringify(raw))] : [],
        comments: [],
      },
    });
    if (defect === 'parseCard' && raw) delete store.readTask('0308-test').run.params;
    return store;
  };
  const { task, problems } = taskFromRequest(
    {
      type: 'run',
      title: 'Заказ',
      description: 'Расстановки',
      categories: ['infrastructure'],
      run: { kind, params, expectation: 'Исходное ожидание' },
    },
    { id: '0308-test', now: '2026-09-09T00:00:00Z' },
  );
  expect(problems).toEqual([]);
  expect((await fresh().createTask(task)).ok).toBe(true);
  const next = fresh();
  const loaded = next.readTask(task.id);
  expect(
    (
      await next.saveTask(
        {
          ...loaded,
          owner: 'test-machine',
          attempts: { continuations: 2 },
          links: { ...loaded.links, pr: 7 },
        },
        { from: 'new', to: 'new', what: 'Служебная запись', source: 'supervisor' },
      )
    ).ok,
  ).toBe(true);
  // Машинные копии не должны вытеснять человеческое ожидание и метку.
  const { meta } = splitDescription(raw.desc);
  meta.run = { ...meta.run, kind: 'obsolete', expectation: 'obsolete' };
  raw.desc = joinDescription('Расстановки\n\n## Ожидаемый результат\n\nНовое ожидание', meta);
  const reread = fresh().readTask(task.id);
  expect(reread.owner).toBe('test-machine');
  expect(reread.attempts.continuations).toBe(2);
  expect(reread.links.pr).toBe(7);
  const prompt = stagePrompt({ assignment: { taskId: task.id, stage: 'benchmark' }, task: reread });
  return JSON.parse(prompt.split('## Задача\n\n```json\n')[1].split('\n```')[0]).run;
}

const assertOrder = (run, kind, params) => {
  expect(run).toEqual({ kind, expectation: 'Новое ожидание', params });
};

describe('заказ через сериализованные карточки до настоящего промпта', () => {
  it('сохраняет весь заказ 0308 после двух новых экземпляров и служебной записи', async () => {
    assertOrder(await roundtrip('arena', arena), 'arena', arena);
  });
  it.each(['perf', 'bench-tick'])('сохраняет оба селектора %s', async (kind) => {
    for (const source of [{ branch: 'worktree-0031-test' }, { worktree: 'C:/repo/tree' }]) {
      const params = { source, frames: 120, nested: [null, true, { text: '-->', empty: '' }] };
      assertOrder(await roundtrip(kind, params), kind, params);
    }
  });
  it.each(['metaOf', 'parseCard'])('та же проверка выявляет прежний дефект %s', async (defect) => {
    const run = await roundtrip('arena', arena, defect);
    expect(() => assertOrder(run, 'arena', arena)).toThrow();
  });
});
