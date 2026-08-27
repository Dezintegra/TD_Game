import { describe, expect, it } from 'vitest';
import { DEFAULT_SLOTS, lockedSlots, planAssignments, whatToDo } from './slots.mjs';

/**
 * Проверки раскладки работ по слотам.
 *
 * Слоты и есть квота: считать нечего, слот либо свободен, либо нет. Здесь
 * проверяется, что эта простота держится и в неудобных случаях —
 * исключительный этап при занятом пуле, ревью при занятых рабочих слотах,
 * подхват за уснувшей сессией.
 */

const NOW = '2026-08-26T12:00:00+03:00';

const task = (id, over = {}) => ({
  id,
  type: 'feature',
  status: 'new',
  priority: 50,
  createdAt: '2026-08-26T10:00:00+03:00',
  ...over,
});

const perfTask = (id) =>
  task(id, { type: 'run', run: { kind: 'perf', expectation: 'не ниже порога' } });

const plan = (actions, tasks, occupancy = {}) =>
  planAssignments({ actions, tasks, occupancy, slots: DEFAULT_SLOTS, now: NOW });

describe('раскладка по слотам', () => {
  it('проработка уходит в свободный рабочий слот', () => {
    const result = plan([{ kind: 'start-stage', taskId: '0001-one', stage: 'design' }], {
      '0001-one': task('0001-one'),
    });
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0].slot).toBe('worker-1');
    expect(result.writes[0].assignment).toMatchObject({
      taskId: '0001-one',
      stage: 'design',
      branch: 'worktree-0001-one',
      sessionTitle: 'pipeline:0001-one:design',
      continuation: false,
    });
  });

  it('две работы занимают оба рабочих слота', () => {
    const result = plan(
      [
        { kind: 'start-stage', taskId: '0001-one', stage: 'design' },
        { kind: 'start-stage', taskId: '0002-two', stage: 'design' },
      ],
      { '0001-one': task('0001-one'), '0002-two': task('0002-two') },
    );
    expect(result.writes.map((write) => write.slot)).toEqual(['worker-1', 'worker-2']);
  });

  it('третья работа ждёт: слотов больше нет', () => {
    const result = plan(
      [
        { kind: 'start-stage', taskId: '0001-one', stage: 'design' },
        { kind: 'start-stage', taskId: '0002-two', stage: 'design' },
        { kind: 'start-stage', taskId: '0003-three', stage: 'design' },
      ],
      {
        '0001-one': task('0001-one'),
        '0002-two': task('0002-two'),
        '0003-three': task('0003-three'),
      },
    );
    expect(result.writes).toHaveLength(2);
    expect(result.waiting).toHaveLength(1);
    expect(result.waiting[0].taskId).toBe('0003-three');
    expect(result.waiting[0].reason).toContain('свободного слота');
  });

  it('занятый слот не переписывается', () => {
    const result = plan(
      [{ kind: 'start-stage', taskId: '0002-two', stage: 'design' }],
      { '0002-two': task('0002-two') },
      { 'worker-1': { taskId: '0001-one', stage: 'implement' } },
    );
    expect(result.writes[0].slot).toBe('worker-2');
  });
});

describe('свои слоты для ревью и одиночки', () => {
  it('ревью идёт в свой слот, не занимая рабочих', () => {
    const result = plan(
      [
        { kind: 'start-stage', taskId: '0001-one', stage: 'design' },
        { kind: 'start-stage', taskId: '0002-two', stage: 'review' },
      ],
      { '0001-one': task('0001-one'), '0002-two': task('0002-two', { status: 'pr' }) },
    );
    expect(result.writes.map((write) => write.slot)).toEqual(['worker-1', 'review']);
  });

  it('второе ревью ждёт', () => {
    const result = plan(
      [
        { kind: 'start-stage', taskId: '0001-one', stage: 'review' },
        { kind: 'start-stage', taskId: '0002-two', stage: 'review' },
      ],
      {
        '0001-one': task('0001-one', { status: 'pr' }),
        '0002-two': task('0002-two', { status: 'pr' }),
      },
    );
    expect(result.writes).toHaveLength(1);
    expect(result.waiting).toHaveLength(1);
  });

  it('замер кадров ждёт тишины во всём пуле', () => {
    const result = plan(
      [{ kind: 'start-stage', taskId: '0001-perf', stage: 'benchmark' }],
      { '0001-perf': perfTask('0001-perf') },
      { 'worker-1': { taskId: '0002-two', stage: 'design' } },
    );
    expect(result.writes).toHaveLength(0);
    expect(result.waiting[0].reason).toContain('тишины');
  });

  it('на пустом пуле замер берётся в слот одиночки', () => {
    const result = plan([{ kind: 'start-stage', taskId: '0001-perf', stage: 'benchmark' }], {
      '0001-perf': perfTask('0001-perf'),
    });
    expect(result.writes[0].slot).toBe('solo');
  });

  it('занятый слот ревью тоже мешает замеру', () => {
    const result = plan(
      [{ kind: 'start-stage', taskId: '0001-perf', stage: 'benchmark' }],
      { '0001-perf': perfTask('0001-perf') },
      { review: { taskId: '0002-two', stage: 'review' } },
    );
    expect(result.writes).toHaveLength(0);
  });
});

describe('подхват за уснувшей сессией', () => {
  it('продолжатель получает слот и помечен как продолжение', () => {
    const result = plan(
      [
        {
          kind: 'continue-stage',
          taskId: '0001-one',
          stage: 'implement',
          reason: 'молчит дольше отпущенного',
        },
      ],
      { '0001-one': task('0001-one', { status: 'implement' }) },
    );
    expect(result.writes[0].assignment).toMatchObject({
      continuation: true,
      reason: 'молчит дольше отпущенного',
      stage: 'implement',
    });
  });
});

describe('запертый слот', () => {
  const config = { cycleMinutes: 5, deadAfterMinutes: 30 };

  /** Назначение, висящее указанное число минут. */
  const assigned = (minutesAgo) => ({
    taskId: '0001-one',
    sessionTitle: 'pipeline:0001-one:design',
    assignedAt: new Date(Date.parse(NOW) - minutesAgo * 60000).toISOString(),
  });

  const session = (silentMinutes, isRunning = true) => ({
    title: 'pipeline:0001-one:design',
    isRunning,
    lastActivityAt: new Date(Date.parse(NOW) - silentMinutes * 60000).toISOString(),
  });

  it('живая работающая сессия слот не запирает', () => {
    const locked = lockedSlots({
      occupancy: { 'worker-1': assigned(60) },
      sessions: [session(1)],
      now: NOW,
      config,
    });
    expect(locked).toEqual([]);
  });

  it('свежее назначение не считается запертым, даже если сессия молчит', () => {
    const locked = lockedSlots({
      occupancy: { 'worker-1': assigned(5) },
      sessions: [session(60)],
      now: NOW,
      config,
    });
    expect(locked).toEqual([]);
  });

  it('идущая, но молчащая сессия на старом назначении запирает слот', () => {
    // Так выглядит неотвеченный запрос подтверждения: сессия жива, ничего
    // не делает и не завершится никогда.
    const locked = lockedSlots({
      occupancy: { 'worker-1': assigned(90) },
      sessions: [session(60)],
      now: NOW,
      config,
    });
    expect(locked).toHaveLength(1);
    expect(locked[0].why).toContain('запрос подтверждения');
  });

  it('завершившаяся сессия слот не запирает: это работа продолжателя', () => {
    const locked = lockedSlots({
      occupancy: { 'worker-1': assigned(90) },
      sessions: [session(60, false)],
      now: NOW,
      config,
    });
    expect(locked).toEqual([]);
  });

  it('без снимка сессий слоты запертыми не объявляются', () => {
    const locked = lockedSlots({
      occupancy: { 'worker-1': assigned(90) },
      sessions: [],
      now: NOW,
      config,
      sessionsKnown: false,
    });
    expect(locked).toEqual([]);
  });

  it('в запертый слот работа не назначается, но соседний работает', () => {
    const result = planAssignments({
      actions: [{ kind: 'start-stage', taskId: '0002-two', stage: 'design' }],
      tasks: { '0002-two': task('0002-two') },
      occupancy: {},
      slots: DEFAULT_SLOTS,
      now: NOW,
      locked: [{ slot: 'worker-1', taskId: '0001-one', why: 'сессия молчит' }],
    });
    expect(result.writes[0].slot).toBe('worker-2');
    expect(result.notes.join()).toContain('слот worker-1 заперт');
  });
});

describe('что делать проснувшемуся исполнителю', () => {
  it('пустой слот завершает сессию', () => {
    expect(whatToDo(null)).toEqual({ act: false, why: 'слот пуст' });
  });

  it('уже взятое назначение второй раз не берут', () => {
    const verdict = whatToDo({ taskId: '0001-one', startedAt: NOW });
    expect(verdict.act).toBe(false);
  });

  it('свежее назначение берут в работу', () => {
    const assignment = { taskId: '0001-one', stage: 'design' };
    expect(whatToDo(assignment)).toEqual({ act: true, why: 'есть назначение', assignment });
  });
});

describe('прочие действия слота не требуют', () => {
  it('уборка и опрос проверок мимо пула', () => {
    const result = plan(
      [
        { kind: 'cleanup', taskId: '0001-one' },
        { kind: 'poll-external', taskId: '0002-two', what: 'ci' },
        { kind: 'push-tail', scope: 'main', commits: 1 },
      ],
      { '0001-one': task('0001-one'), '0002-two': task('0002-two') },
    );
    expect(result.writes).toHaveLength(0);
    expect(result.waiting).toHaveLength(0);
  });
});
