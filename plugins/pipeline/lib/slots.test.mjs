import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SLOTS,
  lockedSlots,
  planAssignments,
  staleAssignments,
  unclaimedSlots,
  whatToDo,
} from './slots.mjs';

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

describe('раскладка по единственному слоту', () => {
  it('работа уходит в исполнителя', () => {
    const result = plan([{ kind: 'start-stage', taskId: '0001-one', stage: 'design' }], {
      '0001-one': task('0001-one'),
    });
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0].slot).toBe('worker');
    expect(result.writes[0].assignment).toMatchObject({
      taskId: '0001-one',
      stage: 'design',
      branch: 'worktree-0001-one',
      sessionTitle: 'pipeline:0001-one:design',
      continuation: false,
    });
  });

  it('вторая работа ждёт: исполнитель один', () => {
    const result = plan(
      [
        { kind: 'start-stage', taskId: '0001-one', stage: 'design' },
        { kind: 'start-stage', taskId: '0002-two', stage: 'design' },
      ],
      { '0001-one': task('0001-one'), '0002-two': task('0002-two') },
    );
    expect(result.writes.map((write) => write.slot)).toEqual(['worker']);
    expect(result.waiting).toHaveLength(1);
    expect(result.waiting[0].taskId).toBe('0002-two');
    expect(result.waiting[0].reason).toContain('свободного слота');
  });

  it('занятый слот не переписывается', () => {
    const result = plan(
      [{ kind: 'start-stage', taskId: '0002-two', stage: 'design' }],
      { '0002-two': task('0002-two') },
      { worker: { taskId: '0001-one', stage: 'implement' } },
    );
    expect(result.writes).toHaveLength(0);
    expect(result.waiting).toHaveLength(1);
  });

  it('ревью идёт к тому же исполнителю', () => {
    // Своего слота у ревью больше нет: он был нужен, чтобы замечания к чужому
    // коду не делили место с работой. Делить теперь не с кем.
    const result = plan([{ kind: 'start-stage', taskId: '0002-two', stage: 'review' }], {
      '0002-two': task('0002-two', { status: 'pr' }),
    });
    expect(result.writes[0].slot).toBe('worker');
  });

  it('замер кадров идёт туда же и тишины не ждёт', () => {
    // Правила «исключительный этап ждёт тишины во всём пуле» больше нет:
    // исполнитель один, и тишина при нём — свойство устройства.
    const result = plan([{ kind: 'start-stage', taskId: '0001-perf', stage: 'benchmark' }], {
      '0001-perf': perfTask('0001-perf'),
    });
    expect(result.writes[0].slot).toBe('worker');
  });

  it('замер кадров при занятом исполнителе просто ждёт', () => {
    const result = plan(
      [{ kind: 'start-stage', taskId: '0001-perf', stage: 'benchmark' }],
      { '0001-perf': perfTask('0001-perf') },
      { worker: { taskId: '0002-two', stage: 'design' } },
    );
    expect(result.writes).toHaveLength(0);
    expect(result.waiting).toHaveLength(1);
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
      occupancy: { worker: assigned(60) },
      sessions: [session(1)],
      now: NOW,
      config,
    });
    expect(locked).toEqual([]);
  });

  it('свежее назначение не считается запертым, даже если сессия молчит', () => {
    const locked = lockedSlots({
      occupancy: { worker: assigned(5) },
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
      occupancy: { worker: assigned(90) },
      sessions: [session(60)],
      now: NOW,
      config,
    });
    expect(locked).toHaveLength(1);
    expect(locked[0].why).toContain('запрос подтверждения');
  });

  it('завершившаяся сессия слот не запирает: это работа продолжателя', () => {
    const locked = lockedSlots({
      occupancy: { worker: assigned(90) },
      sessions: [session(60, false)],
      now: NOW,
      config,
    });
    expect(locked).toEqual([]);
  });

  it('без снимка сессий слоты запертыми не объявляются', () => {
    const locked = lockedSlots({
      occupancy: { worker: assigned(90) },
      sessions: [],
      now: NOW,
      config,
      sessionsKnown: false,
    });
    expect(locked).toEqual([]);
  });

  it('в запертый слот работа не назначается, и соседнего больше нет', () => {
    // Прежде тут проверялось, что работа уходит в соседний слот. Соседа
    // не стало вместе с параллельностью, и запертый слот теперь означает
    // остановку конвейера до вмешательства человека — потому он и назван
    // вслух, а не просто пропущен.
    const result = planAssignments({
      actions: [{ kind: 'start-stage', taskId: '0002-two', stage: 'design' }],
      tasks: { '0002-two': task('0002-two') },
      occupancy: {},
      slots: DEFAULT_SLOTS,
      now: NOW,
      locked: [{ slot: 'worker', taskId: '0001-one', why: 'сессия молчит' }],
    });
    expect(result.writes).toEqual([]);
    expect(result.waiting).toHaveLength(1);
    expect(result.notes.join()).toContain('слот worker заперт');
  });
});

describe('продолжатель возвращается в свой слот', () => {
  const held = (taskId, stage) => ({
    taskId,
    stage,
    sessionTitle: `pipeline:${taskId}:${stage}`,
    assignedAt: NOW,
    startedAt: NOW,
  });

  it('задача, занимающая слот, получает его же, а не ждёт свободного', () => {
    // Иначе продолжатель не находил слота никогда: единственный подходящий
    // занят самой этой задачей, и она ждала бы освобождения от самой себя.
    const result = planAssignments({
      actions: [{ kind: 'continue-stage', taskId: '0002-two', stage: 'design' }],
      tasks: { '0002-two': task('0002-two', { status: 'design' }) },
      occupancy: { worker: held('0002-two', 'design') },
      slots: DEFAULT_SLOTS,
      now: NOW,
    });
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0].slot).toBe('worker');
    expect(result.waiting).toEqual([]);
  });

  it('невзятое назначение вторым не перебивают', () => {
    // Пока `startedAt` нет, работа просто не дошла до своего пробуждения.
    // Выдать поверх второе назначение значит сжечь попытку продолжения
    // впустую — а их две. Так и сгорели 0005 и 0006: два продолжения
    // подряд, ни одного взявшего их исполнителя, задача остановлена
    // «за исчерпанием продолжений», которых на деле не было ни одного.
    const notTaken = {
      taskId: '0002-two',
      stage: 'design',
      sessionTitle: 'pipeline:0002-two:design',
      assignedAt: NOW,
    };
    const result = planAssignments({
      actions: [{ kind: 'continue-stage', taskId: '0002-two', stage: 'design' }],
      tasks: { '0002-two': task('0002-two', { status: 'design' }) },
      occupancy: { worker: notTaken },
      slots: DEFAULT_SLOTS,
      now: NOW,
    });
    expect(result.writes).toEqual([]);
    expect(result.waiting[0].reason).toContain('ещё не взято');
  });

  it('взятое назначение продолжателем перебить можно', () => {
    // Здесь сессия была и кончилась — перезапись назначения и есть починка.
    const result = planAssignments({
      actions: [{ kind: 'continue-stage', taskId: '0002-two', stage: 'design' }],
      tasks: { '0002-two': task('0002-two', { status: 'design' }) },
      occupancy: { worker: held('0002-two', 'design') },
      slots: DEFAULT_SLOTS,
      now: NOW,
    });
    expect(result.writes[0].slot).toBe('worker');
  });

  it('новое назначение не несёт отметки о взятии — в этом и починка', () => {
    // Исполнитель пропускает назначение с `startedAt`; перезапись снимает
    // отметку, и ближайшее пробуждение берёт работу как новую.
    const result = planAssignments({
      actions: [{ kind: 'continue-stage', taskId: '0002-two', stage: 'benchmark' }],
      tasks: {
        '0002-two': task('0002-two', {
          type: 'run',
          status: 'benchmark',
          run: { kind: 'arena', expectation: 'ждём равенства' },
        }),
      },
      occupancy: { worker: held('0002-two', 'benchmark') },
      slots: DEFAULT_SLOTS,
      now: NOW,
    });
    expect(result.writes[0].slot).toBe('worker');
    expect(result.writes[0].assignment.startedAt).toBeUndefined();
    expect(result.writes[0].assignment.continuation).toBe(true);
  });
});

describe('назначение, которого никто не берёт', () => {
  const config = { cycleMinutes: 5, deadAfterMinutes: 30 };

  const lying = (minutesAgo, over = {}) => ({
    taskId: '0008-eight',
    stage: 'benchmark',
    assignedAt: new Date(Date.parse(NOW) - minutesAgo * 60000).toISOString(),
    ...over,
  });

  it('свежее назначение поводом для тревоги не считается', () => {
    // Исполнитель ходит раз в пять минут, и до первого пробуждения
    // назначение лежит нетронутым совершенно законно.
    expect(unclaimedSlots({ occupancy: { worker: lying(4) }, now: NOW, config })).toEqual([]);
  });

  it('пролежавшее несколько циклов называется вслух', () => {
    // Так 27.08.2026 задача 0008 пролежала восемьдесят минут в слоте
    // выключенного исполнителя, сожгла обе попытки на пустых продолжениях
    // и была остановлена «за исчерпанием». Со стороны это выглядело
    // как занятый слот, то есть как честная очередь.
    const [found] = unclaimedSlots({ occupancy: { worker: lying(80) }, now: NOW, config });
    expect(found.slot).toBe('worker');
    expect(found.taskId).toBe('0008-eight');
    expect(found.why).toContain('задача планировщика выключена');
  });

  it('взятое назначение не считается невзятым, сколько бы ни лежало', () => {
    const occupancy = { worker: lying(80, { startedAt: NOW }) };
    expect(unclaimedSlots({ occupancy, now: NOW, config })).toEqual([]);
  });

  it('пустой слот не считается', () => {
    expect(unclaimedSlots({ occupancy: { worker: null }, now: NOW, config })).toEqual([]);
  });
});

describe('назначение, разошедшееся с бэклогом', () => {
  const held = (taskId, stage) => ({
    taskId,
    stage,
    sessionTitle: `pipeline:${taskId}:${stage}`,
    assignedAt: NOW,
  });

  it('задача ушла с этапа — слот освобождается', () => {
    // Так и завис worker на закрытой 0001: перенос отчёта оборвался
    // на заведении задач по заявкам, слота не снял, и пул простоял три часа.
    const stale = staleAssignments({
      occupancy: { worker: held('0001-one', 'benchmark') },
      tasks: { '0001-one': task('0001-one', { status: 'closed' }) },
    });
    expect(stale).toHaveLength(1);
    expect(stale[0].slot).toBe('worker');
    expect(stale[0].why).toContain('closed');
  });

  it('задача стоит на своём этапе — назначение годно', () => {
    const stale = staleAssignments({
      occupancy: { worker: held('0001-one', 'benchmark') },
      tasks: { '0001-one': task('0001-one', { status: 'benchmark' }) },
    });
    expect(stale).toEqual([]);
  });

  it('задачи вовсе нет в бэклоге — слот освобождается', () => {
    const stale = staleAssignments({
      occupancy: { worker: held('0009-gone', 'design') },
      tasks: {},
    });
    expect(stale).toHaveLength(1);
    expect(stale[0].why).toContain('нет в бэклоге');
  });

  it('пустой слот разошедшимся не считается', () => {
    expect(staleAssignments({ occupancy: { worker: null }, tasks: {} })).toEqual([]);
  });

  it('запертый слот не освобождается: там сессия числится идущей', () => {
    // Снять назначение значило бы выдать слот второй сессии, которая всё
    // равно не запустится — незавершённый прогон не даёт начать следующий.
    const stale = staleAssignments({
      occupancy: { worker: held('0001-one', 'design') },
      tasks: { '0001-one': task('0001-one', { status: 'closed' }) },
      locked: [{ slot: 'worker', taskId: '0001-one', why: 'сессия молчит' }],
    });
    expect(stale).toEqual([]);
  });

  it('освобождённый слот достаётся работе в том же цикле', () => {
    // Иначе слот простоял бы до следующего пробуждения — пять минут впустую.
    const result = planAssignments({
      actions: [{ kind: 'start-stage', taskId: '0002-two', stage: 'design' }],
      tasks: { '0002-two': task('0002-two') },
      occupancy: { worker: held('0001-one', 'benchmark') },
      slots: DEFAULT_SLOTS,
      now: NOW,
      stale: [{ slot: 'worker', taskId: '0001-one', why: 'задача уже в «closed»' }],
    });
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0].slot).toBe('worker');
    expect(result.notes.join()).toContain('слот worker освобождён');
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
