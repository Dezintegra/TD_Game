import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execute } from './execute.mjs';
import { metaOf, parseCard, joinDescription } from './card.mjs';
import { planBlockers, transferBlocked, unblockTask } from './blockers.mjs';
import { scan } from './scan.mjs';
import { resolveConfig } from '../config/defaults.mjs';

const now = '2026-09-07T12:00:00Z';
const task = (over = {}) => ({
  id: '0001-ux',
  type: 'feature',
  status: 'design',
  priority: 20,
  statusChangedAt: now,
  createdAt: now,
  links: { pr: 23, change: 'ux' },
  spentUsd: 7,
  attempts: { continuations: 2, rejections: 1 },
  ...over,
});
const report = (over = {}) => ({
  stage: 'design',
  outcome: 'blocked',
  categories: ['ux'],
  summary: 'Нужна сборка',
  costUsd: 2,
  blockers: [
    { requestKey: 'build', reason: 'Сборка не проходит', result: 'Исправленная сборка в main' },
  ],
  requests: [
    {
      key: 'build',
      type: 'feature',
      title: 'Починка сборки',
      description: 'Исправить сборку',
      categories: ['infrastructure'],
    },
  ],
  ...over,
});
const config = resolveConfig({
  commands: { verify: 'x', deploy: 'x', perf: 'x' },
  worktreeDir: '.trees',
}).config;
function world(items = [task()]) {
  const tasks = new Map(items.map((t) => [t.id, t]));
  const io = {
    now,
    tasks,
    created: [],
    entries: [],
    forgotten: [],
    readTask: (id) => tasks.get(id),
    allTaskIds: () => [...tasks.keys()],
    createTask: async (t) => {
      tasks.set(t.id, t);
      io.created.push(t);
      return { ok: true };
    },
    saveTask: async (t, entry) => {
      tasks.set(t.id, t);
      io.entries.push(entry);
      return { ok: true };
    },
    removeReport: () => {},
    forgetSession: (id, stage) => io.forgotten.push(stage),
  };
  return io;
}

it('обязательная инфраструктура идёт первой, необязательная остаётся кандидатом', () => {
  const r = report();
  r.requests.push({ ...r.requests[0], key: 'nice', title: 'Полезное улучшение' });
  const p = planBlockers(task(), r, [task()], now);
  expect(p.problem).toBeUndefined();
  expect(p.planned.map((t) => [t.status, t.blocking])).toEqual([
    ['new', true],
    ['candidate', false],
  ]);
  expect(p.next.dependsOn).toEqual([p.planned[0].id]);
});

const nukeReport = () => {
  const skill = readFileSync(new URL('../skills/triage.md', import.meta.url), 'utf8');
  return JSON.parse(
    [...skill.matchAll(/```json\s+([\s\S]*?)```/g)]
      .map((match) => match[1])
      .find((value) => value.includes('0032-yadernyy')),
  );
};
const nukeSource = () =>
  task({
    id: nukeReport().taskId,
    type: 'note',
    status: 'triage',
    title: 'Собственные потери',
    description: 'Проверить четыре удара',
    categories: ['balance'],
    branch: 'worktree-0032-yadernyy',
    history: [{ what: 'Начат анализ' }],
    links: { change: 'nuke-counts-own-losses', pr: 23 },
    analysisGeneration: 4,
    attempts: { continuations: 100, rejections: 1 },
  });
const nukeRun = () =>
  task({
    id: nukeReport().blockers[0].taskId,
    type: 'run',
    status: 'failed',
    links: { run: 'previous-incomplete-run' },
  });
const reread = (value) =>
  parseCard(
    {
      id: '6a9084b276c945372833816f',
      name: value.title,
      pos: value.priority,
      desc: joinDescription(value.description, metaOf(value)),
      idList: value.status,
      idLabels: [value.type],
    },
    {
      stateByList: new Map([[value.status, value.status]]),
      labelKeyById: new Map([[value.type, value.type]]),
    },
  ).task;
async function acceptNuke(io, value) {
  io.readReport = () => value;
  return (
    await execute([{ kind: 'transfer-report', taskId: value.taskId, stage: value.stage }], io)
  )[0];
}

it.each([false, true])(
  'пример 0032 принимается однократно, потеря ответа PUT: %s',
  async (lost) => {
    const source = nukeSource();
    const predecessor = nukeRun();
    const io = world([source, predecessor]);
    const value = { ...nukeReport(), costUsd: 2 };
    const save = io.saveTask;
    io.saveTask = async (...args) => {
      await save(...args);
      return lost ? { ok: false, outcome: 'offline' } : { ok: true };
    };
    expect((await acceptNuke(io, value)).result).toBe(lost ? 'failed' : 'done');
    io.saveTask = save;
    const saved = globalThis.structuredClone(io.readTask(source.id));
    expect(saved).toMatchObject({
      status: 'blocked',
      spentUsd: 9,
      branch: source.branch,
      links: source.links,
      history: [...source.history, expect.objectContaining({ from: 'triage', to: 'blocked' })],
      dependsOn: [predecessor.id],
      blockedContext: { from: 'triage', reasons: value.blockers },
    });
    expect(io.entries[0].what).toContain(value.blockers[0].reason);
    expect(io.entries[0].what).toContain(value.blockers[0].result);
    expect((await acceptNuke(io, value)).result).toBe('done');
    expect(io.readTask(source.id)).toEqual(saved);
    expect(io.entries).toHaveLength(1);
    expect(io.readTask(predecessor.id)).toEqual(predecessor);
    expect(io.created).toEqual([]);
  },
);

it('0032 удерживается сто циклов и получает новый анализ только после результата 0120', async () => {
  const source = nukeSource();
  const predecessor = nukeRun();
  const io = world([source, predecessor]);
  await acceptNuke(io, { ...nukeReport(), costUsd: 2 });
  const blocked = reread(io.readTask(source.id));
  io.tasks.set(source.id, blocked);
  const independent = task({ id: '0099-ready', status: 'new', priority: 1 });
  for (const time of [
    now,
    '2026-09-07T17:00:00Z',
    '2026-09-07T17:00:01Z',
    '2026-09-08T12:00:00Z',
  ]) {
    for (let i = 0; i < 100; i++) {
      const result = scan({ config, now: time, tasks: [blocked, predecessor, independent] });
      expect(result.actions.filter((a) => a.taskId === source.id)).toEqual([]);
      expect(result.actions).toContainEqual(
        expect.objectContaining({ taskId: independent.id, kind: 'start-stage' }),
      );
      expect(result.notes.join(' ')).toContain(predecessor.id);
    }
  }
  for (const predecessors of [[], [{ ...predecessor, status: 'closed' }]])
    expect(
      scan({
        config,
        now: '2026-09-08T12:00:00Z',
        tasks: [blocked, ...predecessors],
      }).actions.filter((a) => a.taskId === source.id),
    ).toEqual([]);
  expect(
    scan({
      config,
      now: '2026-09-08T12:00:00Z',
      tasks: [blocked],
      invalid: [{ id: predecessor.id, problems: ['повреждена карточка'] }],
    }).actions.filter((a) => a.taskId === source.id),
  ).toEqual([]);
  expect(io.readTask(source.id)).toEqual(blocked);
  expect(blocked.attempts.continuations).toBe(100);
  io.tasks.set(predecessor.id, {
    ...predecessor,
    status: 'completed',
    links: { run: '0120-result' },
  });
  const action = scan({ config, now, tasks: [...io.tasks.values()] }).actions.find(
    (a) => a.kind === 'unblock-task',
  );
  expect(action).toBeTruthy();
  io.tasks.set(predecessor.id, predecessor);
  expect((await unblockTask(action, io)).result).toBe('skipped');
  expect(io.readTask(source.id)).toEqual(blocked);
  io.tasks.set(predecessor.id, {
    ...predecessor,
    status: 'completed',
    links: { run: '0120-result' },
  });
  expect((await unblockTask(action, io)).status).toBe('new');
  const next = io.readTask(source.id);
  expect(next).toMatchObject({
    analysisGeneration: 5,
    spentUsd: 9,
    reanalysis: true,
    blockedContext: blocked.blockedContext,
    links: blocked.links,
    attempts: { continuations: 0, rejections: 1 },
  });
  expect((await unblockTask(action, io)).result).toBe('skipped');
  expect(io.readTask(source.id)).toEqual(next);
  expect(io.forgotten).toContain('triage');
  expect(scan({ config, now, tasks: [...io.tasks.values(), independent] }).actions).toContainEqual(
    expect.objectContaining({ taskId: source.id, kind: 'start-stage', stage: 'triage' }),
  );
});

it('0032 сохраняет добавленные links и не обходит второй блокер или условие PR', async () => {
  const source = nukeSource();
  const predecessor = nukeRun();
  const io = world([source, predecessor]);
  await acceptNuke(io, {
    ...nukeReport(),
    links: { change: 'nuke-counts-own-losses', pr: 24, run: 'source-artifact' },
  });
  const blocked = io.readTask(source.id);
  expect(blocked.links).toEqual({
    change: 'nuke-counts-own-losses',
    pr: 24,
    run: 'source-artifact',
  });
  const completed = { ...predecessor, status: 'completed', links: { pr: 126 } };
  const extra = task({ id: '0003-extra', status: 'failed' });
  for (const value of [
    { ...blocked, dependsOn: [...blocked.dependsOn, extra.id] },
    { ...blocked, dependencyResults: [{ taskId: predecessor.id, kind: 'merged-pr', pr: 126 }] },
  ]) {
    io.tasks.set(source.id, value);
    io.tasks.set(predecessor.id, completed);
    io.tasks.set(extra.id, extra);
    expect(
      scan({ config, now, tasks: [...io.tasks.values()] }).actions.filter(
        (a) => a.taskId === source.id,
      ),
    ).toEqual([]);
    expect((await unblockTask({ taskId: source.id, mainBranch: 'main' }, io)).result).toBe(
      'skipped',
    );
  }
});

it('triage принимает failed без подъёма или дубликата, сохраняя основание', async () => {
  const source = task({ status: 'triage' });
  const predecessor = task({ id: '0002-run', status: 'failed', type: 'run' });
  const io = world([source, predecessor]);
  const value = report({
    stage: 'triage',
    requests: [],
    blockers: [{ taskId: predecessor.id, reason: 'Нужны измерения', result: 'Артефакты арены' }],
  });
  expect(await transferBlocked(source, value, {}, io)).toEqual({
    result: 'done',
    status: 'blocked',
  });
  expect(io.readTask(source.id)).toMatchObject({
    dependsOn: [predecessor.id],
    blockedContext: { from: 'triage', reasons: value.blockers, operation: expect.any(String) },
    links: source.links,
  });
  expect(io.readTask(predecessor.id)).toEqual(predecessor);
  expect(io.created).toEqual([]);
});

it('failed не отменяет проверку валидности, уникальности, самоссылок и циклов', () => {
  const source = task();
  const predecessor = task({ id: '0002-run', status: 'failed' });
  const value = report({
    requests: [],
    blockers: [{ taskId: predecessor.id, reason: 'Нужно', result: 'Результат' }],
  });
  for (const known of [
    [source],
    [source, predecessor, predecessor],
    [source, { ...predecessor, valid: false }],
    [source, { ...predecessor, dependsOn: [source.id] }],
    [source, { ...predecessor, status: 'closed' }],
  ])
    expect(planBlockers(source, value, known, now).problem).toBeTruthy();
  expect(
    planBlockers(
      source,
      { ...value, blockers: [{ ...value.blockers[0], taskId: source.id }] },
      [source],
      now,
    ).problem,
  ).toBeTruthy();
});

it('сохраняет старые условия и два необходимых PR на собственной карточке', async () => {
  const source = task({
    dependsOn: ['0004-old'],
    dependencyResults: [{ taskId: '0004-old', kind: 'merged-pr', pr: 100 }],
  });
  const io = world([
    source,
    task({ id: '0002-store' }),
    task({ id: '0003-channel' }),
    task({ id: '0004-old' }),
  ]);
  const value = report({
    requests: [],
    blockers: [
      {
        taskId: '0002-store',
        reason: 'Нужно хранилище',
        result: 'В main',
        dependencyResult: { kind: 'merged-pr', pr: 172 },
      },
      {
        taskId: '0003-channel',
        reason: 'Нужен канал',
        result: 'В main',
        dependencyResult: { kind: 'merged-pr', pr: 177 },
      },
    ],
  });
  expect((await transferBlocked(source, value, {}, io)).status).toBe('blocked');
  expect(io.tasks.get(source.id).dependencyResults).toEqual([
    { taskId: '0004-old', kind: 'merged-pr', pr: 100 },
    { taskId: '0002-store', kind: 'merged-pr', pr: 172 },
    { taskId: '0003-channel', kind: 'merged-pr', pr: 177 },
  ]);
  expect(io.created).toEqual([]);
});

it('не пишет карточки при неверном результате или попытке сменить прежний PR', async () => {
  for (const dependencyResult of [
    { kind: 'merged-pr', pr: 0 },
    { kind: 'merged-pr', pr: '172' },
    { kind: 'merged-pr', pr: 172, taskId: '0003-wrong' },
    { kind: 'merged-pr', pr: 177 },
  ]) {
    const source = task({
      dependsOn: ['0002-store'],
      dependencyResults: [{ taskId: '0002-store', kind: 'merged-pr', pr: 172 }],
    });
    const io = world([source, task({ id: '0002-store' })]);
    const value = report({
      blockers: [
        ...report().blockers,
        { taskId: '0002-store', reason: 'Нужно', result: 'В main', dependencyResult },
      ],
    });
    expect((await transferBlocked(source, value, {}, io)).result).toBe('failed');
    expect(io.tasks.get(source.id)).toEqual(source);
    expect(io.created).toEqual([]);
  }
});

it('требует обоснование, результат и категорию, а не одну метку blocking', () => {
  for (const over of [
    { blockers: [] },
    { categories: [] },
    { blockers: [{ taskId: '0002-build', reason: 'Нужно' }] },
    { requests: [{ key: 'build', type: 'feature', title: 'Сборка', description: 'Описание' }] },
  ])
    expect(planBlockers(task(), report(over), [task()], now).problem).toBeTruthy();
});

it('цикл и отсутствующий существующий предшественник отвергаются до создания', () => {
  const r = report({
    requests: [],
    blockers: [{ taskId: '0002-build', reason: 'Нужно', result: 'Сборка' }],
  });
  expect(planBlockers(task(), r, [task()], now).problem).toContain('отсутствует');
  expect(
    planBlockers(task(), r, [task(), task({ id: '0002-build', dependsOn: ['0001-ux'] })], now)
      .problem,
  ).toContain('цикл');
});

it('обрыв сохранения родителя не создаёт повторную карточку и не теряет расход', async () => {
  const io = world();
  const save = io.saveTask;
  io.saveTask = async () => ({ ok: false, outcome: 'offline' });
  expect((await transferBlocked(task(), report(), {}, io)).result).toBe('failed');
  io.saveTask = save;
  expect((await transferBlocked(task(), report(), {}, io)).status).toBe('blocked');
  expect(io.created).toHaveLength(1);
  expect(io.tasks.get('0001-ux')).toMatchObject({
    status: 'blocked',
    spentUsd: 9,
    links: { pr: 23 },
    attempts: { continuations: 2, rejections: 1 },
  });
});

it('повтор после успешного PUT не удваивает расход', async () => {
  const io = world();
  const save = io.saveTask;
  io.saveTask = async (t) => {
    await save(t);
    return { ok: false, outcome: 'offline' };
  };
  await transferBlocked(task(), report(), {}, io);
  const saved = io.tasks.get('0001-ux');
  expect((await transferBlocked(saved, report(), {}, io)).result).toBe('done');
  expect(saved.spentUsd).toBe(9);
  expect(io.created).toHaveLength(1);
});

it('созданный предшественник может завершиться до повтора записи родителя', async () => {
  const io = world();
  const save = io.saveTask;
  io.saveTask = async () => ({ ok: false, outcome: 'offline' });
  await transferBlocked(task(), report(), {}, io);
  const born = io.created[0];
  io.tasks.set(born.id, { ...born, status: 'completed' });
  io.saveTask = save;
  expect((await transferBlocked(task(), report(), {}, io)).result).toBe('done');
  expect(io.created).toHaveLength(1);
});

it('давний выполненный блокер не обновляет квоту анализа', () => {
  const r = report({
    requests: [],
    blockers: [{ taskId: '0002-build', reason: 'Нужно', result: 'Сборка' }],
  });
  const predecessor = task({
    id: '0002-build',
    status: 'completed',
    statusChangedAt: '2026-09-01T12:00:00Z',
  });
  expect(planBlockers(task(), r, [task(), predecessor], now).problem).toContain('до этого анализа');
});

it('существующий кандидат становится подтверждённой обязательной задачей', async () => {
  const io = world([task(), task({ id: '0002-build', status: 'candidate' })]);
  const r = report({
    requests: [],
    blockers: [{ taskId: '0002-build', reason: 'Не собирается', result: 'Сборка' }],
  });
  await transferBlocked(task(), r, {}, io);
  expect(io.tasks.get('0002-build')).toMatchObject({ status: 'new', blocking: true });
  expect(io.created).toHaveLength(0);
});

it('ожидание не расходует попытки, closed и пропавшая карточка не разрешают запуск', () => {
  const blocked = task({
    status: 'blocked',
    dependsOn: ['0002-build'],
    blockedContext: { reasons: ['нужна сборка'] },
  });
  for (const predecessors of [
    [],
    [task({ id: '0002-build', status: 'closed' })],
    [task({ id: '0002-build', status: 'new' })],
  ]) {
    const result = scan({ config, tasks: [blocked, ...predecessors] });
    expect(result.actions.filter((a) => a.taskId === blocked.id)).toEqual([]);
    expect(blocked.attempts.continuations).toBe(2);
  }
});

it('выполненные предшественники возвращают на новый анализ, сохраняя PR, ошибки и расходы', async () => {
  const blocked = task({
    status: 'blocked',
    dependsOn: ['0002-build'],
    blockedContext: { reasons: ['сборка'], priority: 20 },
  });
  const io = world([blocked, task({ id: '0002-build', status: 'completed' })]);
  const action = scan({ config, tasks: [...io.tasks.values()] }).actions.find(
    (a) => a.kind === 'unblock-task',
  );
  expect(action).toBeTruthy();
  await unblockTask(action, io);
  const next = io.readTask(blocked.id);
  expect(next).toMatchObject({
    status: 'new',
    reanalysis: true,
    decomposed: false,
    analysisGeneration: 1,
    spentUsd: 7,
    links: { pr: 23 },
    attempts: { continuations: 0, rejections: 1 },
  });
  const ordinary = task({ id: '0003-new', status: 'new', priority: 1 });
  const selected = scan({ config, tasks: [ordinary, ...io.tasks.values()] }).actions.find(
    (a) => a.kind === 'start-stage',
  );
  expect(selected).toMatchObject({ taskId: blocked.id, stage: 'decompose' });
});

it('живой этап и неприменённый отчёт не получают разблокировку', () => {
  const b = task({
    status: 'blocked',
    dependsOn: ['0002-build'],
    blockedContext: { reasons: ['сборка'] },
  });
  for (const state of [
    { running: [{ taskId: b.id, stage: 'design' }] },
    { reports: [{ taskId: b.id, stage: 'design' }] },
  ])
    expect(
      scan({
        config,
        tasks: [b, task({ id: '0002-build', status: 'completed' })],
        ...state,
      }).actions.some((a) => a.kind === 'unblock-task'),
    ).toBe(false);
});
