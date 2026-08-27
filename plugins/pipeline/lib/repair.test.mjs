import { describe, expect, it } from 'vitest';
import { repairWorld } from './repair.mjs';

/**
 * Проверки исполнения починок сверки.
 *
 * Главное, что здесь стережётся: удаление не исполняется никогда, а захват
 * без дерева доводится до конца. Первое — потому что дерево это чья-то
 * работа; второе — потому что иначе задача остаётся занятой и безместной,
 * и достать её оттуда нечем.
 */

const NOW = '2026-08-27T12:00:00+03:00';

function fakeIo(over = {}) {
  const steps = [];
  const registry = new Map();
  const io = {
    now: NOW,
    steps,
    registry,
    readTask: (id) => over.tasks?.[id] ?? null,
    upsertRegistry(entry) {
      steps.push(`запись реестра ${entry.taskId} → ${entry.path}`);
      registry.set(entry.taskId, entry);
    },
    dropRegistry(id) {
      steps.push(`запись реестра ${id} снята`);
      registry.delete(id);
    },
    addWorktree(taskId, branch) {
      steps.push(`заведено дерево ${branch}`);
      return over.worktree ?? { ok: true, path: `.claude/worktrees/${taskId}` };
    },
  };
  return io;
}

const task = (over = {}) => ({ id: '0001-one', status: 'design', owner: 'станция-1', ...over });

describe('находка без действия', () => {
  it('осиротевшее дерево только называется, но не трогается', () => {
    // Дерево — это чья-то работа. Снести его вправе только уборка,
    // и только по доказанному вливанию pull request.
    const io = fakeIo();
    const [done] = repairWorld(
      [{ kind: 'report-orphan', taskId: '0009-gone', path: '.claude/worktrees/0009-gone' }],
      io,
    );
    expect(done.result).toBe('reported');
    expect(io.steps).toEqual([]);
  });

  it('неизвестная починка пропускается с причиной', () => {
    const [done] = repairWorld([{ kind: 'выдумка', taskId: '0001-one' }], fakeIo());
    expect(done.result).toBe('skipped');
    expect(done.why).toContain('выдумка');
  });
});

describe('дерево есть, записи нет', () => {
  it('дерево заносится в реестр с заголовком сессии', () => {
    const io = fakeIo({ tasks: { '0001-one': task() } });
    const [done] = repairWorld(
      [
        {
          kind: 'adopt-worktree',
          taskId: '0001-one',
          branch: 'worktree-0001-one',
          path: '.claude/worktrees/0001-one',
        },
      ],
      io,
    );
    expect(done.result).toBe('done');
    expect(io.registry.get('0001-one')).toMatchObject({
      branch: 'worktree-0001-one',
      stage: 'design',
      sessionTitle: 'pipeline:0001-one:design',
    });
  });

  it('дерево задачи, которой нет в бэклоге, в реестр не заносится', () => {
    const io = fakeIo({ tasks: {} });
    const [done] = repairWorld(
      [{ kind: 'adopt-worktree', taskId: '0009-gone', branch: 'x', path: 'y' }],
      io,
    );
    expect(done.result).toBe('skipped');
    expect(io.steps).toEqual([]);
  });
});

describe('запись есть, дерева нет', () => {
  it('запись снимается', () => {
    const io = fakeIo();
    const [done] = repairWorld([{ kind: 'drop-entry', taskId: '0001-one' }], io);
    expect(done.result).toBe('done');
    expect(io.steps).toEqual(['запись реестра 0001-one снята']);
  });
});

describe('захват без дерева', () => {
  it('дерево заводится и заносится в реестр', () => {
    // Захват — это две вещи подряд: отправленный коммит с владельцем
    // и заведённое дерево. Обрыв между ними оставляет задачу занятой,
    // но безместной, и достать её оттуда умеет только эта починка.
    const io = fakeIo({ tasks: { '0001-one': task() } });
    const [done] = repairWorld(
      [{ kind: 'finish-claim', taskId: '0001-one', branch: 'worktree-0001-one' }],
      io,
    );
    expect(done.result).toBe('done');
    expect(io.steps).toEqual([
      'заведено дерево worktree-0001-one',
      'запись реестра 0001-one → .claude/worktrees/0001-one',
    ]);
  });

  it('назначение в слот отсюда НЕ пишется', () => {
    // Работу выдаёт раскладка и только она: написать назначение отсюда
    // значило бы выдать её мимо квоты.
    const io = fakeIo({ tasks: { '0001-one': task() } });
    repairWorld([{ kind: 'finish-claim', taskId: '0001-one', branch: 'worktree-0001-one' }], io);
    expect(io.steps.filter((step) => step.includes('слот'))).toEqual([]);
  });

  it('незаведшееся дерево оставляет причину, а реестр не трогает', () => {
    const io = fakeIo({
      tasks: { '0001-one': task() },
      worktree: { ok: false, why: 'ветка уже занята' },
    });
    const [done] = repairWorld(
      [{ kind: 'finish-claim', taskId: '0001-one', branch: 'worktree-0001-one' }],
      io,
    );
    expect(done.result).toBe('failed');
    expect(done.why).toContain('ветка уже занята');
    expect(io.registry.size).toBe(0);
  });
});

describe('пачка починок', () => {
  it('неудача одной не отменяет остальных', () => {
    const io = fakeIo({ tasks: { '0001-one': task() } });
    const done = repairWorld(
      [
        { kind: 'выдумка', taskId: '0002-two' },
        { kind: 'drop-entry', taskId: '0003-three' },
      ],
      io,
    );
    expect(done.map((item) => item.result)).toEqual(['skipped', 'done']);
  });

  it('пустой перечень ничего не делает', () => {
    expect(repairWorld(undefined, fakeIo())).toEqual([]);
  });
});
