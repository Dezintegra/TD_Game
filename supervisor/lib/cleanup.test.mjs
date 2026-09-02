import { describe, expect, it } from 'vitest';
import { cleanup, mayCleanup } from './cleanup.mjs';

/**
 * Проверки уборки.
 *
 * Это единственное место конвейера, которое удаляет, и проверяется здесь
 * ровно одно: удаление происходит только там, где влитость ДОКАЗАНА, и не
 * происходит нигде больше. Отдельно — что недоделанная уборка не теряет
 * сведений о том, что осталось дочистить.
 */

const task = (over = {}) => ({
  id: '0001-one',
  status: 'cleanup',
  links: { change: null, pr: 50, run: null, related: [] },
  ...over,
});

const entry = {
  taskId: '0001-one',
  branch: 'worktree-0001-one',
  path: '.claude/worktrees/0001-one',
};

describe('когда убирать можно', () => {
  it('влитый pull request разрешает уборку', () => {
    const verdict = mayCleanup({ task: task(), entry, pr: { state: 'merged' }, unpushed: 0 });
    expect(verdict.verdict).toBe('proceed');
  });

  it('вливание со сжатием не мешает уборке', () => {
    // Хеши при сжатии не сохраняются, и коммитов ветки в удалённой нет
    // поимённо. Прежняя формулировка заперла бы уборку навсегда.
    const verdict = mayCleanup({ task: task(), entry, pr: { state: 'merged' }, unpushed: 3 });
    expect(verdict.verdict).toBe('proceed');
    expect(verdict.why).toContain('сжатии');
  });
});

describe('когда убирать нельзя', () => {
  it('невлитый pull request останавливает задачу', () => {
    const verdict = mayCleanup({ task: task(), entry, pr: { state: 'open' }, unpushed: 0 });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.why).toContain('не влит');
  });

  it('закрытый без вливания тоже останавливает', () => {
    const verdict = mayCleanup({ task: task(), entry, pr: { state: 'closed' }, unpushed: 0 });
    expect(verdict.verdict).toBe('fail');
  });

  it('недоступное состояние — подождать, а не сносить', () => {
    const verdict = mayCleanup({ task: task(), entry, pr: { state: 'unknown' }, unpushed: 0 });
    expect(verdict.verdict).toBe('wait');
  });

  it('задача без pull request не убирается молча', () => {
    const verdict = mayCleanup({
      task: task({ links: { change: null, pr: null, run: null, related: [] } }),
      entry,
      pr: { state: 'merged' },
      unpushed: 0,
    });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.why).toContain('без pull request');
  });

  it('дерева нет — убирать нечего', () => {
    expect(mayCleanup({ task: task(), entry: null, pr: {}, unpushed: 0 }).verdict).toBe('skip');
  });
});

/** Подставной мир уборки: каждый шаг можно заставить отказать. */
const io = (over = {}) => {
  const dropped = [];
  return {
    dropped,
    removeWorktree: () => over.worktree ?? { ok: true },
    deleteBranch: () => over.local ?? { ok: true },
    deleteRemoteBranch: () => over.remote ?? { ok: true },
    dropRegistry: (id) => dropped.push(id),
  };
};

describe('уборка', () => {
  it('удачная уборка снимает запись реестра последней', () => {
    const world = io();
    const result = cleanup({ task: task(), entry, io: world });
    expect(result.finished).toBe(true);
    expect(world.dropped).toEqual(['0001-one']);
    expect(result.done.at(-1)).toContain('реестра');
  });

  it('занятый каталог не теряет записи реестра', () => {
    // Под Windows удаление дерева порой отказывает. Снять запись при этом
    // нельзя: следующий цикл не найдёт, что дочищать.
    const world = io({ worktree: { ok: false, why: 'каталог занят' } });
    const result = cleanup({ task: task(), entry, io: world });
    expect(result.finished).toBe(false);
    expect(world.dropped).toEqual([]);
    expect(result.left.join()).toContain('каталог занят');
  });

  it('недоделанная уборка называет ровно то, что осталось', () => {
    const world = io({ remote: { ok: false, why: 'ветки уже нет' } });
    const result = cleanup({ task: task(), entry, io: world });
    expect(result.done).toContain('дерево удалено');
    expect(result.left.join()).toContain('удалённая ветка');
  });
});
