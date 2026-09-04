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

/** Задача, у которой pull request не заводился вовсе: закрытая по moot. */
const noPr = () => task({ links: { change: null, pr: null, run: null, related: [] } });

describe('когда убирать можно', () => {
  it('влитый pull request разрешает уборку', () => {
    const verdict = mayCleanup({ task: task(), entry, pr: { state: 'merged' }, unpushed: 0 });
    expect(verdict.verdict).toBe('proceed');
  });

  it('пустая ветка задачи без pull request разрешает уборку', () => {
    // Так приходит задача, закрытая по снятому предмету: она ушла в уборку
    // прямо из проработки, pull request ей не заводили, и терять в ветке
    // нечего.
    const verdict = mayCleanup({
      task: noPr(),
      entry,
      pr: { state: 'unknown' },
      unpushed: 0,
      ownCommits: 0,
    });
    expect(verdict.verdict).toBe('proceed');
    expect(verdict.why).toContain('нет своей работы');
  });

  it('пустая ветка не разрешает уборку там, где pull request заведён', () => {
    // Мерок две, и границу задаёт наличие pull request, а не удобство случая.
    // Содержимое ветки подтверждения влитости не заменяет и не ослабляет:
    // при вливании со сжатием ветка пуста относительно главной и у невлитой
    // задачи тоже.
    const verdict = mayCleanup({
      task: task(),
      entry,
      pr: { state: 'open' },
      unpushed: 0,
      ownCommits: 0,
    });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.why).toContain('не влит');
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

  it('в ветке без pull request лежит работа — не убираем', () => {
    // Опасение здесь одно: несделанная работа в дереве. Проверяется оно
    // прямо, содержимым ветки, а не тем, как задача сюда попала.
    const verdict = mayCleanup({
      task: noPr(),
      entry,
      pr: { state: 'unknown' },
      unpushed: 0,
      ownCommits: 2,
    });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.why).toContain('2');
  });

  it('содержимое ветки узнать не удалось — не убираем', () => {
    // Удаление необратимо, и неизвестность толкуется в пользу сохранности.
    // Ноль и «не знаю» здесь разные ответы, и слив их, мы дали бы поломке
    // прибора сносить чужие ветки.
    const verdict = mayCleanup({
      task: noPr(),
      entry,
      pr: { state: 'unknown' },
      unpushed: 0,
      ownCommits: null,
    });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.why).toContain('узнать не удалось');
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
