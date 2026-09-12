import { describe, expect, it } from 'vitest';
import { scan } from './scan.mjs';
import { emptyScheduling, recordLaunch } from './scheduling.mjs';
import { resolveConfig } from '../config/defaults.mjs';

const now = '2026-09-12T20:00:00Z';
const { config } = resolveConfig({
  maxConcurrent: 2,
  commands: { verify: 'x', deploy: 'x', perf: 'x' },
  worktreeDir: '.claude/worktrees',
});
const task = (id, workKind, over = {}) => ({
  id,
  type: 'feature',
  status: 'new',
  workKind,
  workReason: workKind === 'game' ? 'Улучшение управления игрока' : 'Починка доставки',
  priority: workKind === 'service' ? 1 : 100,
  createdAt: now,
  statusChangedAt: now,
  attempts: { continuations: 0, cycleFailures: 0 },
  ...over,
});
const game = (id, over) => task(id, 'game', over);
const service = (id, over) => task(id, 'service', over);
const run = (tasks, over = {}) =>
  scan({
    tasks,
    config,
    now,
    stageCommands: {},
    registry: { entries: tasks.map((item) => ({ taskId: item.id, path: 'test-worktree' })) },
    ...over,
  });
const launches = (result) =>
  result.actions.filter((item) => ['start-stage', 'continue-stage'].includes(item.kind));

describe('единый выбор игровой и служебной работы', () => {
  it('чередует первые запуски при непрерывном притоке обслуживания', () => {
    let memory = emptyScheduling();
    let tasks = [1, 2, 3].flatMap((i) => [service(`00${i}0-service`), game(`00${i}1-game`)]);
    const order = [];
    for (let index = 0; index < 6; index++) {
      const selected = launches(run(tasks, { scheduling: JSON.parse(JSON.stringify(memory)) }));
      expect(selected).toHaveLength(1);
      const action = selected[0];
      const chosen = tasks.find((item) => item.id === action.taskId);
      expect(action.scheduling.selectedAt).toBe(now);
      expect(action.selectionReason).toContain('следующий первый запуск');
      memory = recordLaunch(memory, { ...chosen, scheduling: action.scheduling }, now);
      order.push(chosen.workKind);
      tasks = tasks.filter((item) => item.id !== chosen.id);
    }
    expect(order).toEqual(['game', 'service', 'game', 'service', 'game', 'service']);
  });
  it('новая игровая карточка не ждёт всей очереди служебных продолжений', () => {
    const tasks = [
      service('0001-old', { status: 'design' }),
      service('0002-old', { status: 'audit' }),
      game('0003-new'),
    ];
    const selected = launches(run(tasks));
    expect(selected).toHaveLength(2);
    expect(selected).toContainEqual(
      expect.objectContaining({ kind: 'start-stage', taskId: '0003-new' }),
    );
  });
  it('защищает продолжение игры при живом служебном процессе', () => {
    const tasks = [
      service('0001-live', { status: 'design' }),
      service('0002-old', { status: 'audit' }),
      game('0003-old', { status: 'implement' }),
    ];
    const selected = launches(run(tasks, { running: [{ taskId: '0001-live', stage: 'design' }] }));
    expect(selected).toEqual([
      expect.objectContaining({
        kind: 'continue-stage',
        taskId: '0003-old',
        selectionReason: expect.stringContaining('защищено место'),
      }),
    ]);
  });
  it('служебные продолжения не замораживают ход новых карточек перед готовой игрой', () => {
    const tasks = [
      service('0001-old', { status: 'design' }),
      service('0002-old', { status: 'audit' }),
      service('0003-new'),
      game('0004-new'),
    ];
    let memory = { ...emptyScheduling(), next: 'service' };
    const selected = launches(run(tasks, { scheduling: memory }));
    const first = selected.find((item) => item.kind === 'start-stage');
    expect(first.taskId).toBe('0003-new');
    memory = recordLaunch(memory, { ...tasks[2], scheduling: first.scheduling }, now);
    const next = launches(
      run(
        tasks.filter((item) => item.id !== first.taskId),
        { scheduling: memory },
      ),
    );
    expect(next[0]).toMatchObject({ kind: 'start-stage', taskId: '0004-new' });
  });
  it('недоступная игровая задача не простаивает место и сохраняет игровой следующий ход', () => {
    let memory = emptyScheduling();
    const tasks = [
      game('0001-held', { dependsOn: ['0009-missing'] }),
      game('0002-candidate', { status: 'candidate' }),
      service('0003-fix'),
    ];
    const [action] = launches(run(tasks, { scheduling: memory }));
    expect(action.taskId).toBe('0003-fix');
    memory = recordLaunch(memory, { ...tasks[2], scheduling: action.scheduling }, now);
    expect(memory.next).toBe('game');
    const result = launches(run([game('0001-held'), service('0004-fix')], { scheduling: memory }));
    expect(result[0].taskId).toBe('0001-held');
  });
  it('не объявляет самостоятельный прогон игровой карточкой и не даёт ему первенства', () => {
    const tasks = [
      service('0001-run', {
        type: 'run',
        categories: ['balance'],
        run: { kind: 'arena', expectation: 'Измерить' },
      }),
      game('0002-game'),
    ];
    expect(launches(run(tasks))[0].taskId).toBe('0002-game');
  });
  it('одна выбранная исключительная работа ждёт тишины и не запускается рядом с игрой', () => {
    const tasks = [
      service('0001-deploy', { status: 'deploy' }),
      game('0002-live', { status: 'design' }),
      service('0003-other', { status: 'design' }),
    ];
    expect(launches(run(tasks, { running: [{ taskId: '0002-live', stage: 'design' }] }))).toEqual(
      [],
    );
    const done = launches(run([tasks[0], tasks[2]]));
    expect(done).toHaveLength(1);
    expect(done[0].taskId).toBe('0001-deploy');
  });
  it('не расходует очередь при повреждённом журнале', () => {
    const result = run([game('0001-game'), service('0002-service')], {
      scheduling: { error: 'повреждён scheduling.json' },
    });
    expect(launches(result)).toEqual([]);
    expect(result.notes.join()).toContain('повреждён scheduling.json');
  });
});
