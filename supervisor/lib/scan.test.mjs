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

  it('пауза сервера останавливает всё, включая записи об отказах', () => {
    // Записи ждут, пока сервер ответит, и не теряются: очередь отказов живёт
    // у супервизора и под паузой не расходуется. Писать на доску под лежачим
    // сервером незачем — оборот под паузой к ней не обращается вовсе.
    const result = run({
      tasks: [task({ id: '0001-one', status: 'implement' })],
      apiPaused: true,
      apiFailures: [{ taskId: '0001-one', stage: 'implement', why: 'состояние 529' }],
    });
    expect(result.actions).toEqual([]);
    expect(result.notes.join()).toContain('сервер модели не отвечает');
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
    // Задача с меткой дробления: без неё первым этапом идёт анализ, которому
    // не нужно ничего, и проверка стала бы вечнозелёной.
    const { config: bare } = resolveConfig({ commands: {} });
    const result = scan({ now: NOW, config: bare, tasks: [task({ decomposed: true })] });
    expect(result.actions).toEqual([]);
    expect(result.notes.join()).toContain('worktreeDir');
  });

  it('нехватка команды выкладки не мешает проработке', () => {
    const { config: noDeploy } = resolveConfig({
      commands: { verify: 'x', perf: 'x' },
      worktreeDir: '.claude/worktrees',
    });
    const result = scan({ now: NOW, config: noDeploy, tasks: [task({ decomposed: true })] });
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

describe('непокрытые команды этапа', () => {
  /**
   * Настройка, при которой команды выкладки не проходят: ровно сегодняшняя
   * картина, только записанная короче. Открывать `ssh` в проверке нельзя —
   * это решение владельца продукта (задача 0117), и подменять его выдуманной
   * настройкой тут не приходится: проверяется сканер, а не правила.
   */
  const closed = { allow: ['Bash(gh pr:*)', 'PowerShell(gh pr:*)'], deny: [] };

  /** Та же настройка, но с открытыми командами выкладки. */
  const opened = {
    allow: [
      'Bash(ssh:*)',
      'PowerShell(ssh:*)',
      'Bash(node scripts/deploy.mjs:*)',
      'PowerShell(node scripts/deploy.mjs:*)',
      'Bash(pnpm e2e:perf:*)',
      'PowerShell(pnpm e2e:perf:*)',
    ],
    deny: [],
  };

  const deploying = (over = {}) =>
    task({ id: '0002-deploy', status: 'deploy', links: { pr: 7 }, ...over });

  it('задача в выкладке не получает сессию и не растит продолжений', () => {
    // За 02–03.09.2026 так сгорело семь задач подряд, все на одном и том же
    // `ssh … dezintegra "true"`, и каждая забрала ещё и сессию разбора.
    const result = run({
      tasks: [deploying()],
      registry: { entries: [entry('0002-deploy')] },
      permissions: closed,
    });
    expect(kinds(result)).not.toContain('continue-stage');
    expect(kinds(result)).not.toContain('fail-stage');
    expect(result.notes.join()).toContain('ждёт починок конвейера');
    expect(result.notes.join()).toContain('dezintegra "true"');
  });

  it('удержание не уводит в ошибку и при исчерпанных продолжениях', () => {
    // Ошибка потребовала бы разбора — той самой второй сессии, ради отмены
    // которой всё затеяно. А тратить продолжение не на что: сессии не было.
    const result = run({
      tasks: [deploying({ attempts: { continuations: 99, cycleFailures: 0 } })],
      registry: { entries: [entry('0002-deploy')] },
      permissions: closed,
    });
    expect(kinds(result)).not.toContain('fail-stage');
  });

  it('удержанная задача не занимает исполнителя', () => {
    // Оставь её в счёте — и она держала бы единственное место навсегда:
    // сессии нет, этап не кончается, место не освобождается. Вдобавок
    // выкладка объявлена исключительным этапом, то есть требующим тишины.
    const result = run({
      tasks: [deploying(), task({ id: '0003-next', decomposed: true })],
      registry: { entries: [entry('0002-deploy')] },
      permissions: closed,
    });
    expect(result.actions).toContainEqual({
      kind: 'start-stage',
      taskId: '0003-next',
      stage: 'design',
    });
    expect(result.notes.join()).not.toContain('исполнитель занят');
    expect(result.notes.join()).not.toContain('машина должна молчать');
  });

  it('покрытые команды ничего не меняют', () => {
    const result = run({
      tasks: [deploying()],
      registry: { entries: [entry('0002-deploy')] },
      permissions: opened,
    });
    expect(result.actions).toContainEqual({
      kind: 'continue-stage',
      taskId: '0002-deploy',
      stage: 'deploy',
      reason: 'этапу нужна сессия, живого процесса нет',
      batch: ['0002-deploy'],
    });
  });

  it('без правил разрешений никто не удержан, но это названо', () => {
    // «Не знаем, значит держим» остановило бы конвейер целиком из-за опечатки
    // в пути к файлу настройки.
    const result = run({
      tasks: [deploying()],
      registry: { entries: [entry('0002-deploy')] },
    });
    expect(kinds(result)).toContain('continue-stage');
    expect(result.notes.join()).toContain('проверить нечем');
  });

  it('без правил разрешений молчит, когда проверять было нечего', () => {
    // Строка, звучащая каждые пять минут на исправном конвейере, перестаёт
    // читаться — потому запись и сужена условием «было что проверять».
    //
    // Перечень здесь БОЕВОЙ, а не поданный доводом: проверяется ровно обычный
    // день, когда команды объявлены `review` и `deploy`, а на доске стоит
    // задача проработки (`task()` даёт статус `new`, первый этап `design`).
    // Подмена перечня доводом сделала бы пробу разговором теста с самим собой.
    const result = run({ tasks: [task()] });
    expect(result.notes.join()).not.toContain('проверить нечем');
    expect(kinds(result)).toContain('start-stage');
  });

  it('живой этап удержание не трогает', () => {
    // Командам идущей сессии судья — среда, а не сканер: вмешиваться посреди
    // работы значило бы отнимать у задачи уже начатый этап.
    const result = run({
      tasks: [deploying()],
      registry: { entries: [entry('0002-deploy')] },
      running: [{ taskId: '0002-deploy', stage: 'deploy' }],
      permissions: closed,
    });
    expect(result.notes.join()).not.toContain('ждёт починок конвейера');
  });

  it('очередная задача не берётся, если её первому этапу команды не покрыты', () => {
    // Перечень подаётся ДОВОДОМ, и это не украшение проверки. Боевой перечень
    // объявлен `review` и `deploy`, а из очереди задача уходит в `design`,
    // `benchmark` или `triage`: проверка на боевом перечне была бы
    // вечнозелёной, а снятая ветка кода её бы пережила.
    const result = run({
      tasks: [task({ decomposed: true })],
      permissions: closed,
      stageCommands: { design: ['ssh -o BatchMode=yes dezintegra "true"'] },
    });
    expect(kinds(result)).not.toContain('start-stage');
    expect(result.notes.join()).toContain('ждёт починок конвейера');
    expect(result.notes.join()).toContain('«design»');
  });

  it('этап без объявленных команд не задерживается', () => {
    // Молчание перечня значит «не проверяли», а не «всё плохо».
    const result = run({ tasks: [task()], permissions: closed, stageCommands: {} });
    expect(kinds(result)).toContain('start-stage');
    expect(result.notes.join()).not.toContain('ждёт починок конвейера');
  });
});

describe('пакетная выкладка', () => {
  /**
   * Предмет у всех задач `deploy` один — выложенный `origin/main`, — и потому
   * сессию получает одна, а перечень остальных едет с ней. 04.09.2026
   * в «Выкладке» стояло пятнадцать карточек, и по прежним правилам каждая
   * получила бы свой замер, свою пересборку образов и свою перезапись
   * точки отката.
   */
  const deploying = (id, over = {}) =>
    task({
      id,
      status: 'deploy',
      links: { pr: 7 },
      createdAt: `2026-08-26T1${id[3]}:00:00+03:00`,
      ...over,
    });
  const three = ['0002-a', '0003-b', '0004-c'];
  const registry = { entries: three.map((id) => entry(id)) };

  it('три задачи в выкладке дают одну сессию с перечнем из трёх', () => {
    const result = run({ tasks: three.map((id) => deploying(id)), registry });
    const issued = result.actions.filter((action) => action.kind === 'continue-stage');
    expect(issued).toEqual([
      {
        kind: 'continue-stage',
        taskId: '0002-a',
        stage: 'deploy',
        reason: 'этапу нужна сессия, живого процесса нет',
        batch: three,
      },
    ]);
    expect(result.notes).toContain('задача 0003-b едет в пакете выкладки с 0002-a');
    expect(result.notes).toContain('задача 0004-c едет в пакете выкладки с 0002-a');
  });

  it('ведущая — старшая по приоритету, а не по порядку на доске', () => {
    const result = run({
      tasks: [deploying('0002-a'), deploying('0003-b', { priority: 10 }), deploying('0004-c')],
      registry,
    });
    const [issued] = result.actions.filter((action) => action.kind === 'continue-stage');
    expect(issued.taskId).toBe('0003-b');
    expect(issued.batch).toEqual(['0003-b', '0002-a', '0004-c']);
  });

  it('идущая выкладка заставляет остальные ждать её, а не тесноту', () => {
    // Причина у ожидания другая, и читатель должен видеть очередь на пакет,
    // а не «свободных мест нет».
    const result = run({
      tasks: three.map((id) => deploying(id)),
      registry,
      running: [{ taskId: '0002-a', stage: 'deploy' }],
    });
    expect(kinds(result)).not.toContain('continue-stage');
    expect(result.notes).toContain('задача 0003-b ждёт: идёт пакетная выкладка 0002-a');
    expect(result.notes.join()).not.toContain('свободных мест нет');
  });

  it('исчерпавшие пределы в пакет не входят', () => {
    // Решение по ним принято выше, по общим правилам: обе уходят в разбор.
    // Перечень складывается из уже отобранных, иначе сессия выкладывала бы
    // задачу, которую сканер только что отправил в ошибку.
    const result = run({
      tasks: [
        deploying('0002-a', { attempts: { continuations: 99, cycleFailures: 0 } }),
        deploying('0003-b'),
        deploying('0004-c', { spentUsd: 1e9 }),
      ],
      registry,
    });
    const [issued] = result.actions.filter((action) => action.kind === 'continue-stage');
    expect(issued.taskId).toBe('0003-b');
    expect(issued.batch).toEqual(['0003-b']);
    // Исчерпанные продолжения ведут в разбор, потолок стоимости — в анализ
    // на дробность; для пакета важно одно: ни та, ни другая в нём не едет.
    expect(kinds(result).filter((kind) => kind === 'fail-stage')).toHaveLength(1);
    expect(kinds(result).filter((kind) => kind === 'decompose-again')).toHaveLength(1);
  });

  it('прочие этапы перечня пакета не получают', () => {
    const result = run({
      tasks: [task({ id: '0005-d', status: 'design' })],
      registry: { entries: [entry('0005-d')] },
    });
    const [issued] = result.actions.filter((action) => action.kind === 'continue-stage');
    expect(issued).not.toHaveProperty('batch');
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
      stage: 'decompose',
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

describe('маршрут из очереди', () => {
  it('новая задача идёт в анализ на дробность, а не в проработку', () => {
    const result = run({ tasks: [task({ id: '0001-one' })] });
    expect(result.actions).toContainEqual({
      kind: 'start-stage',
      taskId: '0001-one',
      stage: 'decompose',
    });
  });

  it('карточка от дробления анализ пропускает', () => {
    // Иначе каждая часть разбитой задачи проходила бы разбор на дробность,
    // которую для неё только что и проделали.
    const result = run({ tasks: [task({ id: '0001-one', decomposed: true })] });
    expect(result.actions).toContainEqual({
      kind: 'start-stage',
      taskId: '0001-one',
      stage: 'design',
    });
  });

  it('прогон и вольная запись идут прежними маршрутами', () => {
    const measuring = run({
      tasks: [
        task({ id: '0002-run', type: 'run', run: { kind: 'arena', expectation: 'ждём сдвига' } }),
      ],
    });
    expect(kinds(measuring)).toContain('start-stage');
    expect(measuring.actions.find((a) => a.kind === 'start-stage').stage).toBe('benchmark');

    const noted = run({ tasks: [task({ id: '0003-note', type: 'note' })] });
    expect(noted.actions.find((a) => a.kind === 'start-stage').stage).toBe('triage');
  });
});

describe('потолок стоимости задачи', () => {
  it('расход выше потолка отправляет на повторный анализ и называет оба числа', () => {
    // В анализ, а не в разбор ошибки: задача не сломана, она разрослась.
    const result = run({
      tasks: [task({ id: '0001-one', status: 'implement', spentUsd: 76.01 })],
      registry: { entries: [entry('0001-one')] },
    });
    const again = result.actions.find((a) => a.kind === 'decompose-again');
    expect(again).toBeDefined();
    expect(again.reason).toContain('76.01');
    expect(again.reason).toContain(String(config.maxTaskCostUsd));
    expect(kinds(result)).not.toContain('continue-stage');
    expect(kinds(result)).not.toContain('fail-stage');
  });

  it('сам анализ потолком не сторожится', () => {
    // Иначе задача, отправленная в него потолком, не смогла бы пройти тот
    // единственный этап, ради которого её туда и отправили.
    const result = run({
      tasks: [task({ id: '0001-one', status: 'decompose', spentUsd: 76.01 })],
    });
    expect(kinds(result)).toContain('continue-stage');
    expect(kinds(result)).not.toContain('decompose-again');
  });

  it('расход ниже потолка сессию не задерживает', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'implement', spentUsd: 5 })],
      registry: { entries: [entry('0001-one')] },
    });
    expect(kinds(result)).toContain('continue-stage');
  });

  it('разбор превысившей потолок задачи не запрещён', () => {
    // Иначе потолок запретил бы понимать, почему он сработал.
    const result = run({
      tasks: [task({ id: '0001-one', status: 'postmortem', spentUsd: 76.01 })],
    });
    expect(kinds(result)).toContain('continue-stage');
    expect(kinds(result)).not.toContain('decompose-again');
  });
});

describe('отказ сервера модели', () => {
  const failure = (over = {}) => ({
    taskId: '0001-one',
    stage: 'implement',
    why: 'сервер модели отказал (состояние 529); работы не было',
    ...over,
  });

  it('отказ уходит записью в задачу', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'implement' })],
      registry: { entries: [entry('0001-one')] },
      apiFailures: [failure()],
    });
    expect(result.actions).toContainEqual({
      kind: 'note-api-error',
      taskId: '0001-one',
      stage: 'implement',
      why: 'сервер модели отказал (состояние 529); работы не было',
    });
  });

  it('сессия тем же оборотом не выдаётся: две правки затёрли бы друг друга', () => {
    // Возврат продолжения и выдача сессии — две правки одной задачи, обе
    // по одному снимку доски (задача 0070). Продолжение ждёт один оборот.
    const result = run({
      tasks: [task({ id: '0001-one', status: 'implement' })],
      registry: { entries: [entry('0001-one')] },
      apiFailures: [failure()],
    });
    expect(kinds(result)).not.toContain('continue-stage');
    expect(result.notes.join()).toContain('отказе сервера');
  });

  it('отказ по задаче, которой нет в бэклоге, назван, а не записан', () => {
    const result = run({ tasks: [], apiFailures: [failure({ taskId: '0404-lost' })] });
    expect(kinds(result)).not.toContain('note-api-error');
    expect(result.notes.join()).toContain('0404-lost');
  });

  it('без отказов действия не появляется вовсе', () => {
    const result = run({
      tasks: [task({ id: '0001-one', status: 'implement' })],
      registry: { entries: [entry('0001-one')] },
    });
    expect(kinds(result)).not.toContain('note-api-error');
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

it('явное отключение денежного потолка не означает потолок в ноль', () => {
  const result = run({
    config: { ...config, maxTaskCostUsd: null },
    tasks: [task({ status: 'implement', spentUsd: 100 })],
    registry: { entries: [entry('0001-one')] },
  });
  expect(kinds(result)).toContain('continue-stage');
  expect(kinds(result)).not.toContain('decompose-again');
});

describe('бюджет тяжести Codex', () => {
  const check = (tokens, status = 'implement', limit = 100) =>
    run({
      config: { ...config, provider: 'codex', codexMaxTaskTokens: limit },
      tasks: [task({ status, spentUsd: 999 })],
      registry: { entries: [entry('0001-one')] },
      codexUsage: { '0001-one': { first: tokens - 10, resumed: 10 } },
    });
  it('суммирует сессии и отправляет на дробление ровно на границе', () => {
    expect(kinds(check(99))).toContain('continue-stage');
    const result = check(100);
    expect(result.actions.find((a) => a.kind === 'decompose-again').reason).toContain(
      '100 токенов при бюджете 100',
    );
    expect(kinds(result)).not.toContain('continue-stage');
  });
  it('допускает анализ и восстановление; null отключает только этот бюджет', () => {
    for (const status of ['decompose', 'postmortem'])
      expect(kinds(check(101, status))).not.toContain('decompose-again');
    expect(kinds(check(101, 'implement', null))).toContain('continue-stage');
  });
});
