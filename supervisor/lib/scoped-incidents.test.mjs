import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/defaults.mjs';
import { incidentPolicy, incidentFromReport } from './pipeline-incidents.mjs';
import { scan } from './scan.mjs';
import { emptyScheduling } from './scheduling.mjs';
import { sortCards } from './validate-card.mjs';

const now = '2026-09-14T01:00:00Z';
const config = resolveConfig({
  maxConcurrent: 2,
  worktreeDir: 'trees',
  commands: { verify: 'x', deploy: 'x', perf: 'x' },
}).config;
const task = (id, over = {}) => ({
  id,
  title: id,
  type: 'feature',
  status: 'audit',
  priority: 1,
  owner: 'station',
  createdAt: now,
  statusChangedAt: now,
  attempts: { continuations: 0 },
  ...over,
});
const source = (id = '0001-source', stages = ['design', 'implement'], fixedBy = ['0002-fix']) => {
  const t = task(id, {
    status: 'failed',
    returnTo: stages[0],
    recovery: { causedBy: 'pipeline', fixedBy },
  });
  return {
    ...t,
    pipelineIncident: incidentFromReport(
      t,
      {
        stage: 'postmortem',
        outcome: 'done',
        causedBy: 'pipeline',
        pipelineIncident: {
          evidence: 'Общий сбой подтверждён независимой командой.',
          affectedStages: stages,
          check: { stage: stages[0], expectation: 'Исходная команда работает после ремонта.' },
        },
      },
      fixedBy,
      now,
    ).incident,
  };
};
const state = (tasks, over = {}) => ({
  tasks,
  config,
  now,
  machine: 'station',
  stageCommands: {},
  scheduling: emptyScheduling(),
  registry: { entries: tasks.map((t) => ({ taskId: t.id, path: 'tree' })) },
  ...over,
});
const launches = (s) =>
  scan(s).actions.filter((a) => ['start-stage', 'continue-stage'].includes(a.kind));

describe('область инцидента и доступная работа', () => {
  it('исчерпанный ремонт не занимает места независимых продолжений', () => {
    const fix = task('0002-fix', { status: 'implement' });
    const affected = task('0003-affected', { status: 'design', attempts: { continuations: 999 } });
    const tasks = [
      source(),
      fix,
      affected,
      task('0004-game', { categories: ['ux'] }),
      task('0005-service', { status: 'revise' }),
    ];
    const s = state(tasks, {
      config: {
        ...config,
        provider: 'codex',
        codexMaxTaskTokens: 250,
        codexTaskReanalysisTokens: 150,
      },
      codexUsage: {
        version: 2,
        tasks: {
          [fix.id]: {
            sessions: {
              old: {
                knownTokens: 260,
                snapshot: { input_tokens: 260, output_tokens: 0 },
                reasons: [],
              },
            },
            launches: {},
          },
        },
      },
    });
    const before = JSON.stringify(s);
    const decision = scan(s);
    expect(launches(s).map((a) => a.taskId)).toEqual(['0004-game', '0005-service']);
    expect(decision.actions).toContainEqual(
      expect.objectContaining({ kind: 'hold-token-budget', taskId: fix.id }),
    );
    expect(decision.actions.some((a) => a.taskId === affected.id)).toBe(false);
    expect(decision.notes.join('\n')).toContain('этап design ожидает');
    expect(JSON.stringify(s)).toBe(before);
  });

  it('ремонт получает первое место независимо от игрового хода и числового приоритета', () => {
    const tasks = [
      source(),
      task('0002-fix', { status: 'implement', priority: -100 }),
      task('0003-game', { categories: ['ux'], priority: 999999 }),
      task('0004-service', { priority: 9999999 }),
    ];
    expect(launches(state(tasks)).map((a) => a.taskId)).toEqual(['0002-fix', '0003-game']);
    expect(launches(state(tasks, { config: { ...config, maxConcurrent: 1 } }))[0]).toMatchObject({
      taskId: '0002-fix',
      selectionReason: expect.stringContaining('приоритет восстановления'),
    });
  });

  it('новый ремонт не ждёт игрового первого хода', () => {
    const tasks = [
      source(),
      task('0002-fix', { status: 'new', owner: null, area: 'pipeline' }),
      task('0003-game', { status: 'new', owner: null, categories: ['ux'], priority: 999999 }),
    ];
    expect(launches(state(tasks, { config: { ...config, maxConcurrent: 1 } }))[0].taskId).toBe(
      '0002-fix',
    );
  });

  it('ожидающий зависимость ремонт оставляет свободное место обычной новой карточке', () => {
    const tasks = [
      source(),
      task('0002-fix', { status: 'implement', dependsOn: ['9999-missing'] }),
      task('0003-game', { status: 'new', owner: null, categories: ['ux'] }),
    ];
    expect(launches(state(tasks)).map((a) => a.taskId)).toEqual(['0003-game']);
  });

  it('объединяет области после перезапуска и находит ремонт через архивные зависимости', () => {
    const s = JSON.parse(
      JSON.stringify(
        state(
          [
            source(),
            task('0004-prerequisite', { status: 'implement' }),
            task('0005-free', { status: 'revise' }),
          ],
          {
            dependencyRecords: [
              source('0006-archive', ['audit'], ['0007-parent']),
              task('0007-parent', { dependsOn: ['0004-prerequisite'] }),
            ],
          },
        ),
      ),
    );
    const policy = incidentPolicy(s);
    expect([...policy.affectedStages].sort()).toEqual(['audit', 'design', 'implement']);
    expect(policy.allows(task('other'), 'audit')).toBe(false);
    expect(policy.isRecovery(s.tasks[1], 'implement')).toBe(true);
    expect(policy.allows(s.tasks[2], 'revise')).toBe(true);
    expect(policy.isRecovery(s.tasks[2], 'revise')).toBe(false);
    expect(launches(s).map((a) => a.taskId)).toEqual(['0004-prerequisite', '0005-free']);
  });

  it.each([['audit'], undefined])(
    'повреждённый диагноз с областью %j изолирует источник без общей остановки',
    (stages) => {
      const broken = source();
      broken.pipelineIncident = { affectedStages: stages };
      const sorted = sortCards([
        { task: broken, card: { types: ['feature'], runKinds: [], flags: [] } },
      ]);
      expect(sorted.invalid).toHaveLength(1);
      const dependent = task('0004-dependent', { status: 'revise', dependsOn: [broken.id] });
      const s = state(
        [task('0002-audit'), task('0003-revise', { status: 'revise' }), dependent],
        sorted,
      );
      s.tasks = [task('0002-audit'), task('0003-revise', { status: 'revise' }), dependent];
      const policy = incidentPolicy(s);
      expect(policy.allows(broken, 'postmortem')).toBe(false);
      expect(policy.isRecovery(task('0002-fix'), 'implement')).toBe(false);
      expect(policy.probes.size).toBe(0);
      const selected = launches(s).map((a) => a.taskId);
      expect(selected).toContain('0003-revise');
      expect(selected).not.toContain(dependent.id);
      expect(selected.includes('0002-audit')).toBe(!stages);
    },
  );

  it('единственная проба имеет приоритет, её ожидание не запрещает независимый этап', () => {
    const s = source();
    s.status = 'design';
    const tasks = [
      s,
      task('0002-fix', { status: 'completed' }),
      task('0003-game', { categories: ['ux'], priority: 999999 }),
    ];
    expect(launches(state(tasks)).map((a) => [a.taskId, !!a.incidentProbe])).toEqual([
      [s.id, true],
      ['0003-game', false],
    ]);
    const restarted = state(tasks, {
      scheduling: { ...emptyScheduling(), probes: { [s.pipelineIncident.id]: now } },
    });
    expect(launches(restarted).map((a) => a.taskId)).toEqual(['0003-game']);
    expect(incidentPolicy(restarted).active).toBe(true);
  });

  it('паузы и живой исключительный этап сохраняют общий запрет запусков', () => {
    const tasks = [source(), task('0002-fix'), task('0003-free', { categories: ['ux'] })];
    for (const over of [
      { paused: true },
      { apiPaused: true },
      { scheduling: { error: 'повреждён журнал' } },
    ])
      expect(launches(state(tasks, over))).toEqual([]);
    const exclusive = task('0004-perf', {
      type: 'run',
      status: 'benchmark',
      run: { kind: 'perf' },
    });
    expect(
      launches(
        state([...tasks, exclusive], { running: [{ taskId: exclusive.id, stage: 'benchmark' }] }),
      ),
    ).toEqual([]);
  });
});
