import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/defaults.mjs';
import { tokenAdmission } from './token-hold.mjs';
import { tokenReanalysisAdmission } from './token-reanalysis.mjs';
import { applyReport } from './apply-report.mjs';
import { scan } from './scan.mjs';
import { execute } from './execute.mjs';
import { createTrelloBacklog } from './backlog-trello.mjs';
import { joinDescription, metaOf } from './card.mjs';
import { stagePrompt } from './stage-prompt.mjs';
import { checkEnvironment } from './environment.mjs';

const now = '2026-09-07T22:00:00Z';
const config = {
  ...resolveConfig({ commands: { verify: 'x', deploy: 'x', perf: 'x' }, worktreeDir: 'trees' })
    .config,
  provider: 'codex',
  codexTaskReanalysisTokens: 150,
  codexMaxTaskTokens: 250,
};
const task = (over = {}) => ({
  id: '0001-one',
  type: 'feature',
  title: 'Работа',
  status: 'revise',
  priority: 42,
  owner: 'station',
  createdAt: now,
  statusChangedAt: now,
  description: 'Сделать работу',
  returnTo: 'review',
  decomposed: true,
  attempts: { continuations: 1, rejections: 1, spawnFailures: 1 },
  links: { pr: 205, change: 'work' },
  ...over,
});
const ledger = (spent = 150, reasons = []) => ({
  version: 2,
  tasks: {
    '0001-one': {
      sessions: {
        old: { knownTokens: spent, snapshot: { input_tokens: spent, output_tokens: 0 }, reasons },
      },
      launches: {},
    },
  },
});
const report = (over = {}) => ({
  taskId: '0001-one',
  stage: 'decompose',
  outcome: 'done',
  summary: 'Разделить нельзя: существующий PR и его проверка изменяют один контракт.',
  requests: [],
  ...over,
});

function world(over = {}) {
  const state = {
    config,
    now,
    machine: 'station',
    tasks: [task()],
    codexUsage: ledger(),
    registry: { entries: [{ taskId: '0001-one', branch: 'worktree-0001-one', path: 'tree' }] },
    reports: [],
    ...over,
  };
  const saved = [];
  const io = {
    now,
    machine: 'station',
    readTask: (id) => state.tasks.find((t) => t.id === id),
    tokenAdmission: (t, stage) => tokenAdmission(t, stage, state.config, state.codexUsage),
    tokenReanalysisAdmission: (t, stage) =>
      tokenReanalysisAdmission(t, stage, state.config, state.codexUsage),
    saveTask: async (t, entry) => {
      state.tasks = [t];
      saved.push({ t, entry });
      return { ok: true };
    },
    forgetSession: vi.fn(),
    removeReport: vi.fn(() => {
      state.reports = [];
    }),
    readReport: () => state.reports[0],
    allTaskIds: () => state.tasks.map((t) => t.id),
  };
  return {
    state,
    io,
    saved,
    next: () => scan(state),
    apply: (actions) => execute(actions, io),
    finish: async (answer = report()) => {
      state.reports = [answer];
      return execute([{ kind: 'transfer-report', taskId: '0001-one', stage: 'decompose' }], io);
    },
  };
}

describe('ранний бюджетный анализ', () => {
  it.each([
    [14_999_999, 'continue-stage'],
    [15_000_000, 'analyze-token-budget'],
    [24_999_999, 'analyze-token-budget'],
    [25_000_000, 'hold-token-budget'],
    [26_000_000, 'hold-token-budget'],
  ])('штатные пороги при расходе %s дают %s', (spent, kind) => {
    const actual = resolveConfig({
      provider: 'codex',
      commands: { verify: 'x', deploy: 'x', perf: 'x' },
      worktreeDir: 'trees',
    }).config;
    expect(actual.codexTaskReanalysisTokens).toBe(15_000_000);
    expect(actual.codexMaxTaskTokens).toBe(25_000_000);
    expect(
      world({ config: actual, codexUsage: ledger(spent) })
        .next()
        .actions.map((a) => a.kind),
    ).toEqual([kind]);
  });

  it('анализ не стирает исчерпанные продолжения прежнего этапа', async () => {
    const w = world({ tasks: [task({ attempts: { continuations: 99, rejections: 2 } })] });
    await w.apply(w.next().actions);
    expect(w.next().actions.map((a) => a.kind)).toEqual(['continue-stage']);
    await w.finish();
    expect(w.state.tasks[0].attempts.continuations).toBe(99);
    expect(w.next().actions.map((a) => a.kind)).toEqual(['fail-stage']);
  });

  it.each([149, 150, 249, 250, 300])('граничный расход %s выбирает ровно один маршрут', (spent) => {
    const w = world({ codexUsage: ledger(spent) });
    expect(w.next().actions.map((a) => a.kind)).toEqual([
      spent < 150 ? 'continue-stage' : spent < 250 ? 'analyze-token-budget' : 'hold-token-budget',
    ]);
  });

  it('неделимая задача переживает рестарт и продолжает прежний этап до окончательного лимита', async () => {
    const original = task();
    const w = world();
    expect((await w.apply(w.next().actions))[0].result).toBe('done');
    const analyzed = w.state.tasks[0];
    expect(analyzed).toMatchObject({
      status: 'decompose',
      attempts: { continuations: 0, rejections: 0 },
      tokenReanalysis: {
        phase: 'analyzing',
        originStatus: 'revise',
        originAttempts: original.attempts,
      },
    });
    expect(w.next().actions.map((a) => a.kind)).toEqual(['continue-stage']);
    expect(w.io.forgetSession).toHaveBeenCalledWith(original.id, 'decompose');
    const restarted = world(JSON.parse(JSON.stringify(w.state)));
    restarted.state.codexUsage = ledger(170);
    expect((await restarted.finish())[0].status).toBe('revise');
    expect(restarted.state.tasks[0]).toMatchObject({
      status: original.status,
      attempts: original.attempts,
      priority: original.priority,
      returnTo: original.returnTo,
      links: original.links,
      decomposed: true,
      tokenReanalysis: { phase: 'completed' },
    });
    expect(restarted.saved.at(-1).entry.restorePriority).toBe(original.priority);
    expect(restarted.next().actions.map((a) => a.kind)).toEqual(['continue-stage']);
    restarted.state.codexUsage = ledger(250);
    await restarted.apply(restarted.next().actions);
    expect(restarted.state.tasks[0]).toMatchObject({
      status: 'token-limit',
      tokenHold: { resumeStatus: 'revise' },
    });
    restarted.state.tasks[0].userTokenLimit = { value: 300 };
    await restarted.apply(restarted.next().actions);
    expect(restarted.state.tasks[0].status).toBe('revise');
    expect(restarted.next().actions.map((a) => a.kind)).toEqual(['continue-stage']);
    expect(restarted.state.codexUsage).toEqual(ledger(250));
  });

  it('готовый анализ принимается после окончательного порога, следующий запуск удерживается', async () => {
    const w = world();
    await w.apply(w.next().actions);
    w.state.codexUsage = ledger(260);
    w.state.reports = [report()];
    expect(w.next().actions.map((a) => a.kind)).toEqual(['transfer-report']);
    await w.finish();
    await w.apply(w.next().actions);
    expect(w.state.tasks[0]).toMatchObject({
      status: 'token-limit',
      tokenHold: { resumeStatus: 'revise' },
      tokenReanalysis: { phase: 'completed' },
    });
  });

  it('продолжение анализа тоже удерживается по окончательному пределу и возобновляется с контекстом', async () => {
    const w = world();
    await w.apply(w.next().actions);
    w.state.codexUsage = ledger(250);
    await w.apply(w.next().actions);
    expect(w.state.tasks[0]).toMatchObject({
      status: 'token-limit',
      tokenHold: { resumeStatus: 'decompose' },
    });
    w.state.tasks[0].userTokenLimit = { value: 300 };
    await w.apply(w.next().actions);
    expect(w.state.tasks[0].status).toBe('decompose');
    await w.finish();
    expect(w.state.tasks[0]).toMatchObject({ status: 'revise', attempts: task().attempts });
  });

  it('повтор доставки после сохранения карточки не меняет восстановленный этап', async () => {
    const w = world();
    await w.apply(w.next().actions);
    const save = w.io.saveTask;
    w.io.saveTask = async (...args) => {
      await save(...args);
      return { ok: false, outcome: 'offline' };
    };
    expect((await w.finish())[0].result).toBe('failed');
    const recorded = JSON.parse(JSON.stringify(w.state.tasks[0]));
    const restarted = world(JSON.parse(JSON.stringify(w.state)));
    expect((await restarted.finish())[0].result).toBe('done');
    expect(restarted.saved).toEqual([]);
    expect(restarted.state.tasks[0]).toEqual(recorded);
  });

  it.each([
    { running: [{ taskId: '0001-one', stage: 'revise' }] },
    { reports: [{ taskId: '0001-one', stage: 'revise' }] },
    { paused: true },
    { apiPaused: true },
    { tasks: [task({ owner: 'other' })] },
    { tasks: [task({ dependsOn: ['0002-other'] })] },
    { apiFailures: [{ taskId: '0001-one', stage: 'revise' }] },
  ])('не перехватывает недоступную задачу: %j', (over) => {
    expect(
      world(over)
        .next()
        .actions.some((a) => a.kind === 'analyze-token-budget'),
    ).toBe(false);
  });

  it('служебный переход не занимает место, проверяет свежий бюджет и живую сессию', async () => {
    const w = world({
      running: [{ taskId: '0002-two', stage: 'design' }],
      registry: { entries: [] },
    });
    const actions = w.next().actions;
    expect(actions.map((a) => a.kind)).toEqual(['analyze-token-budget']);
    w.state.codexUsage = ledger(260);
    expect((await w.apply(actions))[0].result).toBe('skipped');
    w.state.codexUsage = ledger(150);
    w.io.tokenActionBlocked = () => true;
    expect((await w.apply(actions))[0].result).toBe('skipped');
    expect(w.saved).toEqual([]);
  });

  it('личный предел, неполный учёт, тип задачи и отключение анализа учитываются', () => {
    expect(
      world({ tasks: [task({ userTokenLimit: { value: 140 } })] }).next().actions[0].kind,
    ).toBe('hold-token-budget');
    // Неполный учёт ни удерживает, ни назначает ранний анализ: посчитанный
    // расход окончательного предела не достиг, а по неизвестному хвосту
    // дробить задачу не за что. Прежде здесь стоял 'hold-token-budget' —
    // удержание по незнанию, которое владельцу продукта нечем было снять.
    expect(world({ codexUsage: ledger(150, ['missing-baseline']) }).next().actions[0].kind).toBe(
      'continue-stage',
    );
    for (const t of [
      task({ type: 'note' }),
      task({ type: 'run' }),
      task({ tokenReanalysis: { phase: 'completed' } }),
    ])
      expect(tokenReanalysisAdmission(t, 'revise', config, ledger())).toBeNull();
    expect(
      tokenReanalysisAdmission(
        task(),
        'revise',
        { ...config, codexTaskReanalysisTokens: null },
        ledger(),
      ),
    ).toBeNull();
    expect(
      tokenReanalysisAdmission(task(), 'revise', { ...config, provider: 'claude' }, ledger()),
    ).toBeNull();
  });

  it('обычный анализ, split и настоящий вопрос сохраняют свой контракт', async () => {
    expect(applyReport(task({ status: 'decompose' }), report()).status).toBe('design');
    const w = world();
    await w.apply(w.next().actions);
    const t = w.state.tasks[0];
    expect(applyReport(t, report({ outcome: 'question' })).status).toBe('awaiting-po');
    expect(applyReport(t, report({ outcome: 'split', requests: [{}, {}] })).status).toBe(
      'postmortem',
    );
    expect(
      applyReport({ ...t, links: {} }, report({ outcome: 'split', requests: [{}, {}] })).status,
    ).toBe('closed');
    expect(applyReport(t, report({ summary: '' })).status).toBe('postmortem');
    expect(applyReport({ ...t, tokenReanalysis: { phase: 'analyzing' } }, report()).status).toBe(
      'postmortem',
    );
  });

  it('контекст проходит через настоящую сериализацию Trello и попадает в назначение', async () => {
    const w = world();
    await w.apply(w.next().actions);
    const t = w.state.tasks[0];
    const snapshot = {
      lists: Object.entries(config.trello.lists).map(([id, name]) => ({ id, name })),
      labels: [{ id: 'feature', name: config.trello.labels.feature.name }],
      comments: [],
      cards: [
        {
          id: 'abc',
          name: '0001-one · Работа',
          desc: joinDescription(t.description, metaOf(t)),
          idList: 'decompose',
          idLabels: ['feature'],
          pos: 7,
        },
      ],
    };
    const roundtrip = createTrelloBacklog({ config, snapshot, trello: {} }).readTask(t.id);
    expect(roundtrip.tokenReanalysis).toEqual(t.tokenReanalysis);
    const prompt = stagePrompt({
      task: roundtrip,
      assignment: { taskId: t.id, stage: 'decompose' },
    });
    expect(prompt).toContain('Ранний бюджетный анализ Codex');
    expect(prompt).toContain('Сохранённый этап: revise');
    expect(prompt).toContain('верни done');
  });

  it.each([0, -1, 1.5, '150', Number.MAX_SAFE_INTEGER + 1])(
    'не принимает неверную настройку %s',
    (value) => {
      const result = checkEnvironment({
        config: { ...config, codexTaskReanalysisTokens: value },
        root: '/repo',
        home: '/repo/supervisor',
        run: () => ({ code: 0, stdout: 'version' }),
        exists: () => true,
        env: {},
      });
      expect(result.fatal).toContain('codexTaskReanalysisTokens');
    },
  );
});
