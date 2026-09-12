import { recoverTokenLaunch, tokenAccountingNote } from './token-budget.mjs';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/defaults.mjs';
import { scan } from './scan.mjs';
import { execute } from './execute.mjs';
import { tokenAdmission } from './token-hold.mjs';
import { createTrelloBacklog } from './backlog-trello.mjs';
import { joinDescription, metaOf } from './card.mjs';

const now = '2026-09-07T10:00:00Z';
const config = {
  ...resolveConfig({
    commands: { verify: 'x', deploy: 'x', perf: 'x' },
    worktreeDir: '.claude/worktrees',
  }).config,
  provider: 'codex',
  codexMaxTaskTokens: 100,
  maxConcurrent: 1,
};
const task = (over = {}) => ({
  id: '0001-one',
  type: 'feature',
  status: 'implement',
  title: 'Работа',
  description: 'Текст владельца',
  returnTo: null,
  priority: 42,
  owner: 'station',
  createdAt: now,
  statusChangedAt: now,
  attempts: { continuations: 1, rejections: 2 },
  links: { pr: 205 },
  ...over,
});
const ledger = (spent = 100, reasons = []) => ({
  version: 2,
  tasks: {
    '0001-one': {
      sessions: {
        s: { knownTokens: spent, snapshot: { input_tokens: spent, output_tokens: 0 }, reasons },
      },
      launches: {},
    },
  },
});
function world(over = {}) {
  const state = {
    config,
    now,
    machine: 'station',
    tasks: [task()],
    codexUsage: ledger(),
    registry: { entries: [{ taskId: '0001-one', branch: 'worktree-0001-one', path: 'tree' }] },
    ...over,
  };
  const saved = [];
  const io = {
    now,
    machine: 'station',
    readTask: (id) => state.tasks.find((t) => t.id === id),
    tokenAdmission: (t, stage) => tokenAdmission(t, stage, state.config, state.codexUsage),
    saveTask: async (t, entry) => {
      saved.push({ task: t, entry });
      state.tasks = state.tasks.map((old) => (old.id === t.id ? t : old));
      return { ok: true };
    },
  };
  return { state, saved, io, next: () => scan(state), apply: (actions) => execute(actions, io) };
}

describe('переходы ожидания бюджета', () => {
  it('удерживает, переживает повтор/перезапуск, обновляет лимит и восстанавливает этап', async () => {
    const original = task({ returnTo: 'audit' });
    const w = world({ tasks: [original] });
    const planned = w.next();
    expect(planned.actions.map((a) => a.kind)).toEqual(['hold-token-budget']);
    await w.apply(planned.actions);
    expect(w.state.tasks[0]).toMatchObject({
      status: 'token-limit',
      returnTo: 'audit',
      attempts: original.attempts,
      tokenHold: {
        originStatus: 'implement',
        resumeStatus: 'implement',
        originPriority: 42,
        spent: 100,
        limit: 100,
      },
    });
    expect(w.next().actions).toEqual([]);
    // Новый процесс получает только сохранённые карточку и счётчик.
    const restarted = world(JSON.parse(JSON.stringify(w.state)));
    expect(restarted.next().actions).toEqual([]);
    restarted.state.tasks[0].userTokenLimit = { value: 90 };
    await restarted.apply(restarted.next().actions);
    expect(restarted.state.tasks[0].tokenHold.limit).toBe(90);
    expect(restarted.next().actions).toEqual([]);
    restarted.state.tasks[0].userTokenLimit = { value: 150 };
    expect(restarted.next().actions.map((a) => a.kind)).toEqual(['resume-token-budget']);
    await restarted.apply(restarted.next().actions);
    const resumed = restarted.state.tasks[0];
    expect(resumed.status).toBe('implement');
    expect(resumed.tokenHold).toBeUndefined();
    expect(resumed.attempts).toEqual(original.attempts);
    expect(resumed.links).toEqual(original.links);
    expect(resumed.priority).toBe(42);
    expect(resumed.returnTo).toBe('audit');
    expect(restarted.saved.at(-1).entry.restorePriority).toBe(42);
    expect(restarted.next().actions.some((a) => a.kind === 'continue-stage')).toBe(true);
  });

  it('удержание раньше отказа по попыткам, без реестра и при занятых местах', async () => {
    const w = world({
      tasks: [task({ attempts: { continuations: 99, spawnFailures: 99 } })],
      registry: { entries: [] },
      running: [{ taskId: '0002-other', stage: 'design' }],
    });
    expect(w.next().actions.map((a) => a.kind)).toEqual(['hold-token-budget']);
    await w.apply(w.next().actions);
    expect(w.state.tasks[0].attempts).toEqual({ continuations: 99, spawnFailures: 99 });
  });

  it('новая задача удерживается до захвата и создания дерева', () => {
    const w = world({
      tasks: [task({ status: 'new', decomposed: true, owner: null })],
      registry: { entries: [] },
    });
    expect(w.next().actions.map((a) => a.kind)).toEqual(['hold-token-budget']);
  });

  it('исчерпанный прогон не блокирует готовую фичу, индивидуальный предел работает без общего', () => {
    const w = world({
      config: { ...config, codexMaxTaskTokens: null },
      tasks: [
        task({
          status: 'new',
          type: 'run',
          run: { kind: 'arena' },
          userTokenLimit: { value: 100 },
        }),
        task({ id: '0002-other', status: 'new', owner: null }),
      ],
    });
    expect(w.next().actions).toContainEqual(
      expect.objectContaining({ kind: 'start-stage', taskId: '0002-other' }),
    );
    expect(w.next().actions).toContainEqual(
      expect.objectContaining({ kind: 'hold-token-budget', taskId: '0001-one' }),
    );
  });

  it.each(['running', 'batch', 'report', 'api', 'foreign', 'paused'])(
    'не переносит карточку с незавершённой работой: %s',
    (kind) => {
      const w = world(
        kind === 'running'
          ? { running: [{ taskId: '0001-one', stage: 'implement' }] }
          : kind === 'batch'
            ? {
                tasks: [task({ status: 'deploy' })],
                running: [{ taskId: '0002-other', stage: 'deploy' }],
              }
            : kind === 'report'
              ? { reports: [{ taskId: '0002-other', stage: 'deploy', batch: ['0001-one'] }] }
              : kind === 'api'
                ? { apiFailures: [{ taskId: '0001-one', stage: 'implement', why: 'offline' }] }
                : kind === 'foreign'
                  ? { tasks: [task({ owner: 'other' })] }
                  : { paused: true },
      );
      expect(w.next().actions.some((a) => a.kind.includes('token-budget'))).toBe(false);
    },
  );

  it('после повышения возвращает задачу и при неполном учёте, сохраняя зависимости', async () => {
    const w = world();
    await w.apply(w.next().actions);
    expect(w.state.tasks[0].status).toBe('token-limit');
    // Повышение лимита выпускает карточку независимо от полноты учёта.
    // Прежде неполный учёт удерживал её и после повышения, и выйти она
    // не могла вовсе: допуск смотрел на полноту учёта отдельно от суммы,
    // а поднять полноту владельцу продукта нечем.
    w.state.tasks[0].userTokenLimit = { value: 200 };
    w.state.codexUsage = ledger(100, ['decreased-usage']);
    w.state.tasks[0].dependsOn = ['0002-missing'];
    await w.apply(w.next().actions);
    expect(w.state.tasks[0].status).toBe('implement');
    // Зависимости при этом держат запуск по-прежнему: бюджет их не подменяет.
    expect(w.next().actions).toEqual([]);
    expect(w.next().notes.join()).toContain('0002-missing');
  });

  it('не запускает диагностику бюджетного ожидания и не угадывает повреждённый этап', async () => {
    const w = world({ now: '2026-09-08T10:00:00Z' });
    expect(w.next().actions.map((a) => a.kind)).toEqual(['hold-token-budget']);
    await w.apply(w.next().actions);
    expect(w.next().actions).toEqual([]);
    delete w.state.tasks[0].tokenHold;
    expect(w.next().actions).toEqual([]);
    expect(w.next().notes.join()).toContain('Не сохранён');
  });

  it('повторно проверяет допуск и живой процесс перед записью', async () => {
    const w = world();
    const actions = w.next().actions;
    w.state.tasks[0].userTokenLimit = { value: 200 };
    await w.apply(actions);
    expect(w.saved).toEqual([]);
    w.state.tasks[0].userTokenLimit = { value: 50 };
    w.io.tokenActionBlocked = () => true;
    await w.apply(w.next().actions);
    expect(w.saved).toEqual([]);
  });

  it('Trello одним запросом сохраняет колонку, панель и контекст; при возврате восстанавливает позицию', async () => {
    const w = world();
    await w.apply(w.next().actions);
    const held = w.state.tasks[0];
    const calls = [];
    const snapshot = {
      lists: Object.entries(config.trello.lists).map(([state, name]) => ({ id: state, name })),
      labels: [{ id: 'feature', name: config.trello.labels.feature.name }],
      comments: [],
      cards: [
        {
          id: '6a9db98569e45a21ffed1107',
          name: '0001-one · Работа',
          desc: joinDescription(task().description, metaOf(task())),
          idList: 'implement',
          idLabels: ['feature'],
          pos: 42,
        },
      ],
    };
    const trello = {
      put: async (path, body) => {
        calls.push({ path, body });
        return { ok: true };
      },
      post: async () => ({ ok: false, kind: 'offline', why: 'обрыв после переноса' }),
    };
    const backlog = createTrelloBacklog({ trello, config, snapshot });
    expect((await backlog.saveTask(held, w.saved[0].entry)).ok).toBe(false);
    expect(calls[0].body.idList).toBe('token-limit');
    expect(calls[0].body.desc).toContain('**Расход:** 100');
    snapshot.cards[0] = { ...snapshot.cards[0], ...calls[0].body };
    const afterRestart = createTrelloBacklog({ trello, config, snapshot });
    w.state.tasks = [afterRestart.readTask('0001-one')];
    expect(w.next().actions).toEqual([]);
    w.state.tasks[0].userTokenLimit = { value: 200 };
    await w.apply(w.next().actions);
    await afterRestart.saveTask(w.state.tasks[0], w.saved.at(-1).entry);
    expect(calls.at(-1).body).toMatchObject({ idList: 'implement', pos: 42 });
    expect(calls.at(-1).body.desc).not.toContain('token-budget-panel');
    expect(calls.at(-1).body.desc).toContain('Текст владельца');
  });
});

it('неполный учёт не удерживает заход, а принятый минимум снимает и запись о нём', async () => {
  const data = ledger(0, ['missing-usage', 'stdout-unavailable']);
  data.tasks['0001-one'].sessions.s.snapshot = null;
  data.tasks['0001-one'].launches.l = {
    sessionId: 's',
    baseline: { input_tokens: 0, output_tokens: 0 },
    observations: {},
    completed: true,
    reasons: ['missing-usage', 'stdout-unavailable'],
  };
  const w = world({ codexUsage: data });

  // Прежде такой задачи хватало на удержание в «Лимите токенов» навсегда:
  // расход неизвестен, а повышение лимита незнание не лечит. Теперь заход
  // идёт, и о неполноте учёта говорит запись в журнале задачи — один раз
  // на выданную сессию, а не каждый оборот.
  const before = w.next().actions.find((action) => action.kind === 'continue-stage');
  expect(w.state.tasks[0].status).toBe('implement');
  expect(before.unaccounted).toContain('посчитать не удалось');
  expect(before.unaccounted).not.toContain('Лимит токенов:');

  expect(
    recoverTokenLaunch(data, '0001-one', 'l', {
      ok: true,
      source: 'token_usage_record',
      complete: false,
      digest: 'a'.repeat(64),
      snapshot: { input_tokens: 10, output_tokens: 2 },
    }),
  ).toBe(true);
  w.io.tokenAccountingNote = (id) => tokenAccountingNote(data, id);

  // Принятый минимум прерванного запуска делает учёт допустимым, и запись
  // о неучтённом заходе исчезает сама: политика восстановления сохранена.
  const after = w.next().actions.find((action) => action.kind === 'continue-stage');
  expect(after.unaccounted).toBeUndefined();
  expect(tokenAccountingNote(data, '0001-one')).toContain('неизвестный хвост');
  expect(tokenAccountingNote(data, '0001-one')).toContain('12 токенов');
});
