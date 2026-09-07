import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/defaults.mjs';
import { canTransition } from '../config/transitions.mjs';
import { metaOf, parseCard, joinDescription } from './card.mjs';
import { scan } from './scan.mjs';
import { execute } from './execute.mjs';
import { delayDecision, delayReportProblem, DELAY_STATES } from './delay-analysis.mjs';
import { stagePrompt } from './stage-prompt.mjs';

const now = '2026-09-07T12:00:00Z';
const since = '2026-09-07T06:00:00Z';
const config = resolveConfig({
  commands: { verify: 'x', deploy: 'x', perf: 'x' },
  worktreeDir: '.trees',
}).config;
const task = (over = {}) => ({
  id: '0001-source',
  type: 'feature',
  title: 'Исходная задача',
  description: 'Результат',
  status: 'implement',
  createdAt: since,
  statusChangedAt: since,
  priority: 20,
  links: { pr: 23, change: 'source' },
  attempts: { continuations: 1, cycleFailures: 0 },
  ...over,
});
const diagnosis = (over = {}) => ({
  cause: 'Сессия не может прочитать артефакт CI',
  evidence: ['Лог implement: отказ чтения', 'PR #23'],
  nextAction: 'Исправить разрешение команды и проверить исходную задачу',
  ...over,
});
const report = (over = {}) => ({
  taskId: '0001-source',
  stage: 'postmortem',
  outcome: 'blocked',
  routingVersion: 1,
  categories: ['infrastructure'],
  summary: 'Нужно исправление',
  costUsd: 2,
  delayAnalysis: diagnosis(),
  blockers: [
    {
      requestKey: 'repair',
      reason: 'Без артефакта нельзя продолжить',
      result: 'Артефакт читается',
      specificResult: 'Команда чтения артефакта PR #23 выполняется успешно',
      preventionResult: 'Общее правило разрешений с регрессионным тестом всех этапов',
    },
  ],
  requests: [
    {
      key: 'repair',
      type: 'feature',
      categories: ['infrastructure'],
      title: 'Исправить разрешение чтения',
      description: 'Исправить причину отказа чтения артефакта CI.',
    },
  ],
  ...over,
});
function world(items = [task()]) {
  const tasks = new Map(items.map((item) => [item.id, item]));
  const io = {
    now,
    machine: 'here',
    tasks,
    entries: [],
    created: [],
    removed: [],
    report: null,
    allTaskIds: () => [...tasks.keys()],
    readTask: (id) => tasks.get(id),
    readReport: () => io.report,
    saveTask: async (next, entry) => {
      tasks.set(next.id, next);
      io.entries.push(entry);
      return { ok: true };
    },
    createTask: async (next) => {
      tasks.set(next.id, next);
      io.created.push(next);
      return { ok: true };
    },
    forgetSession: () => {},
    removeReport: (id) => io.removed.push(id),
    release: async () => ({ ok: true }),
    amendTask: async (id, what) => {
      io.entries.push({ taskId: id, what });
      return { ok: true };
    },
  };
  return io;
}
const decision = (io, extra = {}) =>
  scan({ config, now, machine: io.machine, tasks: [...io.tasks.values()], ...extra });
async function diagnose(io) {
  const action = decision(io).actions.find((item) => item.kind === 'analyze-delay');
  expect(action).toBeTruthy();
  expect((await execute([action], io))[0].result).toBe('done');
}
async function transfer(io, value) {
  io.report = value;
  return (
    await execute([{ kind: 'transfer-report', taskId: value.taskId, stage: value.stage }], io)
  )[0];
}

describe('порог задержки', () => {
  it.each(DELAY_STATES)('обнаруживает рабочий статус %s', (status) => {
    expect(delayDecision(task({ status }), { now })?.kind).toBe('analyze-delay');
  });
  it.each(['candidate', 'new', 'awaiting-po', 'completed', 'closed', 'failed'])(
    'не анализирует %s',
    (status) => {
      expect(delayDecision(task({ status }), { now })).toBeNull();
    },
  );
  it('строго больше пяти часов; разные зоны, неверные и будущие даты', () => {
    for (const statusChangedAt of ['2026-09-07T10:00:00+03:00', now, '2027-01-01T00:00:00Z', 'bad'])
      expect(delayDecision(task({ statusChangedAt }), { now })).toBeNull();
    expect(delayDecision(task({ statusChangedAt: '2026-09-07T06:59:59Z' }), { now }).kind).toBe(
      'analyze-delay',
    );
  });
  it('не перехватывает живой этап, отчёт и паузу, не выдаёт два действия по старому снимку', () => {
    const io = world();
    for (const extra of [
      { running: [{ taskId: '0001-source', stage: 'implement' }] },
      { reports: [{ taskId: '0001-source', stage: 'implement' }] },
      { paused: true },
      { apiPaused: true },
      { draining: true },
    ])
      expect(decision(io, extra).actions.some((a) => a.kind === 'analyze-delay')).toBe(false);
    expect(
      decision(io)
        .actions.filter((a) => a.taskId === '0001-source')
        .map((a) => a.kind),
    ).toEqual(['analyze-delay']);
  });
});

it('сохраняет видимый диагноз и две проверки в новой обязательной карточке', async () => {
  const io = world();
  await diagnose(io);
  expect(io.tasks.get('0001-source').delayAnalysis.originSince).toBe(since);
  expect(io.entries[0].what).toContain('Более 5 часов');
  expect(io.entries[0].deliveryKey).toBeTruthy();
  expect((await transfer(io, report())).result).toBe('done');
  const source = io.tasks.get('0001-source');
  expect(source.status).toBe('blocked');
  expect(source.delayAnalysis.phase).toBe('waiting');
  expect(source.delayAnalysis.diagnosis.cause).toContain('артефакт CI');
  expect(io.created).toHaveLength(1);
  expect(io.created[0].status).toBe('new');
  expect(io.created[0].blocking).toBe(true);
  expect(io.created[0].description).toContain('PR #23');
  expect(io.created[0].description).toContain('регрессионным тестом');
  expect(source.dependsOn).toEqual([io.created[0].id]);
  expect(io.entries.at(-1).what).toContain(`Ожидает выполнения карточки ${io.created[0].id}`);
  expect(io.entries.at(-1).what).toContain('Причина:');
  expect(source.links).toEqual(task().links);
  expect((await transfer(io, report())).result).toBe('done');
  expect(io.created).toHaveLength(1);
  expect(io.tasks.get(source.id).spentUsd).toBe(2);
});

it('после перезапуска сто циклов наблюдают прежний разбор без новых вызовов и комментариев', async () => {
  const io = world();
  await diagnose(io);
  await transfer(io, report());
  const item = io.tasks.get('0001-source');
  const roundtrip = parseCard(
    {
      id: '6a9084b276c945372833816f',
      name: item.title,
      pos: item.priority,
      desc: joinDescription(item.description, metaOf(item)),
      idList: 'blocked',
      idLabels: ['feature'],
    },
    {
      stateByList: new Map([['blocked', 'blocked']]),
      labelKeyById: new Map([['feature', 'feature']]),
    },
  ).task;
  io.tasks.set(item.id, roundtrip);
  const count = io.entries.length;
  for (let i = 0; i < 100; i += 1) {
    const actions = decision(io).actions.filter((a) => a.taskId === item.id);
    expect(actions).toEqual([]);
  }
  expect(io.entries).toHaveLength(count);
});

it('статус блокера меняется видимо один раз, сам блокер тоже подлежит разбору', async () => {
  const io = world();
  await diagnose(io);
  await transfer(io, report());
  const repair = io.created[0];
  io.tasks.set(repair.id, { ...repair, status: 'implement', statusChangedAt: since });
  const actions = decision(io).actions;
  expect(actions.find((a) => a.taskId === repair.id).kind).toBe('analyze-delay');
  const observation = actions.find((a) => a.taskId === '0001-source');
  expect(observation.kind).toBe('observe-delay');
  await execute([observation], io);
  expect(io.entries.at(-1).what).toContain(`${repair.id}: implement`);
  expect(decision(io).actions.some((a) => a.taskId === '0001-source')).toBe(false);
});

it('выполнение исправления запускает проверку конкретного результата, затем исходный этап', async () => {
  const io = world();
  await diagnose(io);
  await transfer(io, report());
  const repair = io.created[0];
  io.tasks.set(repair.id, { ...repair, status: 'completed' });
  const unblock = decision(io).actions.find((a) => a.taskId === '0001-source');
  expect(unblock.kind).toBe('unblock-task');
  await execute([unblock], io);
  expect(io.tasks.get('0001-source').delayAnalysis.phase).toBe('verifying');
  const done = report({
    outcome: 'done',
    requests: [],
    blockers: [],
    delayAnalysis: diagnosis({
      resolution: 'resolved',
      specificEvidence: ['Чтение артефакта PR #23 выполнено'],
      preventionEvidence: ['Регрессионный тест правил всех этапов проходит'],
      nextAction: 'Продолжить implement',
    }),
  });
  expect((await transfer(io, done)).result).toBe('done');
  const resumed = io.tasks.get('0001-source');
  expect(resumed.status).toBe('implement');
  expect(resumed.attempts).toEqual(task().attempts);
  expect(resumed.statusChangedAt).toBe(since);
  expect(io.entries.at(-1).what).toContain('Подтверждение разблокирования');
  expect(delayDecision(resumed, { now, tasks: [...io.tasks.values()] })).toBeNull();
});

it.each(['closed', 'failed', 'missing'])('не принимает %s вместо результата', async (status) => {
  const io = world();
  await diagnose(io);
  await transfer(io, report());
  const repair = io.created[0];
  if (status === 'missing') io.tasks.delete(repair.id);
  else io.tasks.set(repair.id, { ...repair, status });
  expect(decision(io).actions.some((a) => a.kind === 'unblock-task')).toBe(false);
});

it('не принимает неполное исправление и формальную проверку', async () => {
  const io = world();
  await diagnose(io);
  const current = io.tasks.get('0001-source');
  const bad = report();
  delete bad.blockers[0].preventionResult;
  expect(delayReportProblem(current, bad)).toContain('preventionResult');
  expect(
    delayReportProblem(
      current,
      report({ outcome: 'done', delayAnalysis: diagnosis({ resolution: 'resolved' }) }),
    ),
  ).toContain('доказательства');
  expect(canTransition(task({ status: 'postmortem' }), 'implement').ok).toBe(false);
});

it('после обычного ожидания переиспользует диагноз, пока существенные факты прежние', async () => {
  const io = world();
  await diagnose(io);
  await transfer(
    io,
    report({
      outcome: 'done',
      blockers: [],
      requests: [],
      delayAnalysis: diagnosis({ resolution: 'monitor' }),
    }),
  );
  const current = io.tasks.get('0001-source');
  expect(
    delayDecision(
      { ...current, history: [{ note: 'служебное' }], attempts: { continuations: 2 } },
      { now },
    ),
  ).toBeNull();
  expect(delayDecision({ ...current, description: 'Новые существенные факты' }, { now }).mode).toBe(
    'review',
  );
  const prompt = stagePrompt({
    assignment: { taskId: current.id, stage: 'postmortem' },
    task: current,
  });
  expect(prompt).toContain('specificResult');
  expect(prompt).toContain(current.delayAnalysis.diagnosis.cause);
});

it('повтор после создания исправления не создаёт вторую карточку', async () => {
  const io = world();
  await diagnose(io);
  const save = io.saveTask;
  let first = true;
  io.saveTask = async (next, entry) => {
    if (next.status === 'blocked' && first) {
      first = false;
      return { ok: false, outcome: 'offline' };
    }
    return save(next, entry);
  };
  expect((await transfer(io, report())).result).toBe('failed');
  expect(io.created).toHaveLength(1);
  expect((await transfer(io, report())).result).toBe('done');
  expect(io.created).toHaveLength(1);
  expect(io.tasks.get('0001-source').spentUsd).toBe(2);
});

it('подходящая существующая карточка получает оба критерия без дубликата', async () => {
  const repair = task({ id: '0002-repair', status: 'new', statusChangedAt: now });
  const io = world([task(), repair]);
  await diagnose(io);
  const value = report({ requests: [] });
  delete value.blockers[0].requestKey;
  value.blockers[0].taskId = repair.id;
  expect((await transfer(io, value)).result).toBe('done');
  expect(io.created).toHaveLength(0);
  expect(io.entries.find((e) => e.taskId === repair.id).what).toContain('защита от повторения');
});

it('неудачное исправление оставляет диагноз и ожидает конкретную новую доработку', async () => {
  const io = world();
  await diagnose(io);
  await transfer(io, report());
  const first = io.created[0];
  io.tasks.set(first.id, { ...first, status: 'completed' });
  await execute(
    decision(io).actions.filter((a) => a.taskId === '0001-source'),
    io,
  );
  const retry = report({
    delayAnalysis: diagnosis({
      cause: 'Разрешение добавлено только для одной оболочки, отказ воспроизведён снова',
    }),
  });
  retry.requests[0].key = 'repair-other-shell';
  retry.blockers[0].requestKey = 'repair-other-shell';
  expect((await transfer(io, retry)).result).toBe('done');
  expect(io.created).toHaveLength(2);
  expect(io.tasks.get('0001-source').status).toBe('blocked');
  expect(io.tasks.get('0001-source').delayAnalysis.diagnosis.cause).toContain(
    'отказ воспроизведён',
  );
});

it('задержка уже заблокированной карточки проверяется до нового анализа постановки', async () => {
  const dependency = task({ id: '0002-prerequisite', status: 'new', statusChangedAt: now });
  const source = task({
    status: 'blocked',
    dependsOn: [dependency.id],
    blockedContext: {
      operation: 'old',
      from: 'design',
      priority: 20,
      reasons: [{ taskId: dependency.id, reason: 'Нужна сборка', result: 'Сборка проходит' }],
    },
  });
  const io = world([source, dependency]);
  await diagnose(io);
  await transfer(
    io,
    report({
      outcome: 'done',
      requests: [],
      blockers: [],
      delayAnalysis: diagnosis({ resolution: 'monitor' }),
    }),
  );
  io.tasks.set(dependency.id, { ...dependency, status: 'completed' });
  await execute(
    decision(io).actions.filter((a) => a.taskId === source.id),
    io,
  );
  expect(io.tasks.get(source.id).delayAnalysis.phase).toBe('verifying');
  const verified = report({
    outcome: 'done',
    requests: [],
    blockers: [],
    delayAnalysis: diagnosis({
      resolution: 'resolved',
      specificEvidence: ['Исходная сборка проходит'],
      preventionEvidence: ['Общая причина исправлена и покрыта тестом'],
    }),
  });
  expect((await transfer(io, verified)).result).toBe('done');
  expect(io.tasks.get(source.id)).toMatchObject({ status: 'new', reanalysis: true });
});

it('неполный разбор виден в комментарии и не переносится бесконечно', async () => {
  const io = world();
  await diagnose(io);
  const incomplete = report({ delayAnalysis: {} });
  expect((await transfer(io, incomplete)).result).toBe('failed');
  expect(io.entries.at(-1).what).toContain('Разбор задержки не принят');
  expect(io.removed).toContain('0001-source');
  const count = io.entries.length;
  await transfer(io, incomplete);
  expect(io.entries).toHaveLength(count);
  expect(io.tasks.get('0001-source').spentUsd).toBe(2);
});

it('не перехватывает карточку другой станции и участника живой пакетной выкладки', () => {
  const io = world([task({ owner: 'other' })]);
  expect(decision(io, { machine: 'here' }).actions.some((a) => a.kind === 'analyze-delay')).toBe(
    false,
  );
  expect(
    decision(world(), {
      running: [{ taskId: '0002-lead', stage: 'deploy', batch: ['0001-source'] }],
    }).actions.some((a) => a.kind === 'analyze-delay'),
  ).toBe(false);
});

it('назначение диагностики получает захват и не меняет карточку при проигранной гонке', async () => {
  const io = world();
  io.acquire = async () => ({ ok: false, outcome: 'taken' });
  const action = decision(io).actions.find((a) => a.kind === 'analyze-delay');
  expect((await execute([action], io))[0].result).toBe('raced');
  expect(io.tasks.get('0001-source').status).toBe('implement');
  expect(io.entries).toHaveLength(0);
  io.acquire = async () => ({ ok: true });
  expect((await execute([action], io))[0].result).toBe('done');
  expect(io.tasks.get('0001-source').owner).toBe(io.machine);
});
