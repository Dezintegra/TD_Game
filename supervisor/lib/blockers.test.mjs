import { expect, it } from 'vitest';
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
    forgotten: [],
    readTask: (id) => tasks.get(id),
    allTaskIds: () => [...tasks.keys()],
    createTask: async (t) => {
      tasks.set(t.id, t);
      io.created.push(t);
      return { ok: true };
    },
    saveTask: async (t) => {
      tasks.set(t.id, t);
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
