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

  it('задача с повторяющимся номером всё же берётся: это замечание, а не отказ', () => {
    const result = run({
      tasks: [task({ id: '0022-first' }), task({ id: '0022-second' })],
    });
    expect(kinds(result)).toEqual(['start-stage']);
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

describe('исполнитель один', () => {
  it('пока задача в работе, новых не берут', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'design' }), task({ id: '0002-two', status: 'new' })],
      registry: { entries: [entry('0001-one')] },
      sessions: [alive('pipeline:0001-one:design')],
    });
    expect(kinds(result)).not.toContain('start-stage');
    expect(result.notes.join()).toContain('исполнитель занят');
  });

  it('ожидание проверок исполнителя не занимает', () => {
    // Задача в `pr` ждёт чужого железа, сессии ей не нужно, и держать
    // за неё исполнителя значило бы простаивать всё время прогона CI.
    const result = run({
      tasks: [task({ id: '0001-one', status: 'pr' }), task({ id: '0002-two' })],
    });
    expect(result.actions).toContainEqual({
      kind: 'start-stage',
      taskId: '0002-two',
      stage: 'design',
    });
  });

  it('ожидание ответа владельца продукта тоже не занимает', () => {
    const result = run({
      tasks: [
        task({ id: '0001-one', status: 'awaiting-po', returnTo: 'design' }),
        task({ id: '0002-two' }),
      ],
    });
    expect(kinds(result)).toContain('start-stage');
  });

  it('за раз берётся ровно одна задача', () => {
    // Прежде бралось столько, сколько позволяли квоты, а ожидательные
    // этапы не занимали ни одной — и сканер запускал прогоны пачками при
    // одном слоте. Лишние вставали в этапе без сессии и через полчаса
    // объявлялись мёртвыми: за ночь 27–28.08.2026 так сгорело семнадцать
    // задач.
    const result = run({
      tasks: [task({ id: '0001-one' }), task({ id: '0002-two' }), task({ id: '0003-three' })],
    });
    expect(kinds(result).filter((kind) => kind === 'start-stage')).toHaveLength(1);
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

  it('прогоны арены идут по одному, а не пачкой', () => {
    // Это и есть цена одного исполнителя, названная вслух. Прежде все три
    // уходили в работу разом — потому что арена считается на чужом железе
    // и квоты не занимала, — а слот был один, и двум из трёх сессии
    // не доставалось вовсе.
    const result = run({
      tasks: [arena('0001-run'), arena('0002-run'), arena('0003-run')],
    });
    expect(kinds(result).filter((kind) => kind === 'start-stage')).toHaveLength(1);
  });

  it('замер кадров при занятом исполнителе просто ждёт', () => {
    // Тишина на машине больше не правило, а свойство устройства: рядом
    // с замером просто некому шуметь.
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
    expect(result.notes.join()).toContain('исполнитель занят');
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

  it('давно завершившаяся сессия получает продолжателя', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'design' })],
      registry: { entries: [entry('0001-one')] },
      sessions: [
        {
          title: 'pipeline:0001-one:design',
          isRunning: false,
          lastActivityAt: '2026-08-26T11:00:00+03:00',
        },
      ],
    });
    expect(kinds(result)).toContain('continue-stage');
  });

  it('только что закончившая ход сессия продолжателя НЕ получает', () => {
    // Признак «не идёт» ненадёжен на коротком промежутке: снимок ловит
    // сессию между ходами. 27.08.2026 оркестратор объявил сессию по 0005
    // завершившейся за двадцать пять секунд ДО её же последней активности —
    // прогон арены при этом спокойно досчитался, а задача успела сгореть.
    const result = run({
      tasks: [task({ id: '0001-one', status: 'design' })],
      registry: { entries: [entry('0001-one')] },
      sessions: [{ title: 'pipeline:0001-one:design', isRunning: false, lastActivityAt: NOW }],
    });
    expect(kinds(result)).not.toContain('continue-stage');
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

  describe('этап без сессии: слот отличает начало от смерти', () => {
    // Запись реестра заводится вместе с деревом и при смене этапа
    // НЕ обновляется: и заголовок сессии, и отметка `lastSeenAt` остаются
    // от прежнего этапа. Поймано 28.08.2026 в первый живой прогон по доске —
    // задача переехала в аудит в 12:05, а отметка осталась от проработки,
    // 05:06. Верить ей нельзя ни в одном из случаев ниже.
    const stale = (taskId) =>
      entry(taskId, {
        sessionTitle: `pipeline:${taskId}:design`,
        lastSeenAt: '2026-08-26T05:00:00+03:00',
      });

    const justMoved = (over = {}) =>
      task({
        id: '0001-one',
        status: 'audit',
        statusChangedAt: '2026-08-26T11:56:00+03:00',
        ...over,
      });

    /** Слот, выданный под нынешний этап минуты назад. */
    const slot = (over = {}) => ({
      worker: {
        taskId: '0001-one',
        stage: 'audit',
        assignedAt: '2026-08-26T11:58:00+03:00',
        ...over,
      },
    });

    it('слота нет — этап начинают немедленно, не выжидая получаса', () => {
      // Первую сессию нового этапа выдаёт этот же путь: `start-stage` бывает
      // только у задач из очереди. Пока выдержка отмерялась от смены
      // состояния, каждый этап после первого начинался на полчаса позже.
      const result = run({
        tasks: [justMoved()],
        registry: { entries: [stale('0001-one')] },
        sessions: [],
      });
      expect(result.actions).toContainEqual({
        kind: 'continue-stage',
        taskId: '0001-one',
        stage: 'audit',
        reason: 'сессии нет',
      });
    });

    it('слот выдан, исполнитель ещё не проснулся — второго не шлют', () => {
      const result = run({
        tasks: [justMoved()],
        registry: { entries: [stale('0001-one')] },
        sessions: [],
        occupancy: slot(),
      });
      expect(kinds(result)).not.toContain('continue-stage');
    });

    it('слот выдан давно, а сессии так и нет — продолжателя шлют', () => {
      const result = run({
        tasks: [justMoved()],
        registry: { entries: [stale('0001-one')] },
        sessions: [],
        occupancy: slot({ assignedAt: '2026-08-26T09:00:00+03:00' }),
      });
      expect(kinds(result)).toContain('continue-stage');
    });

    it('отметка проснувшегося исполнителя важнее выдачи слота', () => {
      // Слот выдан давно, но исполнитель взялся за работу только что.
      const result = run({
        tasks: [justMoved()],
        registry: { entries: [stale('0001-one')] },
        sessions: [],
        occupancy: slot({
          assignedAt: '2026-08-26T09:00:00+03:00',
          startedAt: '2026-08-26T11:58:00+03:00',
        }),
      });
      expect(kinds(result)).not.toContain('continue-stage');
    });

    it('слот от ПРОШЛОГО этапа за начатую работу не считают', () => {
      const result = run({
        tasks: [justMoved()],
        registry: { entries: [stale('0001-one')] },
        sessions: [],
        occupancy: slot({ stage: 'design' }),
      });
      expect(kinds(result)).toContain('continue-stage');
    });

    it('живую сессию нового этапа находят, хотя в реестре заголовок старый', () => {
      const result = run({
        tasks: [justMoved()],
        registry: { entries: [stale('0001-one')] },
        sessions: [alive('pipeline:0001-one:audit')],
      });
      expect(kinds(result)).not.toContain('continue-stage');
    });
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
      sessions: [
        {
          title: 'pipeline:0002-run:benchmark',
          isRunning: false,
          lastActivityAt: '2026-08-26T11:00:00+03:00',
        },
      ],
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
    //
    // «Взята» — значит слот ей уже выдан, и обстановка обязана это отражать.
    // Прежде слот здесь не задавался: сканер его не видел вовсе и отмерял
    // выдержку от смены состояния. Из-за этого та же обстановка описывала
    // разом два несовместимых случая — взятую задачу и только начавшийся
    // этап, которого никто не берёт, — и второй молча ждал полчаса.
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
      occupancy: {
        worker: {
          taskId: '0002-run',
          stage: 'benchmark',
          assignedAt: '2026-08-26T11:58:00+03:00',
        },
      },
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
  it('хвост идёт раньше переноса отчёта', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'design' }), task({ id: '0002-two' })],
      registry: { entries: [entry('0001-one')] },
      sessions: [alive('pipeline:0001-one:design')],
      reports: [{ taskId: '0001-one', stage: 'design', outcome: 'done' }],
      tails: { main: 1, branches: {} },
    });
    // Взятия новой задачи здесь нет и быть не должно: исполнитель занят
    // задачей 0001, и освободится он не раньше, чем её отчёт перенесут.
    expect(kinds(result)).toEqual(['push-tail', 'transfer-report']);
  });

  it('взятие задачи идёт последним', () => {
    const result = run({
      tasks: [task({ id: '0002-two' })],
      tails: { main: 1, branches: {} },
    });
    expect(kinds(result)).toEqual(['push-tail', 'start-stage']);
  });
});
