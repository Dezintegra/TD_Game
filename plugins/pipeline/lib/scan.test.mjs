import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/defaults.mjs';
import { hasWork, scan } from './scan.mjs';
// resolveConfig уже импортирован выше — здесь он нужен и проверкам настройки.

/**
 * Проверки сканера.
 *
 * Здесь ловится всё, ради чего он и сделан счётом, а не рассуждением:
 * квоты, преимущество прогонов, исключительность замеров и распознавание
 * уснувших сессий. Ни одна проверка не заводит дерева, не порождает сессии
 * и не ходит в сеть — картина мира приходит доводом.
 */

const NOW = '2026-08-26T12:00:00+03:00';
const { config } = resolveConfig({
  commands: { verify: 'x', deploy: 'x', perf: 'x' },
  worktreeDir: '.claude/worktrees',
});

/** Задача бэклога с разумными умолчаниями. */
const task = (over = {}) => ({
  id: '0001-one',
  type: 'feature',
  status: 'new',
  returnTo: null,
  priority: 50,
  createdAt: '2026-08-26T10:00:00+03:00',
  attempts: { continuations: 0, cycleFailures: 0 },
  ...over,
});

/** Запись реестра с живой сессией. */
const entry = (taskId, over = {}) => ({
  taskId,
  branch: `worktree-${taskId}`,
  sessionTitle: `pipeline:${taskId}:design`,
  ...over,
});

/** Сессия, работавшая только что. */
const alive = (title) => ({ title, isRunning: true, lastActivityAt: '2026-08-26T11:59:00+03:00' });

/** Сессия, молчащая дольше отпущенного. */
const silent = (title) => ({ title, isRunning: true, lastActivityAt: '2026-08-26T11:00:00+03:00' });

const run = (state) => scan({ now: NOW, config, ...state });
const kinds = (result) => result.actions.map((action) => action.kind);

describe('пустая картина', () => {
  it('пустой бэклог не даёт работы', () => {
    const result = run({ tasks: [] });
    expect(result.actions).toEqual([]);
    expect(hasWork(result)).toBe(false);
  });

  it('рубильник паузы останавливает всё', () => {
    const result = run({ tasks: [task()], paused: true });
    expect(result.actions).toEqual([]);
    expect(result.notes.join()).toContain('паузы');
  });

  it('негодная запись в работу не берётся и названа', () => {
    const result = run({
      tasks: [],
      invalid: [{ id: '0009-bad', problems: ['нет поля priority'] }],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes.join()).toContain('0009-bad');
  });
});

describe('совпавшие номера задач', () => {
  // Заводятся людьми: две ветки честно считают следующий свободный номер
  // каждая по своей копии бэклога. 27.08.2026 так вышло по два 0022, 0023
  // и 0024. Работу это не ломает — идентификатор целиком уникален, — но
  // ссылка по номеру начинает указывать на два файла разом.
  it('повтор номера называется вслух', () => {
    const result = run({
      tasks: [task({ id: '0022-first' }), task({ id: '0022-second' })],
    });
    expect(result.notes.join()).toContain('номер 0022 занят дважды');
    expect(result.notes.join()).toContain('0022-first, 0022-second');
  });

  it('обе задачи всё же берутся в работу: это замечание, а не отказ', () => {
    const result = run({
      tasks: [task({ id: '0022-first' }), task({ id: '0022-second' })],
    });
    expect(kinds(result)).toEqual(['start-stage', 'start-stage']);
  });

  it('разные номера замечания не вызывают', () => {
    const result = run({ tasks: [task({ id: '0022-one' }), task({ id: '0023-two' })] });
    expect(result.notes.join()).not.toContain('занят дважды');
  });
});

describe('неполная настройка', () => {
  it('этап, который нечем закончить, не начинают', () => {
    // Без каталога рабочих деревьев проработку начинать нельзя: сессия
    // проснётся, дойдёт до заведения дерева и встанет.
    const { config: bare } = resolveConfig({ commands: {} });
    const result = scan({ now: NOW, config: bare, tasks: [task()] });
    expect(result.actions).toEqual([]);
    expect(result.notes.join()).toContain('worktreeDir');
  });

  it('нехватка команды выкладки не мешает проработке', () => {
    const { config: noDeploy } = resolveConfig({
      commands: { verify: 'x', perf: 'x' },
      worktreeDir: '.claude/worktrees',
    });
    const result = scan({ now: NOW, config: noDeploy, tasks: [task()] });
    expect(result.actions).toContainEqual({
      kind: 'start-stage',
      taskId: '0001-one',
      stage: 'design',
    });
  });

  it('арене местная команда замера не нужна', () => {
    const { config: noPerf } = resolveConfig({
      commands: { verify: 'x', deploy: 'x' },
      worktreeDir: '.claude/worktrees',
    });
    const arena = task({
      id: '0001-run',
      type: 'run',
      run: { kind: 'arena', expectation: 'ровно' },
    });
    const result = scan({ now: NOW, config: noPerf, tasks: [arena] });
    expect(result.actions).toContainEqual({
      kind: 'start-stage',
      taskId: '0001-run',
      stage: 'benchmark',
    });
  });

  it('а замеру кадров — нужна', () => {
    const { config: noPerf } = resolveConfig({
      commands: { verify: 'x', deploy: 'x' },
      worktreeDir: '.claude/worktrees',
    });
    const perf = task({
      id: '0001-perf',
      type: 'run',
      run: { kind: 'perf', expectation: 'не ниже порога' },
    });
    const result = scan({ now: NOW, config: noPerf, tasks: [perf] });
    expect(result.actions).toEqual([]);
    expect(result.notes.join()).toContain('commands.perf');
  });
});

describe('квоты', () => {
  it('две задачи в работе — третью не берём', () => {
    const result = run({
      tasks: [
        task({ id: '0001-one', status: 'design' }),
        task({ id: '0002-two', status: 'implement' }),
        task({ id: '0003-three', status: 'new' }),
      ],
      registry: { entries: [entry('0001-one'), entry('0002-two')] },
      sessions: [alive('pipeline:0001-one:design'), alive('pipeline:0002-two:design')],
    });
    expect(kinds(result)).not.toContain('start-stage');
    expect(result.notes.join()).toContain('занято 2 из 2');
  });

  it('одна в работе — вторую берём', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'design' }), task({ id: '0002-two' })],
      registry: { entries: [entry('0001-one')] },
      sessions: [alive('pipeline:0001-one:design')],
    });
    expect(result.actions).toContainEqual({
      kind: 'start-stage',
      taskId: '0002-two',
      stage: 'design',
    });
  });

  it('ожидание проверок квоту не занимает', () => {
    const result = run({
      tasks: [
        task({ id: '0001-one', status: 'pr' }),
        task({ id: '0002-two', status: 'design' }),
        task({ id: '0003-three' }),
      ],
      registry: { entries: [entry('0002-two')] },
      sessions: [alive('pipeline:0002-two:design')],
    });
    expect(result.actions).toContainEqual({
      kind: 'start-stage',
      taskId: '0003-three',
      stage: 'design',
    });
  });

  it('за раз берётся не больше, чем позволяет квота', () => {
    const result = run({
      tasks: [task({ id: '0001-one' }), task({ id: '0002-two' }), task({ id: '0003-three' })],
    });
    expect(kinds(result).filter((kind) => kind === 'start-stage')).toHaveLength(2);
  });
});

describe('преимущество прогонов', () => {
  const arena = (id, over = {}) =>
    task({ id, type: 'run', run: { kind: 'arena', expectation: 'ничего не сдвинется' }, ...over });

  it('прогон вытесняет проработку', () => {
    const result = run({ tasks: [task({ id: '0002-two', priority: 10 }), arena('0001-run')] });
    expect(result.actions).toContainEqual({
      kind: 'start-stage',
      taskId: '0001-run',
      stage: 'benchmark',
    });
    expect(result.actions).not.toContainEqual({
      kind: 'start-stage',
      taskId: '0002-two',
      stage: 'design',
    });
  });

  it('арена считается на чужом железе и квоту не занимает', () => {
    const result = run({
      tasks: [arena('0001-run'), arena('0002-run'), arena('0003-run')],
    });
    expect(kinds(result).filter((kind) => kind === 'start-stage')).toHaveLength(3);
  });

  it('замер кадров требует тишины на машине', () => {
    const perf = task({
      id: '0001-perf',
      type: 'run',
      run: { kind: 'perf', expectation: 'не ниже порога' },
    });
    const result = run({
      tasks: [perf, task({ id: '0002-two', status: 'design' })],
      registry: { entries: [entry('0002-two')] },
      sessions: [alive('pipeline:0002-two:design')],
    });
    expect(kinds(result)).not.toContain('start-stage');
    expect(result.notes.join()).toContain('тишины');
  });

  it('на свободной машине замер берётся', () => {
    const perf = task({
      id: '0001-perf',
      type: 'run',
      run: { kind: 'perf', expectation: 'не ниже порога' },
    });
    const result = run({ tasks: [perf] });
    expect(result.actions).toContainEqual({
      kind: 'start-stage',
      taskId: '0001-perf',
      stage: 'benchmark',
    });
  });
});

describe('приоритеты', () => {
  it('меньший приоритет берётся раньше', () => {
    const result = run({
      tasks: [task({ id: '0001-late', priority: 90 }), task({ id: '0002-soon', priority: 10 })],
    });
    expect(result.actions[0].taskId).toBe('0002-soon');
  });

  it('при равном приоритете раньше берётся более ранняя задача', () => {
    const result = run({
      tasks: [
        task({ id: '0001-new', createdAt: '2026-08-26T11:00:00+03:00' }),
        task({ id: '0002-old', createdAt: '2026-08-20T11:00:00+03:00' }),
      ],
    });
    expect(result.actions[0].taskId).toBe('0002-old');
  });
});

describe('уснувшие сессии', () => {
  it('живую сессию не трогают', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'design' })],
      registry: { entries: [entry('0001-one')] },
      sessions: [alive('pipeline:0001-one:design')],
    });
    expect(kinds(result)).not.toContain('continue-stage');
  });

  it('молчащей сессии назначают продолжателя', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'design' })],
      registry: { entries: [entry('0001-one')] },
      sessions: [silent('pipeline:0001-one:design')],
    });
    expect(result.actions).toContainEqual({
      kind: 'continue-stage',
      taskId: '0001-one',
      stage: 'design',
      reason: 'молчит дольше отпущенного',
    });
  });

  it('сессия, завершившаяся без отчёта, тоже получает продолжателя', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'design' })],
      registry: { entries: [entry('0001-one')] },
      sessions: [{ title: 'pipeline:0001-one:design', isRunning: false, lastActivityAt: NOW }],
    });
    expect(kinds(result)).toContain('continue-stage');
  });

  it('при готовом отчёте продолжателя не назначают', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'design' })],
      registry: { entries: [entry('0001-one')] },
      sessions: [silent('pipeline:0001-one:design')],
      reports: [{ taskId: '0001-one', stage: 'design', outcome: 'done' }],
    });
    expect(kinds(result)).not.toContain('continue-stage');
    expect(kinds(result)).toContain('transfer-report');
  });

  it('без снимка сессий продолжателей не назначают', () => {
    // Молчание не признак смерти. Продолжатель, порождённый по недоразумению,
    // посадит на одно дерево две сессии, и они перепишут работу друг друга.
    const result = run({
      tasks: [task({ id: '0001-one', status: 'design' })],
      registry: { entries: [entry('0001-one')] },
      sessions: [],
      sessionsKnown: false,
    });
    expect(kinds(result)).not.toContain('continue-stage');
    expect(result.notes.join()).toContain('снимок сессий не сделан');
  });

  it('умершая сессия ПРОГОНА тоже получает продолжателя', () => {
    // Прогон на чужом железе — класс «ожидательный», и раньше он в отбор
    // не попадал вовсе: перечислялись ресурсные, ревью и исключительные.
    // Умершая сессия прогона не подхватывалась никогда, задача стояла
    // в этапе, а слот был занят ею навсегда. 27.08.2026 задача 0002
    // простояла так почти шесть часов, и заметить это удалось только глазами.
    const result = run({
      tasks: [
        task({
          id: '0002-run',
          type: 'run',
          status: 'benchmark',
          statusChangedAt: '2026-08-26T09:00:00+03:00',
          run: { kind: 'arena', expectation: 'доли побед около равных' },
        }),
      ],
      registry: { entries: [] },
      sessions: [{ title: 'pipeline:0002-run:benchmark', isRunning: false, lastActivityAt: NOW }],
    });
    expect(kinds(result)).toContain('continue-stage');
  });

  it('прогон без дерева и без записи в реестре подхватывается', () => {
    // Дерева у задачи типа run нет по устройству маршрута, и требовать
    // запись реестра значило бы снова не подхватывать её никогда.
    const result = run({
      tasks: [
        task({
          id: '0002-run',
          type: 'run',
          status: 'benchmark',
          statusChangedAt: '2026-08-26T09:00:00+03:00',
          run: { kind: 'arena', expectation: 'доли побед около равных' },
        }),
      ],
      registry: { entries: [] },
      sessions: [],
    });
    expect(kinds(result)).toContain('continue-stage');
  });

  it('только что взятая задача продолжателя не получает', () => {
    // Исполнитель и оркестратор ходят по расписанию независимо, и между
    // взятием задачи и первым пробуждением исполнителя проходит до целого
    // интервала. Продолжатель, порождённый в эту щель, ничего не чинит,
    // зато тратит попытку — а их всего две.
    const result = run({
      tasks: [
        task({
          id: '0002-run',
          type: 'run',
          status: 'benchmark',
          statusChangedAt: '2026-08-26T11:58:00+03:00',
          run: { kind: 'arena', expectation: 'доли побед около равных' },
        }),
      ],
      registry: { entries: [] },
      sessions: [],
    });
    expect(kinds(result)).not.toContain('continue-stage');
  });

  it('исчерпанные продолжения ведут к разбору человеком', () => {
    const result = run({
      tasks: [
        task({
          id: '0001-one',
          status: 'design',
          attempts: { continuations: 2, cycleFailures: 0 },
        }),
      ],
      registry: { entries: [entry('0001-one')] },
      sessions: [silent('pipeline:0001-one:design')],
    });
    expect(kinds(result)).toContain('fail-stage');
    expect(result.notes.join()).toContain('исчерпаны');
  });
});

describe('хвосты', () => {
  it('хвост главной ветки досылается первым делом', () => {
    const result = run({ tasks: [task()], tails: { main: 2, branches: {} } });
    expect(result.actions[0]).toEqual({ kind: 'push-tail', scope: 'main', commits: 2 });
  });

  it('ветку живой сессии не отправляют', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'implement' })],
      registry: { entries: [entry('0001-one', { sessionTitle: 'pipeline:0001-one:implement' })] },
      sessions: [alive('pipeline:0001-one:implement')],
      tails: { main: 0, branches: { 'worktree-0001-one': 1 } },
    });
    expect(kinds(result)).not.toContain('push-tail');
    expect(result.notes.join()).toContain('живая сессия');
  });

  it('залипший хвост одной задачи не мешает другим', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'pr' }), task({ id: '0002-two', status: 'pr' })],
      registry: { entries: [entry('0001-one')] },
      tails: { main: 0, branches: { 'worktree-0001-one': 3 } },
      sessions: [],
    });
    expect(result.actions).toContainEqual({
      kind: 'poll-external',
      taskId: '0002-two',
      what: 'ci',
    });
    expect(result.actions).not.toContainEqual({
      kind: 'poll-external',
      taskId: '0001-one',
      what: 'ci',
    });
  });
});

describe('ожидание и уборка', () => {
  it('открытый pull request опрашивается', () => {
    const result = run({ tasks: [task({ id: '0001-one', status: 'pr' })] });
    expect(result.actions).toContainEqual({
      kind: 'poll-external',
      taskId: '0001-one',
      what: 'ci',
    });
  });

  it('задача в уборке убирается', () => {
    const result = run({ tasks: [task({ id: '0001-one', status: 'cleanup' })] });
    expect(result.actions).toContainEqual({ kind: 'cleanup', taskId: '0001-one' });
  });

  it('ответ владельца продукта возвращает задачу в работу', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'awaiting-po', returnTo: 'design' })],
      answers: { '0001-one': true },
    });
    expect(result.actions).toContainEqual({
      kind: 'answer-question',
      taskId: '0001-one',
      returnTo: 'design',
    });
  });

  it('без ответа задача продолжает ждать', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'awaiting-po', returnTo: 'design' })],
    });
    expect(result.actions).toEqual([]);
  });
});

describe('порядок действий', () => {
  it('хвост идёт раньше переноса отчёта, а взятие задачи — последним', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'design' }), task({ id: '0002-two' })],
      registry: { entries: [entry('0001-one')] },
      sessions: [alive('pipeline:0001-one:design')],
      reports: [{ taskId: '0001-one', stage: 'design', outcome: 'done' }],
      tails: { main: 1, branches: {} },
    });
    expect(kinds(result)).toEqual(['push-tail', 'transfer-report', 'start-stage']);
  });
});
