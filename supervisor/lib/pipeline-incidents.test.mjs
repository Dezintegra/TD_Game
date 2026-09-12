import { describe, expect, it } from 'vitest';
import {
  incidentDeclarationProblem,
  incidentFromReport,
  incidentPolicy,
  legacyIncident,
  verifyIncident,
} from './pipeline-incidents.mjs';
import { scan } from './scan.mjs';
import { emptyScheduling } from './scheduling.mjs';
import { stagePrompt } from './stage-prompt.mjs';
import { metaOf, parseCard, joinDescription } from './card.mjs';
import { resolveConfig } from '../config/defaults.mjs';

const now = '2026-09-12T20:00:00Z';
const { config } = resolveConfig({
  maxConcurrent: 2,
  worktreeDir: '.claude/worktrees',
  commands: { verify: 'x', deploy: 'x', perf: 'x' },
});
const base = (id, over = {}) => ({
  id,
  type: 'feature',
  status: 'new',
  priority: 1,
  createdAt: now,
  statusChangedAt: now,
  attempts: { continuations: 0, cycleFailures: 0 },
  ...over,
});
const diagnosis = {
  stage: 'postmortem',
  outcome: 'done',
  causedBy: 'pipeline',
  pipelineIncident: {
    evidence:
      'В двух задачах тот же исполняемый файл отсутствует; проверка пути воспроизводит отказ.',
    affectedStages: ['design', 'implement'],
    check: {
      stage: 'design',
      expectation: 'Запустить design и получить корректный отчёт без прежнего отказа инструмента.',
    },
  },
};
const source = (over = {}) => {
  const task = base('0001-source', {
    status: 'failed',
    returnTo: 'design',
    categories: ['ux'],
    recovery: { causedBy: 'pipeline', fixedBy: ['0002-fix'], returns: 0 },
  });
  return {
    ...task,
    pipelineIncident: incidentFromReport(task, diagnosis, ['0002-fix'], now).incident,
    ...over,
  };
};
const state = (tasks, over = {}) => ({
  tasks,
  config,
  now,
  stageCommands: {},
  scheduling: emptyScheduling(),
  registry: { entries: tasks.map((item) => ({ taskId: item.id, path: 'isolated-tree' })) },
  ...over,
});
const launches = (result) =>
  result.actions.filter((item) => ['start-stage', 'continue-stage'].includes(item.kind));

describe('подтверждение и сохранение инцидента', () => {
  it('ошибка отдельного кода и голословный инцидент не дают общего приоритета', () => {
    expect(
      incidentDeclarationProblem(diagnosis.pipelineIncident, source(), {
        ...diagnosis,
        causedBy: 'task',
      }),
    ).toContain('общей поломки');
    expect(
      incidentDeclarationProblem(
        { ...diagnosis.pipelineIncident, evidence: '' },
        source(),
        diagnosis,
      ),
    ).toContain('свидетельство');
    expect(incidentFromReport(source(), diagnosis, [], now).problem).toContain('исправлений');
    expect(incidentPolicy(state([base('0001-failed', { status: 'failed' })])).active).toBe(false);
  });
  it('инцидент переживает метаданные Trello и неизменный диагноз не выдаёт вторую пробу', () => {
    const task = source();
    task.pipelineIncident.probeStartedAt = now;
    const copied = parseCard(
      {
        id: '6a981dc012e0a4bfb4d3c087',
        name: 'Источник',
        desc: joinDescription('Текст', metaOf(task)),
        idLabels: ['f'],
        idList: 'x',
      },
      { stateByList: new Map([['x', 'failed']]), labelKeyById: new Map([['f', 'feature']]) },
    ).task;
    expect(copied.pipelineIncident).toEqual(task.pipelineIncident);
    expect(
      incidentFromReport(task, diagnosis, ['0002-fix'], '2026-09-13T00:00:00Z').incident
        .probeStartedAt,
    ).toBe(now);
  });
  it('старые разборы общей причины объединяются без новых пробных отказов', () => {
    const a = source();
    delete a.pipelineIncident;
    const b = { ...a, id: '0003-sibling' };
    const found = legacyIncident([a, b], now);
    expect(found.taskId).toBe(a.id);
    expect(found.incident.evidence).toContain(b.id);
    expect(launches(scan(state([a, b, base('0002-fix')])))).toEqual([]);
    expect(
      scan(state([a, b, base('0002-fix')])).actions.some((item) => item.kind === 'open-incident'),
    ).toBe(true);
    expect(legacyIncident([a], now)).toBe(null);
    expect(
      legacyIncident(
        [
          a,
          b,
          source({
            id: '0004-checked',
            pipelineIncident: {
              ...found.incident,
              verifiedAt: now,
              verificationEvidence: 'Прошло',
            },
          }),
        ],
        now,
      ),
    ).toBe(null);
  });
});

describe('приоритет восстановления и ограниченная проба', () => {
  it('запускает только исправления и их зависимости, удерживая игровые попытки', () => {
    const game = base('0009-game', {
      status: 'implement',
      categories: ['ux'],
      attempts: { continuations: 999, spawnFailures: 999 },
    });
    const tasks = [
      source(),
      base('0002-fix', { area: 'pipeline', dependsOn: ['0003-prerequisite'] }),
      base('0003-prerequisite', { area: 'pipeline' }),
      game,
      base('0004-unrelated'),
    ];
    const before = JSON.stringify(game);
    const result = scan(state(tasks));
    expect(launches(result).map((item) => item.taskId)).toEqual(['0003-prerequisite']);
    expect(result.actions.some((item) => item.taskId === game.id)).toBe(false);
    expect(JSON.stringify(game)).toBe(before);
    expect(result.notes.join()).toContain('подтверждённого инцидента');
  });
  it('не считает закрытую или исчезнувшую починку выполненной', () => {
    for (const fix of [[], [base('0002-fix', { status: 'closed' })]]) {
      const policy = incidentPolicy(state([source(), ...fix]));
      expect(policy.probes.size).toBe(0);
      expect(policy.allows(source(), 'design')).toBe(false);
    }
  });
  it('после выполнения починки возвращает исходную задачу и выдаёт ровно одну пробу', () => {
    const fixed = base('0002-fix', { status: 'completed' });
    const result = scan(state([source(), fixed, base('0009-game', { categories: ['ux'] })]));
    expect(result.actions).toContainEqual(
      expect.objectContaining({ kind: 'return-task', taskId: '0001-source' }),
    );
    const ready = source({ status: 'design', returnTo: null });
    const probe = launches(scan(state([ready, fixed])));
    expect(probe).toEqual([expect.objectContaining({ taskId: ready.id, incidentProbe: true })]);
    const memory = { ...emptyScheduling(), probes: { [ready.pipelineIncident.id]: now } };
    const ended = scan(state([ready, fixed], { scheduling: memory }));
    expect(launches(ended)).toEqual([]);
    expect(ended.actions).toContainEqual(
      expect.objectContaining({ kind: 'fail-stage', taskId: ready.id }),
    );
    const live = scan(
      state([ready, fixed], {
        scheduling: memory,
        running: [{ taskId: ready.id, stage: 'design' }],
      }),
    );
    expect(live.actions.some((item) => item.taskId === ready.id)).toBe(false);
  });
  it('зелёный результат без свидетельства не закрывает инцидент; успех отдаёт ход игре', () => {
    const task = source({ status: 'design' });
    task.pipelineIncident.probeStartedAt = now;
    expect(
      verifyIncident(task, { stage: 'design', outcome: 'done', summary: 'CI зелёный' }, now)
        .problem,
    ).toContain('не подтверждена');
    const result = verifyIncident(
      task,
      {
        stage: 'design',
        outcome: 'done',
        incidentVerification: {
          incidentId: task.pipelineIncident.id,
          passed: true,
          evidence:
            'design запущен на исправленной ревизии; лог содержит корректный принятый отчёт, инструмент доступен.',
        },
      },
      now,
    );
    const tasks = [
      { ...task, status: 'pr', pipelineIncident: result.incident },
      base('0002-fix', { status: 'completed' }),
      base('0009-game', { categories: ['ux'] }),
      base('0008-service'),
    ];
    const selected = launches(
      scan(state(tasks, { scheduling: { ...emptyScheduling(), next: 'service' } })),
    );
    expect(selected[0].taskId).toBe('0009-game');
    expect(incidentPolicy(state(tasks)).active).toBe(false);
  });
  it('назначение объясняет проверку и точный формат свидетельства', () => {
    const task = source({ status: 'design' });
    const prompt = stagePrompt({ assignment: { taskId: task.id, stage: 'design' }, task });
    expect(prompt).toContain(task.pipelineIncident.check.expectation);
    expect(prompt).toContain('incidentVerification');
    expect(prompt).toContain(task.pipelineIncident.id);
  });
});
