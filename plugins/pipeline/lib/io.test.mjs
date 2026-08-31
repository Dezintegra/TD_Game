import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('выписка задачи рядом со слотом', () => {
  // Тут в кои-то веки важна именно запись файлов: выписка существует затем,
  // чтобы исполнителю НЕ приходилось открывать бэклог. Осиротев, она станет
  // вторым источником правды — тем самым, из-за которого всё и затевалось.
  let root;
  const { config } = resolveConfig({
    commands: { verify: 'x', deploy: 'x', perf: 'x' },
    worktreeDir: '.claude/worktrees',
  });

  const io = () => createIo({ root, config, now: '2026-08-28T12:00:00+03:00' });
  const at = (name) => join(root, config.paths.local, 'slots', name);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pipeline-brief-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('несёт задачу и журнал', () => {
    io().writeBrief('worker', {
      task: { id: '0001-one', status: 'design' },
      journal: '## было и стало',
      board: [{ id: '0002-two', status: 'review' }],
    });

    expect(JSON.parse(readFileSync(at('worker.task.json'), 'utf8'))).toMatchObject({
      id: '0001-one',
      status: 'design',
    });
    expect(readFileSync(at('worker.journal.md'), 'utf8')).toBe('## было и стало');
    expect(JSON.parse(readFileSync(at('worker.board.json'), 'utf8'))).toEqual([
      { id: '0002-two', status: 'review' },
    ]);
  });

  it('пустой журнал — это пустой файл, а не отсутствие файла', () => {
    // Иначе исполнитель не отличит «журнала нет» от «выписку не сняли»
    // и полезет искать правду сам.
    io().writeBrief('worker', { task: { id: '0001-one' } });
    expect(existsSync(at('worker.journal.md'))).toBe(true);
    expect(readFileSync(at('worker.journal.md'), 'utf8')).toBe('');
  });

  it('умирает вместе со слотом', () => {
    const world = io();
    world.writeBrief('worker', { task: { id: '0001-one' }, journal: 'журнал' });
    world.writeSlot('worker', { taskId: '0001-one', stage: 'design' });

    world.clearSlot('worker');

    expect(existsSync(at('worker.json'))).toBe(false);
    expect(existsSync(at('worker.task.json'))).toBe(false);
    expect(existsSync(at('worker.journal.md'))).toBe(false);
    expect(existsSync(at('worker.board.json'))).toBe(false);
  });

  it('чужой слот освобождением не задевается', () => {
    const world = io();
    world.writeBrief('worker', { task: { id: '0001-one' } });
    world.writeBrief('solo', { task: { id: '0002-two' } });

    world.clearSlot('worker');

    expect(existsSync(at('solo.task.json'))).toBe(true);
  });
});

describe('отчёт, положенный в рабочем дереве', () => {
  // Прочитать мало — принятый отчёт надо ещё и убрать, причём оттуда же,
  // откуда взяли. Не убранный лёг бы вторым переносом на следующем цикле,
  // а задача к тому времени уже ушла бы с этапа: перенос отчёта о чужом
  // этапе роняет её в ошибку.
  let root;
  const { config } = resolveConfig({
    commands: { verify: 'x', deploy: 'x', perf: 'x' },
    worktreeDir: '.claude/worktrees',
  });

  const TREE = '.claude/worktrees/0001-one';
  const io = () => createIo({ root, config, now: '2026-08-29T12:00:00+03:00' });
  const reportIn = (dir) => join(root, dir, '.pipeline', 'reports', '0001-one-design.json');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pipeline-report-'));
    const dir = join(root, TREE, '.pipeline', 'reports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '0001-one-design.json'),
      JSON.stringify({ taskId: '0001-one', stage: 'design', outcome: 'done' }),
    );
    mkdirSync(join(root, '.pipeline'), { recursive: true });
    writeFileSync(
      join(root, '.pipeline', 'registry.json'),
      JSON.stringify({ entries: [{ taskId: '0001-one', path: TREE }] }),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('читается по записи реестра', () => {
    expect(io().readReport('0001-one', 'design')).toMatchObject({ outcome: 'done' });
  });

  it('убирается оттуда же, где лежал', () => {
    io().removeReport('0001-one', 'design');
    expect(existsSync(reportIn(TREE))).toBe(false);
  });

  it('без записи реестра остаётся ненайденным', () => {
    writeFileSync(join(root, '.pipeline', 'registry.json'), JSON.stringify({ entries: [] }));
    expect(io().readReport('0001-one', 'design')).toBeNull();
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
