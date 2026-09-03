import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIo, summariseChecks } from './io.mjs';
import { resolveConfig } from '../config/defaults.mjs';

/**
 * Проверки сведения состояния проверок CI к одному ответу.
 *
 * Проверяется именно эта часть переходника: всё остальное в нём — склейка
 * путей и запись файлов, где ошибаться негде, а вот «зелено ли» решает,
 * начнётся ли ревью и вольётся ли pull request.
 */

const check = (name, status, conclusion) => ({ name, status, conclusion });

const rollup = (...checks) => JSON.stringify({ statusCheckRollup: checks });

describe('состояние проверок', () => {
  it('все зелёные — успех', () => {
    const state = summariseChecks(
      rollup(check('типы', 'COMPLETED', 'SUCCESS'), check('сборка', 'COMPLETED', 'SUCCESS')),
    );
    expect(state).toEqual({ state: 'success' });
  });

  it('хоть одна не завершилась — ждём', () => {
    const state = summariseChecks(
      rollup(check('типы', 'COMPLETED', 'SUCCESS'), check('матчевые тесты', 'IN_PROGRESS', null)),
    );
    expect(state.state).toBe('pending');
    expect(state.why).toContain('матчевые тесты');
  });

  it('упавшая называется по имени', () => {
    const state = summariseChecks(
      rollup(
        check('типы', 'COMPLETED', 'SUCCESS'),
        check('сквозные проверки', 'COMPLETED', 'FAILURE'),
      ),
    );
    expect(state.state).toBe('failure');
    expect(state.failed).toBe('сквозные проверки');
  });

  it('отменённая считается неуспехом, а не успехом', () => {
    const state = summariseChecks(rollup(check('сборка', 'COMPLETED', 'CANCELLED')));
    expect(state.state).toBe('failure');
  });

  it('проверок ещё нет — ждём, а не радуемся', () => {
    // Пустой перечень легко принять за «всё зелено»: ошибка, из-за которой
    // ревью началось бы на непроверенном коде.
    expect(summariseChecks(rollup()).state).toBe('pending');
  });

  it('неразобравшийся ответ не выдаётся за успех', () => {
    expect(summariseChecks('не json').state).toBe('pending');
  });

  it('пустой ответ не выдаётся за успех', () => {
    expect(summariseChecks('').state).toBe('pending');
  });
});

describe('очередь отчётов', () => {
  // Отчёты лежат в памяти супервизора, а не файлами на диске. Каталог
  // отчётов ушёл вместе со слотами: отчёт приходит выводом того самого
  // процесса, который супервизор и породил. Обходить за ним рабочие
  // деревья больше не надо — искать негде, он один.
  const { config } = resolveConfig({
    commands: { verify: 'x', deploy: 'x', perf: 'x' },
    worktreeDir: '.claude/worktrees',
  });

  const report = { taskId: '0001-one', stage: 'design', outcome: 'done' };
  const io = (reports) => createIo({ root: '/repo', config, now: 'сейчас', reports });

  it('читается по задаче и этапу', () => {
    expect(io([report]).readReport('0001-one', 'design')).toMatchObject({ outcome: 'done' });
  });

  it('отчёт о другом этапе не выдаётся за свой', () => {
    // Отчёт, посчитанный по другой картине мира, двинул бы задачу
    // неизвестно куда.
    expect(io([report]).readReport('0001-one', 'audit')).toBeNull();
  });

  it('принятый отчёт уходит из очереди', () => {
    const queue = [report];
    io(queue).removeReport('0001-one', 'design');
    expect(queue).toEqual([]);
  });

  it('снятие несуществующего отчёта не трогает чужих', () => {
    const queue = [report];
    io(queue).removeReport('0002-two', 'design');
    expect(queue).toHaveLength(1);
  });
});

describe('улики о деле этапа', () => {
  // Их спрашивают, только когда этапу в чём-то отказали: тогда решают,
  // попутный это был отказ или подрывающий. Настоящий git не зовётся ни разу.
  const { config } = resolveConfig({
    commands: { verify: 'x', deploy: 'x', perf: 'x' },
    worktreeDir: '.claude/worktrees',
  });

  const task = (over = {}) => ({ id: '0001-one', links: { run: null, pr: null }, ...over });

  /** Переходник, отвечающий заранее заготовленным, и список спрошенного. */
  function fakeIo(answers = []) {
    const asked = [];
    const queue = [...answers];
    const run = (args) => {
      asked.push(args.join(' '));
      return queue.shift() ?? { code: 0, stdout: '', stderr: '' };
    };
    return { io: createIo({ root: '/repo', config, now: 'сейчас', run }), asked };
  }

  const ok = (stdout) => ({ code: 0, stdout, stderr: '' });

  it('спрашиваются ровно три команды и ровно про свою ветку', () => {
    const { io, asked } = fakeIo([ok('a1b2c3d\n'), ok('0\n'), ok('2026-09-01T12:30:00+03:00\n')]);
    const evidence = io.stageEvidence(task());

    expect(evidence).toEqual({
      branchOnRemote: true,
      unpushed: 0,
      lastCommitAt: '2026-09-01T12:30:00+03:00',
      previousRun: null,
      previousPr: null,
    });
    expect(asked).toEqual([
      'rev-parse --verify --quiet origin/worktree-0001-one',
      'rev-list --count origin/worktree-0001-one..worktree-0001-one',
      'log -1 --format=%cI worktree-0001-one',
    ]);
  });

  it('ветки у origin нет — так и сказано, а не «git промолчал»', () => {
    // `--verify --quiet` на несуществующей ссылке даёт ненулевой код
    // и пустой поток ошибок.
    const { io } = fakeIo([{ code: 1, stdout: '', stderr: '' }]);
    expect(io.stageEvidence(task()).branchOnRemote).toBe(false);
  });

  it('отказ git — это пусто, а не отсутствие ветки', () => {
    // Слив эти случаи, мы заставили бы поломку прибора стоить этапу работы.
    const broken = { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    const { io } = fakeIo([broken, broken, broken]);
    const evidence = io.stageEvidence(task());

    expect(evidence.branchOnRemote).toBe(null);
    expect(evidence.unpushed).toBe(null);
    expect(evidence.lastCommitAt).toBe(null);
  });

  it('прежний номер прогона берётся из самой задачи', () => {
    // «Новый номер» проверяется сравнением, а не наличием.
    const { io } = fakeIo();
    const evidence = io.stageEvidence(task({ links: { run: '33428427058' } }));
    expect(evidence.previousRun).toBe('33428427058');
  });

  it('прежний номер pull request берётся из задачи и лишних команд не стоит', () => {
    // Зеркально номеру прогона: впервые открытый pull request — это тот,
    // которого задача до этапа не знала. Ни одного нового вызова git.
    const { io, asked } = fakeIo();
    const evidence = io.stageEvidence(task({ links: { run: null, pr: 124 } }));

    expect(evidence.previousPr).toBe(124);
    expect(asked).toEqual([
      'rev-parse --verify --quiet origin/worktree-0001-one',
      'rev-list --count origin/worktree-0001-one..worktree-0001-one',
      'log -1 --format=%cI worktree-0001-one',
    ]);
  });

  it('задача без ссылки на pull request даёт null, а не undefined', () => {
    const { io } = fakeIo();
    expect(io.stageEvidence({ id: '0001-one', links: {} }).previousPr).toBe(null);
  });
});

describe('коммит конвейера', () => {
  /** Переходник с подставным запускателем: настоящий git не зовётся ни разу. */
  function fakeIo(over = {}) {
    const calls = [];
    const { config } = resolveConfig({
      commands: { verify: 'x', deploy: 'x', perf: 'x' },
      worktreeDir: '.claude/worktrees',
      author: { name: 'Конвейер TD_Game', email: 'pipeline@localhost' },
    });
    const run = (args) => {
      calls.push(args);
      return over.result?.(args) ?? { code: 0, stdout: '', stderr: '' };
    };
    const io = createIo({
      root: '/repo',
      config,
      git: { push: () => ({ ok: true, failure: null }) },
      now: '2026-08-27T12:00:00+03:00',
      machine: 'станция-1',
      run,
      elapsed: () => 0,
    });
    return { io, calls, config };
  }

  const commitCall = (calls) => calls.find((args) => args.includes('commit'));

  it('подписывается именем конвейера, а не хозяина машины', () => {
    // Досылка хвоста отправляет только свои коммиты и узнаёт их по автору.
    // Пока конвейер подписывался хозяином, он объявлял чужим собственный
    // хвост и переставал писать вовсе — до вмешательства человека.
    const { io, calls } = fakeIo();
    io.commitAndPush(['manage/tasks/0001-one.json'], 'chore(backlog): проба');

    const commit = commitCall(calls);
    expect(commit).toContain('user.name=Конвейер TD_Game');
    expect(commit).toContain('user.email=pipeline@localhost');
  });

  it('коммитит только свои пути, а не весь индекс', () => {
    // Без путей `commit` забирает и то, что успела выложить в индекс
    // соседняя сессия: чужая работа уехала бы в главную ветку под нашим
    // сообщением и без окна на замечание.
    const { io, calls } = fakeIo();
    io.commitAndPush(['manage/tasks/0001-one.json', 'manage/journal/0001-one.md'], 'проба');

    const commit = commitCall(calls);
    expect(commit).toContain('--');
    expect(commit).toContain('manage/tasks/0001-one.json');
    expect(commit).toContain('manage/journal/0001-one.md');
  });

  it('дополнение коммитит журнал и только его', () => {
    // Дополняется журнал, а не описание: описание — единственное место,
    // где живёт постановка задачи, и дописывать в него из чужого разбора
    // значит однажды затереть чужую формулировку. Сама задача при этом
    // не сохраняется вовсе — ни состояния, ни очереди дополнение не трогает.
    const { io, calls } = fakeIo();
    // Запись на диск здесь ни при чём: проверяется состав коммита.
    io.appendJournal = () => {};
    io.amendTask('0002-two', 'фактура', 'chore(backlog): 0002-two дополнена');

    const commit = commitCall(calls);
    expect(commit).toContain('manage/journal/0002-two.md');
    expect(commit).not.toContain('manage/tasks/0002-two.json');
  });

  it('своя подпись входит в список своих авторов сама', () => {
    // Разъедься эти два значения — и конвейер объявит чужим собственный
    // хвост. Выводить второе из первого дешевле, чем сторожить согласие.
    const { config } = fakeIo();
    expect(config.ourAuthors).toContain('Конвейер TD_Game');
  });

  it('названные проектом авторы не теряются', () => {
    const { config } = resolveConfig({
      author: { name: 'Конвейер TD_Game' },
      ourAuthors: ['Прежнее имя'],
    });
    expect(config.ourAuthors).toEqual(['Конвейер TD_Game', 'Прежнее имя']);
  });
});

describe('заведение рабочего дерева', () => {
  /**
   * Переходник, у которого известно, какие ветки существуют.
   *
   * Настоящий git не зовётся: проверяется выбор команды, а не работа
   * самого git. Заводить ради этого репозиторий на диске значило бы
   * платить секундами за ответ, который виден в списке доводов.
   */
  function fakeIo(existingRefs = []) {
    const calls = [];
    const { config } = resolveConfig({
      commands: { verify: 'x', deploy: 'x', perf: 'x' },
      worktreeDir: '.claude/worktrees',
    });
    const run = (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') {
        return { code: existingRefs.includes(args.at(-1)) ? 0 : 1, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const io = createIo({ root: '/repo', config, now: 'сейчас', run, elapsed: () => 0 });
    return { io, calls };
  }

  const addCall = (calls) => calls.find((args) => args[0] === 'worktree');

  // Путь склеивает `join`, и на Windows он выходит с обратными косыми.
  // Писать его в проверке буквально значило бы завести тест, зелёный
  // на одной оси и красный на другой.
  const treePath = (taskId) => join('.claude/worktrees', taskId);

  it('новой задаче ветка заводится от удалённой главной', () => {
    const { io, calls } = fakeIo();
    expect(io.addWorktree('0001-one', 'worktree-0001-one').ok).toBe(true);
    expect(addCall(calls)).toEqual([
      'worktree',
      'add',
      treePath('0001-one'),
      '-b',
      'worktree-0001-one',
      'origin/main',
    ]);
  });

  it('уцелевшая местная ветка не ответвляется заново', () => {
    // Дерево сносят, а ветку оставляют — в ней невлитая работа. Пока
    // здесь стояло безусловное `-b`, git отвечал «branch already exists»,
    // и задача 0017 держала слот исполнителя двое суток.
    const { io, calls } = fakeIo(['refs/heads/worktree-0017-noise']);
    expect(io.addWorktree('0017-noise', 'worktree-0017-noise').ok).toBe(true);
    expect(addCall(calls)).toEqual([
      'worktree',
      'add',
      treePath('0017-noise'),
      'worktree-0017-noise',
    ]);
  });

  it('ветка, оставшаяся только на origin, тоже продолжается', () => {
    // Машину переустановили, местных веток нет вовсе. Ответвиться от
    // главной значило бы потерять уже отправленную работу этапа.
    const { io, calls } = fakeIo(['refs/remotes/origin/worktree-0017-noise']);
    expect(io.addWorktree('0017-noise', 'worktree-0017-noise').ok).toBe(true);
    expect(addCall(calls)).not.toContain('-b');
  });

  it('отказ git доходит до вызывающего словами', () => {
    const { io } = fakeIo();
    const failing = createIo({
      root: '/repo',
      config: resolveConfig({ worktreeDir: '.claude/worktrees' }).config,
      now: 'сейчас',
      run: (args) =>
        args[0] === 'rev-parse'
          ? { code: 1, stdout: '', stderr: '' }
          : { code: 128, stdout: '', stderr: 'fatal: каталог занят\n' },
      elapsed: () => 0,
    });
    expect(io.addWorktree('0001-one', 'worktree-0001-one').ok).toBe(true);
    expect(failing.addWorktree('0001-one', 'worktree-0001-one')).toEqual({
      ok: false,
      why: 'fatal: каталог занят',
    });
  });
});
