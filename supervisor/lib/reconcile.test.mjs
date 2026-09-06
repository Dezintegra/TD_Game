import { describe, expect, it } from 'vitest';
import { parseWorktrees, reconcile } from './reconcile.mjs';

/**
 * Проверки сверки реестра с действительностью.
 *
 * Взятие задачи в работу рвётся на любом шаге, и каждый обрывок здесь
 * назван отдельным случаем. Особое внимание — чужой задаче: доводить чужой
 * захват до конца нельзя, иначе две станции возьмутся за одно.
 */

const MACHINE = 'станция-1';

const task = (id, over = {}) => ({
  id,
  type: 'feature',
  status: 'implement',
  owner: MACHINE,
  ...over,
});

const tree = (id) => ({ path: `.claude/worktrees/${id}`, branch: `worktree-${id}` });
const manualTree = (name) => ({ path: `.claude/worktrees/${name}`, branch: `worktree-${name}` });
const entry = (id) => ({ taskId: id, branch: `worktree-${id}`, path: `.claude/worktrees/${id}` });

const run = (over = {}) =>
  reconcile({
    registry: { entries: [] },
    worktrees: [],
    tasks: [],
    machine: MACHINE,
    ...over,
  });

const kinds = (result) => result.repairs.map((repair) => repair.kind);

describe('разбор списка деревьев', () => {
  it('основное дерево в расчёт не идёт', () => {
    const text = [
      'worktree C:/src/dezintegra/TD_Game',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree C:/src/dezintegra/TD_Game/.claude/worktrees/0001-one',
      'HEAD def',
      'branch refs/heads/worktree-0001-one',
      '',
    ].join('\n');
    const trees = parseWorktrees(text);
    expect(trees).toHaveLength(1);
    expect(trees[0].branch).toBe('worktree-0001-one');
  });

  it('пустой вывод — пусто', () => {
    expect(parseWorktrees('')).toEqual([]);
  });
});

describe('согласованная картина', () => {
  it('дерево и запись на месте — чинить нечего', () => {
    const result = run({
      tasks: [task('0001-one')],
      worktrees: [tree('0001-one')],
      registry: { entries: [entry('0001-one')] },
    });
    expect(result.repairs).toEqual([]);
  });
});

describe('обрывки взятия задачи', () => {
  it('дерево без записи усыновляется', () => {
    const result = run({ tasks: [task('0001-one')], worktrees: [tree('0001-one')] });
    expect(result.repairs).toContainEqual({
      kind: 'adopt-worktree',
      taskId: '0001-one',
      path: '.claude/worktrees/0001-one',
      branch: 'worktree-0001-one',
    });
  });

  it('идентификатор с дефисом на конце — своё дерево, а не чужое', () => {
    // Идентификатор режется на сорока знаках и может оборваться на дефисе,
    // как у 0088-razreshit-konveyeru-komandy-zamera-pnpm-. Шаблон без такого
    // допуска считал дерево чужим: запись снималась каждый оборот, взятие
    // «доводилось» на существующий каталог, а задача молча не получала
    // сессии (02.09.2026).
    const id = '0088-razreshit-konveyeru-komandy-zamera-pnpm-';
    const result = run({ tasks: [task(id)], worktrees: [tree(id)] });
    expect(kinds(result)).toEqual(['adopt-worktree']);
  });

  it('запись без дерева снимается', () => {
    const result = run({ tasks: [task('0001-one')], registry: { entries: [entry('0001-one')] } });
    expect(kinds(result)).toEqual(['drop-entry']);
  });

  it('захваченная задача без дерева доводится до конца', () => {
    const result = run({ tasks: [task('0001-one')] });
    expect(result.repairs).toContainEqual({
      kind: 'finish-claim',
      taskId: '0001-one',
      branch: 'worktree-0001-one',
    });
    expect(result.notes.join()).toContain('доводим взятие до конца');
  });

  it('обрыв не заводит второго дерева', () => {
    const result = run({ tasks: [task('0001-one')], worktrees: [tree('0001-one')] });
    expect(kinds(result)).not.toContain('finish-claim');
  });
});

describe('чужого не трогаем', () => {
  it('дерево чужой задачи только называется, а не убирается', () => {
    const result = run({
      tasks: [task('0001-one', { owner: 'станция-2' })],
      worktrees: [tree('0001-one')],
    });
    expect(kinds(result)).toEqual(['report-orphan']);
    expect(result.repairs[0].why).toContain('станция-2');
  });

  it('чужую задачу без дерева не подхватываем', () => {
    const result = run({ tasks: [task('0001-one', { owner: 'станция-2' })] });
    expect(result.repairs).toEqual([]);
  });

  it('дерево закрытой задачи называется человеку, а не сносится', () => {
    const result = run({
      tasks: [task('0001-one', { status: 'closed' })],
      worktrees: [tree('0001-one')],
    });
    expect(kinds(result)).toEqual(['report-orphan']);
    expect(result.repairs[0].why).toContain('closed');
  });

  it('дерево задачи, которой нет в бэклоге, называется человеку', () => {
    const result = run({ worktrees: [tree('0009-ghost')] });
    expect(kinds(result)).toEqual(['report-orphan']);
    expect(result.repairs[0].why).toContain('нет в бэклоге');
  });

  it('сверка вообще не умеет предлагать удаление дерева', () => {
    const result = run({ worktrees: [tree('0009-ghost')] });
    expect(JSON.stringify(result)).not.toContain('cleanup-worktree');
  });

  it('ветка не по образцу конвейера не трогается', () => {
    const result = run({
      worktrees: [{ path: '.claude/worktrees/ручная-работа', branch: 'моя-ветка' }],
    });
    expect(result.repairs).toEqual([]);
  });

  it('ручное дерево с той же приставкой не трогается', () => {
    // Приставку `worktree-` носят и деревья, заведённые человеком вручную:
    // так устроен штатный способ их заводить. Отличает конвейерные деревья
    // строгий вид идентификатора — четыре цифры и имя строчными.
    const result = run({
      worktrees: [manualTree('islands-probe'), manualTree('tempo-window')],
    });
    expect(result.repairs).toEqual([]);
  });

  it('дерево, в котором писался сам конвейер, тоже не трогается', () => {
    const result = run({ worktrees: [manualTree('agent-backlog-pipeline')] });
    expect(result.repairs).toEqual([]);
  });
});
