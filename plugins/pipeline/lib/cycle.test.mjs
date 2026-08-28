import { describe, expect, it } from 'vitest';
import { DEFAULT_SLOTS } from './slots.mjs';
import {
  budgetsAgree,
  countFailure,
  lockVerdict,
  newLock,
  refreshLock,
  shouldPause,
} from './lock.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { runCycle } from './cycle.mjs';

/**
 * Проверки цикла и замка.
 *
 * Цикл здесь ничего не исполняет — он решает и отдаёт список, — поэтому весь
 * порядок проверяется без единого настоящего коммита, дерева и сессии.
 * Ловится главным образом то, что в жизни случается редко: занятый замок,
 * взведённая пауза, чужой хвост в главной ветке, недоступная сеть.
 */

const NOW = '2026-08-26T12:00:00+03:00';

const { config: base } = resolveConfig({
  commands: { verify: 'x', deploy: 'x', perf: 'x' },
  worktreeDir: '.claude/worktrees',
});
const config = { ...base, slots: DEFAULT_SLOTS };

const task = (id, over = {}) => ({
  id,
  type: 'feature',
  status: 'new',
  returnTo: null,
  priority: 50,
  createdAt: '2026-08-26T10:00:00+03:00',
  attempts: { continuations: 0, cycleFailures: 0 },
  ...over,
});

/** Подставной git: по умолчанию хвоста нет, отставания нет и всё удаётся. */
const fakeGit = (over = {}) => ({
  tail: () => 0,
  behind: () => 0,
  fastForward: () => ({ ok: true }),
  tailAuthors: () => [],
  push: () => ({ ok: true, failure: null }),
  fetch: () => ({ ok: true, failure: null }),
  dirtyPaths: () => [],
  operationInProgress: () => false,
  rebaseOntoRemote: () => ({ ok: true, conflict: false }),
  rebaseAbort: () => true,
  ...over,
});

const cycle = (over = {}) =>
  runCycle({
    git: fakeGit(over.git),
    state: {
      tasks: [],
      invalid: [],
      registry: { entries: [] },
      reports: [],
      sessions: [],
      ...over.state,
    },
    config,
    now: NOW,
    pid: 1234,
    lock: over.lock ?? null,
    isAlive: over.isAlive,
    ourAuthors: ['Конвейер'],
    elapsed: () => 0,
  });

describe('замок', () => {
  it('свободный замок берётся', () => {
    expect(lockVerdict(null, NOW, 30).take).toBe(true);
  });

  it('свежий чужой замок не отбирается', () => {
    const held = { pid: 999, takenAt: NOW, refreshedAt: '2026-08-26T11:58:00+03:00' };
    const verdict = lockVerdict(held, NOW, 30);
    expect(verdict.take).toBe(false);
    expect(verdict.why).toContain('999');
  });

  it('брошенный замок отбирается', () => {
    const held = { pid: 999, takenAt: NOW, refreshedAt: '2026-08-26T11:00:00+03:00' };
    expect(lockVerdict(held, NOW, 30).take).toBe(true);
  });

  it('замок судят по обновлению, а не по взятию', () => {
    // Цикл идёт третий час, но подаёт признаки жизни — значит, не брошен.
    const held = { pid: 999, takenAt: '2026-08-26T09:00:00+03:00', refreshedAt: NOW };
    expect(lockVerdict(held, NOW, 30).take).toBe(false);
  });

  it('обновление не меняет времени взятия', () => {
    const lock = newLock(7, '2026-08-26T11:00:00+03:00');
    const later = refreshLock(lock, NOW);
    expect(later.takenAt).toBe('2026-08-26T11:00:00+03:00');
    expect(later.refreshedAt).toBe(NOW);
  });

  it('испорченный замок считается брошенным', () => {
    expect(lockVerdict({ pid: 9, refreshedAt: 'вчера' }, NOW, 30).take).toBe(true);
  });

  it('мёртвый процесс освобождает замок', () => {
    const held = { pid: 999, takenAt: NOW, refreshedAt: NOW };
    expect(lockVerdict(held, NOW, 30, () => false).take).toBe(true);
  });
});

describe('самозащита от бесконечных неудач', () => {
  it('одна неудача паузы не заслуживает', () => {
    expect(shouldPause(1, config).pause).toBe(false);
  });

  it('несколько подряд взводят паузу с объяснением', () => {
    const verdict = shouldPause(config.pauseAfterFailedCycles, config);
    expect(verdict.pause).toBe(true);
    expect(verdict.why).toContain('удалите файл паузы');
  });

  it('удачный цикл сбрасывает счётчик', () => {
    expect(countFailure(5, 'worked')).toBe(0);
    expect(countFailure(5, 'idle')).toBe(0);
  });

  it('считаются именно подряд идущие неудачи', () => {
    expect(countFailure(2, 'conflict')).toBe(3);
    expect(countFailure(2, 'dirty')).toBe(3);
  });
});

describe('согласованность сроков', () => {
  it('умолчания согласованы', () => {
    expect(budgetsAgree(config).ok).toBe(true);
  });

  it('бюджет отправки длиннее цикла не годится', () => {
    expect(budgetsAgree({ ...config, pushBudgetSeconds: 600 }).ok).toBe(false);
  });

  it('срок брошенности короче цикла не годится', () => {
    expect(budgetsAgree({ ...config, lockStaleMinutes: 3 }).ok).toBe(false);
  });
});

describe('цикл', () => {
  it('занятый замок останавливает цикл до всего прочего', () => {
    const result = cycle({
      lock: { pid: 999, takenAt: NOW, refreshedAt: NOW },
      state: { tasks: [task('0001-one')] },
    });
    expect(result.outcome).toBe('locked');
    expect(result.assignments).toEqual([]);
  });

  it('замок мёртвого процесса цикл не останавливает', () => {
    // Проверка живости дошла до цикла не сразу, и стоило это получаса
    // простоя: сценарий отработал, сессия не позвала `--release`, и шесть
    // пробуждений подряд отвечали «замок держит процесс», которого нет.
    const result = cycle({
      lock: { pid: 999, takenAt: NOW, refreshedAt: NOW },
      state: { tasks: [task('0001-one')] },
      isAlive: () => false,
    });
    expect(result.outcome).toBe('worked');
  });

  it('пауза останавливает цикл, но замок берётся', () => {
    const result = cycle({ state: { tasks: [task('0001-one')], paused: true } });
    expect(result.outcome).toBe('paused');
    expect(result.lock).not.toBeNull();
    expect(result.assignments).toEqual([]);
  });

  it('пустой бэклог не даёт работы', () => {
    expect(cycle().outcome).toBe('idle');
  });

  it('задача из очереди раскладывается по слотам', () => {
    const result = cycle({ state: { tasks: [task('0001-one')] } });
    expect(result.outcome).toBe('worked');
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]).toMatchObject({
      slot: 'worker',
      assignment: { taskId: '0001-one', stage: 'design' },
    });
  });
});

describe('отставшая главная ветка', () => {
  it('отставание подтягивается, и работа идёт дальше', () => {
    // Беда, найденная первым же живым прогоном: цикл делал fetch, но никогда
    // не подтягивал отставший main, и основное дерево жило состоянием своего
    // последнего ручного обновления — оркестратор не нашёл в нём даже
    // собственного плагина.
    const pulled = [];
    const result = cycle({
      git: {
        behind: () => 3,
        fastForward: () => {
          pulled.push('подтянулись');
          return { ok: true };
        },
      },
      state: { tasks: [task('0001-one')] },
    });
    expect(pulled).toEqual(['подтянулись']);
    expect(result.notes.join()).toContain('подтянулись на 3');
    expect(result.outcome).toBe('worked');
  });

  it('свой хвост досылается раньше подтягивания', () => {
    // Наоборот нельзя: ускоряющий перевод при своих неотправленных коммитах
    // не удастся, и цикл встанет на ровном месте.
    const steps = [];
    cycle({
      git: {
        tail: () => 1,
        tailAuthors: () => ['Конвейер'],
        push: () => {
          steps.push('дослали');
          return { ok: true, failure: null };
        },
        behind: () => 2,
        fastForward: () => {
          steps.push('подтянулись');
          return { ok: true };
        },
      },
      state: { tasks: [task('0001-one')] },
    });
    expect(steps).toEqual(['дослали', 'подтянулись']);
  });

  it('при неотправленном хвосте не подтягиваются вовсе', () => {
    const pulled = [];
    cycle({
      git: {
        tail: () => 1,
        tailAuthors: () => ['Ivanov Dm'],
        fastForward: () => {
          pulled.push('подтянулись');
          return { ok: true };
        },
      },
      state: { tasks: [task('0001-one')] },
    });
    expect(pulled).toEqual([]);
  });

  it('в грязном дереве не подтягиваются: чужую правку перевод унёс бы', () => {
    const result = cycle({
      git: {
        behind: () => 2,
        dirtyPaths: () => ['apps/client/src/main.ts'],
        fastForward: () => ({ ok: true }),
      },
      state: { tasks: [task('0001-one')] },
    });
    expect(result.notes.join()).toContain('посторонние изменения');
    expect(result.notes.join()).toContain('apps/client/src/main.ts');
  });
});

describe('запрет записей', () => {
  const foreignTail = {
    git: { tail: () => 1, tailAuthors: () => ['Ivanov Dm'] },
  };

  it('чужой хвост не даёт брать задачи в работу', () => {
    const result = cycle({ ...foreignTail, state: { tasks: [task('0001-one')] } });
    expect(result.assignments).toEqual([]);
    expect(result.notes.join()).toContain('Ivanov Dm');
  });

  it('но опрос проверок при чужом хвосте продолжается', () => {
    const result = cycle({
      ...foreignTail,
      state: { tasks: [task('0001-one', { status: 'pr' })] },
    });
    expect(result.actions.map((action) => action.kind)).toContain('poll-external');
  });

  it('недоступная сеть откладывает записи, а не роняет задачи', () => {
    const result = cycle({
      git: {
        tail: () => 1,
        tailAuthors: () => ['Конвейер'],
        push: () => ({ ok: false, failure: 'offline' }),
      },
      state: { tasks: [task('0001-one')] },
    });
    expect(result.assignments).toEqual([]);
    expect(result.notes.join()).toContain('сети нет');
  });

  it('свой хвост досылается, и работа идёт дальше', () => {
    const result = cycle({
      git: { tail: () => 2, tailAuthors: () => ['Конвейер', 'Конвейер'] },
      state: { tasks: [task('0001-one')] },
    });
    expect(result.outcome).toBe('worked');
    expect(result.assignments).toHaveLength(1);
  });
});
