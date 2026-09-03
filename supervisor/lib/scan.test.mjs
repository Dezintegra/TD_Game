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

/** Запись реестра рабочего дерева. */
const entry = (taskId, over = {}) => ({
  taskId,
  branch: `worktree-${taskId}`,
  path: `.claude/worktrees/${taskId}`,
  ...over,
});

const run = (state) => scan({ config, ...state });
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
      invalid: [{ id: '0009-bad', problems: ['нет поля priority'], status: 'new', flags: [] }],
    });
    expect(result.actions.some((action) => action.kind === 'start-stage')).toBe(false);
    expect(result.notes.join()).toContain('0009-bad');
  });
});

describe('негодная карточка', () => {
  const bad = (over = {}) => ({
    id: '0009-bad',
    problems: ['нет метки вида прогона'],
    status: 'new',
    flags: [],
    ...over,
  });

  it('уносится в ошибку с претензиями и состоянием возврата', () => {
    // Пока карточка стоит в очереди неотличимо от годных, её беда видна
    // только в журнале цикла — и повторяется там каждые пять минут, пока
    // кто-нибудь не заглянет. 0054 и 0062 простояли так сутки.
    const [action] = run({ invalid: [bad()] }).actions;
    expect(action).toMatchObject({
      kind: 'quarantine-card',
      taskId: '0009-bad',
      returnTo: 'new',
    });
    expect(action.problems).toEqual(['нет метки вида прогона']);
  });

  it('карточка из чужой колонки возвращается в очередь', () => {
    // Состояния у неё нет вовсе: ни в одном состоянии маршрута она не была.
    const [action] = run({ invalid: [bad({ status: null })] }).actions;
    expect(action.returnTo).toBe('new');
  });

  it('под живым этапом не трогается', () => {
    // Утащить задачу из-под работающей сессии хуже испорченного описания:
    // этап останется без задачи, а его отчёт — без места приложения.
    const result = run({
      invalid: [bad({ status: 'implement' })],
      running: [{ taskId: '0009-bad', stage: 'implement' }],
    });
    expect(result.actions.some((action) => action.kind === 'quarantine-card')).toBe(false);
    expect(result.notes.join()).toContain('унесём, когда закончится');
  });

  it('уже стоящая в карантине второго комментария не получает', () => {
    const result = run({ invalid: [bad({ status: 'failed', flags: ['unparsed'] })] });
    expect(result.actions.some((action) => action.kind === 'quarantine-card')).toBe(false);
  });

  it('в ошибке, но ещё без метки — уносится, чтобы получить пометку', () => {
    const result = run({ invalid: [bad({ status: 'failed', flags: [] })] });
    expect(result.actions.some((action) => action.kind === 'quarantine-card')).toBe(true);
  });

  it('исправленная лишается метки', () => {
    const [action] = run({ tasks: [], marked: ['0010-fixed'] }).actions;
    expect(action).toMatchObject({ kind: 'clear-card', taskId: '0010-fixed' });
  });

  it('пауза останавливает и карантин: доску конвейер тогда не правит', () => {
    const result = run({ invalid: [bad()], marked: ['0010-fixed'], paused: true });
    expect(result.actions).toEqual([]);
  });
});

describe('кандидаты ждут человека', () => {
  it('кандидата не берут в работу', () => {
    // Шлюз держится на том, что отбор смотрит только `new`. Возьмись
    // конвейер за кандидата — согласие владельца продукта перестало бы
    // что-либо значить, а он узнавал бы о работе постфактум, как раньше.
    const result = run({ tasks: [task({ id: '0001-one', status: 'candidate' })] });
    expect(result.actions).toEqual([]);
  });

  it('кандидат не мешает взять задачу из очереди', () => {
    // Кандидат не занимает ни слота, ни исполнителя, сколько бы ни лежал.
    const result = run({
      tasks: [
        task({ id: '0001-waiting', status: 'candidate' }),
        task({ id: '0002-ready', status: 'new' }),
      ],
    });
    expect(result.actions).toContainEqual(
      expect.objectContaining({ kind: 'start-stage', taskId: '0002-ready' }),
    );
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

describe('слив перед самообновлением', () => {
  it('сессий не выдаём, идущее доделываем, опросы идут', () => {
    // Новый код супервизора на диске; перезапуск ждёт «нет этапов и отчётов».
    // Выдавать сессии дальше значило бы никогда этого не дождаться.
    const result = run({
      draining: true,
      tasks: [
        task({ id: '0001-one', status: 'design' }),
        task({ id: '0002-two', status: 'new' }),
        task({ id: '0003-three', status: 'pr', links: { pr: 3 } }),
      ],
      registry: { entries: [entry('0001-one')] },
      running: [],
    });
    expect(kinds(result)).not.toContain('start-stage');
    expect(kinds(result)).not.toContain('continue-stage');
    expect(kinds(result)).toContain('poll-external');
    expect(result.notes.join()).toContain('самообновление');
  });
});

describe('исполнитель один', () => {
  it('пока задача в работе, новых не берут', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'design' }), task({ id: '0002-two', status: 'new' })],
      registry: { entries: [entry('0001-one')] },
      running: [{ taskId: '0001-one', stage: 'design' }],
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
      running: [{ taskId: '0002-two', stage: 'design' }],
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

describe('исходы осиротевших этапов', () => {
  /** Исход, каким его отдаёт супервизор: этап был, процесс кончился. */
  const orphan = (over = {}) => ({
    taskId: '0001-one',
    stage: 'implement',
    pid: 29704,
    startedAt: '2026-08-26T11:00:00+03:00',
    outcome: 'gone',
    why: 'процесс кончился сам',
    ...over,
  });

  it('исход попадает в журнал задачи отдельным действием', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'implement' })],
      registry: { entries: [entry('0001-one')] },
      orphans: [orphan()],
    });
    expect(result.actions).toContainEqual({
      kind: 'note-orphan',
      taskId: '0001-one',
      stage: 'implement',
      outcome: 'gone',
    });
  });

  it('запись делается ПЕРЕД выдачей сессии', () => {
    // Иначе причина пустого захода ложится в журнал уже после того, как
    // продолжатель порождён, и в его промпт не попадает вовсе.
    const result = run({
      tasks: [task({ id: '0001-one', status: 'implement' })],
      registry: { entries: [entry('0001-one')] },
      orphans: [orphan()],
    });
    const order = kinds(result);
    expect(order.indexOf('note-orphan')).toBeLessThan(order.indexOf('continue-stage'));
  });

  it('исход по задаче, которой нет в бэклоге, назван, а не записан', () => {
    const result = run({ tasks: [], orphans: [orphan({ taskId: '0404-lost' })] });
    expect(kinds(result)).not.toContain('note-orphan');
    expect(result.notes.join()).toContain('0404-lost');
  });

  it('без исходов действия не появляется вовсе', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'implement' })],
      registry: { entries: [entry('0001-one')] },
    });
    expect(kinds(result)).not.toContain('note-orphan');
  });
});

describe('этапы без живого процесса', () => {
  /** Живой этап: ровно то, что знает о своих детях супервизор. */
  const running = (taskId, stage) => [{ taskId, stage }];

  it('этап с живым процессом не трогают', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'design' })],
      registry: { entries: [entry('0001-one')] },
      running: running('0001-one', 'design'),
    });
    expect(kinds(result)).not.toContain('continue-stage');
  });

  it('этапу без процесса выдают сессию', () => {
    // Прежде здесь мерились три срока — молчания, «не идёт» и выдержки
    // от выдачи слота, — и каждый ловил свою разновидность недоразумения.
    // Все три существовали потому, что доступа к процессу не было. Теперь
    // вопрос один и ответ на него точный.
    const result = run({
      tasks: [task({ id: '0001-one', status: 'design' })],
      registry: { entries: [entry('0001-one')] },
      running: [],
    });
    expect(result.actions).toContainEqual({
      kind: 'continue-stage',
      taskId: '0001-one',
      stage: 'design',
      reason: 'этапу нужна сессия, живого процесса нет',
    });
  });

  /** Настройка на два места: иначе живой чужой процесс займёт единственное. */
  const roomy = { ...config, maxConcurrent: 2 };

  it('чужой живой этап своего не прикрывает', () => {
    const result = run({
      config: roomy,
      tasks: [task({ id: '0001-one', status: 'design' })],
      registry: { entries: [entry('0001-one')] },
      running: running('0002-two', 'design'),
    });
    expect(kinds(result)).toContain('continue-stage');
  });

  it('процесс прошлого этапа за нынешний не считают', () => {
    const result = run({
      config: roomy,
      tasks: [task({ id: '0001-one', status: 'audit' })],
      registry: { entries: [entry('0001-one')] },
      running: running('0001-one', 'design'),
    });
    expect(kinds(result)).toContain('continue-stage');
  });

  it('при готовом отчёте сессию не выдают', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'design' })],
      registry: { entries: [entry('0001-one')] },
      running: [],
      reports: [{ taskId: '0001-one', stage: 'design', outcome: 'done' }],
    });
    expect(kinds(result)).not.toContain('continue-stage');
    expect(kinds(result)).toContain('transfer-report');
  });

  it('этап с деревом, но без записи реестра, ждёт сверки', () => {
    // Дерево заводится вместе с записью. Нет записи — значит взятие задачи
    // оборвалось на середине, и доводит его сверка, а не выдача сессии
    // в дерево, которого может не быть.
    const result = run({
      tasks: [task({ id: '0001-one', status: 'implement' })],
      registry: { entries: [] },
      running: [],
    });
    expect(kinds(result)).not.toContain('continue-stage');
  });

  it('прогон без дерева и без записи в реестре подхватывается', () => {
    // Дерева у задачи типа run нет по устройству маршрута, и требовать
    // запись реестра значило бы не подхватывать её никогда. 27.08.2026
    // задача 0002 простояла так почти шесть часов, и заметить это удалось
    // только глазами.
    const result = run({
      tasks: [
        task({
          id: '0002-run',
          type: 'run',
          status: 'benchmark',
          run: { kind: 'arena', expectation: 'доли побед около равных' },
        }),
      ],
      registry: { entries: [] },
      running: [],
    });
    expect(kinds(result)).toContain('continue-stage');
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
      running: [],
    });
    expect(kinds(result)).toContain('fail-stage');
    expect(result.notes.join()).toContain('исчерпаны');
  });

  it('исчерпанные запуски останавливают задачу своей причиной', () => {
    // «Продолжения исчерпаны» здесь было бы прямой ложью: сессии не было
    // ни одной, и разбор пошёл бы читать её лог, которого нет. Так уже
    // погибли 0043, 0062, 0022 и 0088.
    const result = run({
      tasks: [
        task({
          id: '0001-one',
          status: 'design',
          attempts: { continuations: 0, cycleFailures: 0, spawnFailures: 3 },
        }),
      ],
      registry: { entries: [entry('0001-one')] },
      running: [],
    });
    const [stop] = result.actions.filter((action) => action.kind === 'fail-stage');

    expect(stop.reason).toContain('этап не порождается');
    expect(stop.reason).not.toContain('продолжения исчерпаны');
    expect(kinds(result)).not.toContain('continue-stage');
  });

  it('непустой, но не исчерпанный счёт запусков сессии не мешает', () => {
    const result = run({
      tasks: [
        task({
          id: '0001-one',
          status: 'design',
          attempts: { continuations: 0, cycleFailures: 0, spawnFailures: 2 },
        }),
      ],
      registry: { entries: [entry('0001-one')] },
      running: [],
    });
    expect(kinds(result)).toContain('continue-stage');
    expect(kinds(result)).not.toContain('fail-stage');
  });

  it('при занятом единственном месте сессию не просят вовсе', () => {
    // Просить и получать отказ каждые пять минут — значит наполнить журнал
    // цикла строкой, которая при исправной работе означает беду. Прочитанной
    // она после этого быть перестаёт.
    const result = run({
      tasks: [
        task({ id: '0001-one', status: 'review' }),
        task({ id: '0002-run', type: 'run', status: 'benchmark' }),
      ],
      registry: { entries: [entry('0001-one')] },
      running: [{ taskId: '0002-run', stage: 'benchmark' }],
    });
    expect(kinds(result)).not.toContain('continue-stage');
    expect(result.notes.join()).toContain('свободных мест нет');
  });

  it('единственное свободное место достаётся задаче поважнее', () => {
    // Порядок чтения бэклога основанием быть не может: 02.09.2026 задача
    // 0022 умерла на этапе review, не получив ни одной сессии, пока место
    // держал прогон арены.
    const result = run({
      tasks: [
        task({ id: '0001-idle', status: 'design', priority: 90 }),
        task({ id: '0002-hot', status: 'design', priority: 10 }),
      ],
      registry: { entries: [entry('0001-idle'), entry('0002-hot')] },
      running: [],
    });
    const asked = result.actions.filter((action) => action.kind === 'continue-stage');
    expect(asked).toHaveLength(1);
    expect(asked[0].taskId).toBe('0002-hot');
  });

  it('остановка не ждёт свободного места', () => {
    // Иначе повторился бы случай 0022: место освободилось за три минуты
    // до остановки, а остановка всё равно случилась.
    const result = run({
      tasks: [
        task({
          id: '0001-one',
          status: 'design',
          attempts: { continuations: 2, cycleFailures: 0 },
        }),
        task({ id: '0002-run', type: 'run', status: 'benchmark' }),
      ],
      registry: { entries: [entry('0001-one')] },
      running: [{ taskId: '0002-run', stage: 'benchmark' }],
    });
    expect(kinds(result)).toContain('fail-stage');
  });
});

describe('хвосты', () => {
  it('хвост главной ветки досылается первым делом', () => {
    const result = run({ tasks: [task()], tails: { main: 2, branches: {} } });
    expect(result.actions[0]).toEqual({ kind: 'push-tail', scope: 'main', commits: 2 });
  });

  it('ветку идущего этапа не отправляют', () => {
    // Неизвестно, доделан ли атомарный коммит. Прежде это выяснялось
    // по снимку сессий, теперь — прямым вопросом о живом процессе.
    const result = run({
      tasks: [task({ id: '0001-one', status: 'implement' })],
      registry: { entries: [entry('0001-one')] },
      running: [{ taskId: '0001-one', stage: 'implement' }],
      tails: { main: 0, branches: { 'worktree-0001-one': 1 } },
    });
    expect(kinds(result)).not.toContain('push-tail');
    expect(result.notes.join()).toContain('идёт этап');
  });

  it('залипший хвост одной задачи не мешает другим', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'pr' }), task({ id: '0002-two', status: 'pr' })],
      registry: { entries: [entry('0001-one')] },
      tails: { main: 0, branches: { 'worktree-0001-one': 3 } },
      running: [],
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

describe('возврат из ошибки по вине конвейера', () => {
  const fallen = (recovery, over = {}) =>
    task({ id: '0041-one', status: 'failed', returnTo: 'implement', recovery, ...over });
  const fix = (status) => task({ id: '0091-fix', status, type: 'feature' });
  const returned = { kind: 'return-task', taskId: '0041-one', returnTo: 'implement' };

  it('чинить нечего — возвращается ближайшим оборотом', () => {
    // Работа цела, причина в конвейере и снята: решения в подъёме нет,
    // одна задержка. 02.09.2026 так стояли пять задач с pull request.
    const result = run({ tasks: [fallen({ causedBy: 'pipeline', fixedBy: [], returns: 0 })] });
    expect(result.actions).toContainEqual({ ...returned, fixedBy: [] });
  });

  it('пока починка не закрыта, задача ждёт, и журнал цикла называет, чего', () => {
    const result = run({
      tasks: [
        fallen({ causedBy: 'pipeline', fixedBy: ['0091-fix'], returns: 0 }),
        fix('implement'),
      ],
    });
    expect(kinds(result)).not.toContain('return-task');
    expect(result.notes.join()).toContain('ждёт починок конвейера: 0091-fix (implement)');
  });

  it('закрытая починка возвращает задачу', () => {
    const result = run({
      tasks: [fallen({ causedBy: 'pipeline', fixedBy: ['0091-fix'], returns: 1 }), fix('closed')],
    });
    expect(result.actions).toContainEqual({ ...returned, fixedBy: ['0091-fix'] });
  });

  it('починка в карантине — не закрыта, ждём', () => {
    // Негодная карточка не читается задачей, но она есть — и может быть
    // исправлена и доведена. Считать её закрытой значило бы вернуть задачу
    // на ту же причину.
    const result = run({
      tasks: [fallen({ causedBy: 'pipeline', fixedBy: ['0091-fix'], returns: 0 })],
      invalid: [{ id: '0091-fix', problems: ['нет метки типа'], status: 'failed', flags: [] }],
    });
    expect(kinds(result)).not.toContain('return-task');
    expect(result.notes.join()).toContain('0091-fix (не разобрана)');
  });

  it('починки, которой нет нигде, не ждут: она закрыта и убрана', () => {
    // Идентификатор проверен при разборе, и исчезнуть иначе он не мог.
    const result = run({
      tasks: [fallen({ causedBy: 'pipeline', fixedBy: ['0091-fix'], returns: 0 })],
    });
    expect(result.actions).toContainEqual({ ...returned, fixedBy: ['0091-fix'] });
  });

  it('причина в задаче или без вердикта — конвейер не трогает', () => {
    for (const recovery of [
      { causedBy: 'task', fixedBy: [], returns: 0 },
      { causedBy: null, fixedBy: [], returns: 2 },
      undefined,
    ]) {
      const result = run({ tasks: [fallen(recovery)] });
      expect(result.actions, JSON.stringify(recovery)).toEqual([]);
    }
  });

  it('без состояния возврата возвращать некуда, и это названо', () => {
    const result = run({
      tasks: [fallen({ causedBy: 'pipeline', fixedBy: [], returns: 0 }, { returnTo: null })],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes.join()).toContain('возвращать некуда');
  });

  it('пауза останавливает и возврат', () => {
    const result = run({
      tasks: [fallen({ causedBy: 'pipeline', fixedBy: [], returns: 0 })],
      paused: true,
    });
    expect(result.actions).toEqual([]);
  });
});

describe('порядок действий', () => {
  it('хвост идёт раньше переноса отчёта', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'design' }), task({ id: '0002-two' })],
      registry: { entries: [entry('0001-one')] },
      running: [{ taskId: '0001-one', stage: 'design' }],
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
