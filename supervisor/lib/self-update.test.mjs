import { describe, expect, it } from 'vitest';
import { judgeSelfUpdate } from './self-update.mjs';

/**
 * Проверки самообновления.
 *
 * Настоящий git не запускается ни разу: подставной отвечает заранее
 * известным, и потому проверяются ровно те ходы, которые в жизни редки
 * и дороги — чужая ветка в основном дереве, грязное дерево, живой этап
 * в момент, когда код уже сменился.
 */

const LOADED = 'aaaa';
const FRESH = 'bbbb';

/** Подставной git: по умолчанию код актуален, дерево чисто и на main. */
function fakeGit(over = {}) {
  const calls = [];
  // `null` здесь — проверяемый ответ «git не ответил», а не отсутствие
  // умолчания, поэтому наличие ключа проверяется явно.
  const git = {
    treeOf: () => ('tree' in over ? over.tree : LOADED),
    aheadOn: () => ('ahead' in over ? over.ahead : 0),
    currentBranch: () => over.branch ?? 'main',
    dirtyPaths: () => over.dirty ?? [],
    fastForward: () => {
      calls.push('fast-forward');
      // После подтягивания дерево инструмента меняется — если так задано.
      if (over.afterPull !== undefined) git.treeOf = () => over.afterPull;
      return over.pull ?? { ok: true };
    },
    ...over.git,
  };
  return { git, calls };
}

const judge = (over = {}, git = fakeGit()) =>
  judgeSelfUpdate({
    git: git.git,
    ownDir: 'supervisor',
    mainBranch: 'main',
    loadedTree: LOADED,
    ...over,
  });

describe('когда обновляться нечему', () => {
  it('выключено настройкой', () => {
    expect(judge({ enabled: false }).verdict).toBe('off');
  });

  it('в тени код не подтягивается', () => {
    const { verdict, notes } = judge({ dryRun: true });
    expect(verdict).toBe('off');
    expect(notes.join()).toContain('в тени');
  });

  it('инструмент вне репозитория — обновлять нечем', () => {
    expect(judge({ ownDir: null }).verdict).toBe('off');
  });

  it('код актуален — тишина в журнале', () => {
    const { verdict, notes } = judge();
    expect(verdict).toBe('current');
    expect(notes).toEqual([]);
  });

  it('git не отвечает — сверять нечем, и это названо', () => {
    expect(judge({}, fakeGit({ tree: null })).verdict).toBe('unknown');
    expect(judge({ loadedTree: null }).verdict).toBe('unknown');
    expect(judge({}, fakeGit({ ahead: null })).verdict).toBe('unknown');
  });
});

describe('удалённая ветка ушла вперёд по инструменту', () => {
  it('чистое дерево на main подтягивается и перезапускается', () => {
    const git = fakeGit({ ahead: 2, afterPull: FRESH });
    const { verdict, notes } = judge({}, git);
    expect(git.calls).toEqual(['fast-forward']);
    expect(verdict).toBe('restart');
    expect(notes.join()).toContain('подтянулись');
    expect(notes.join()).toContain('перезапускаюсь');
  });

  it('чужая ветка в основном дереве — код не трогаем, причина названа', () => {
    // Ускоряющий перевод лёг бы на ветку, куда человек переключил дерево руками.
    const git = fakeGit({ ahead: 1, branch: 'worktree-proba' });
    const { verdict, notes } = judge({}, git);
    expect(verdict).toBe('blocked');
    expect(git.calls).toEqual([]);
    expect(notes.join()).toContain('«worktree-proba»');
  });

  it('грязное дерево — код не трогаем, посторонние пути названы', () => {
    const git = fakeGit({ ahead: 1, dirty: ['supervisor/lib/scan.mjs'] });
    const { verdict, notes } = judge({}, git);
    expect(verdict).toBe('blocked');
    expect(git.calls).toEqual([]);
    expect(notes.join()).toContain('supervisor/lib/scan.mjs');
  });

  it('несостоявшийся перевод — причина из git в журнале', () => {
    const git = fakeGit({ ahead: 1, pull: { ok: false, why: 'Not possible to fast-forward' } });
    const { verdict, notes } = judge({}, git);
    expect(verdict).toBe('blocked');
    expect(notes.join()).toContain('Not possible to fast-forward');
  });

  it('подтянулись, а инструмент не изменился — перезапуска нет', () => {
    const git = fakeGit({ ahead: 1, afterPull: LOADED });
    const { verdict, notes } = judge({}, git);
    expect(verdict).toBe('current');
    expect(notes.join()).toContain('не изменился');
  });
});

describe('код на диске уже сменился', () => {
  it('ручной git pull замечается без подтягивания', () => {
    // Человек подтянул сам либо закоммитил локально: хеш дерева другой,
    // и спрашивать удалённую ветку незачем.
    const git = fakeGit({ tree: FRESH });
    const { verdict } = judge({}, git);
    expect(verdict).toBe('restart');
    expect(git.calls).toEqual([]);
  });

  it('живой этап откладывает перезапуск, и журнал говорит, чего ждём', () => {
    const { verdict, notes } = judge({ running: 1 }, fakeGit({ tree: FRESH }));
    expect(verdict).toBe('wait');
    expect(notes.join()).toContain('идёт этапов 1');
  });

  it('неперенесённый отчёт откладывает перезапуск: перезапуск его потерял бы', () => {
    const { verdict, notes } = judge({ pending: 2 }, fakeGit({ tree: FRESH }));
    expect(verdict).toBe('wait');
    expect(notes.join()).toContain('отчётов ждёт переноса 2');
  });

  it('незакоммиченная правка хеша не меняет и перезапуска не вызывает', () => {
    // Дерево грязное, а `HEAD:supervisor` прежний: человек работает,
    // и удалённая ветка при этом не ушла вперёд.
    const git = fakeGit({ dirty: ['supervisor/lib/scan.mjs'] });
    expect(judge({}, git).verdict).toBe('current');
  });
});
