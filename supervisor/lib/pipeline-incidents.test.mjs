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

it('сверка влитого PR не подменяет проверку восстановления источника инцидента', () => {
  const task = source({ links: { pr: 42 } });
  const result = scan(
    state([task, base('0002-fix', { status: 'completed' })], {
      reconciliationReady: true,
      reconciliationEvidence: { [task.id]: { proof: { state: 'MERGED' } } },
    }),
  );
  expect(result.actions).toContainEqual(
    expect.objectContaining({ kind: 'return-task', taskId: task.id }),
  );
  expect(
    result.actions.some((action) => action.kind === 'reconcile-task' && action.taskId === task.id),
  ).toBe(false);
});

it('не объединяет проверочные выкладки разных инцидентов одним отчётом', () => {
  const tasks = ['0001-probe', '0003-probe'].map((id) => {
    const task = source({ id, status: 'deploy', returnTo: 'deploy' });
    task.pipelineIncident = {
      ...task.pipelineIncident,
      id,
      affectedStages: ['deploy'],
      check: { stage: 'deploy', expectation: 'Проверить сломанный путь выкладки' },
    };
    return task;
  });
  const result = launches(scan(state([...tasks, base('0002-fix', { status: 'completed' })])));
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ incidentProbe: true, batch: [result[0].taskId] });
});

describe('подтверждение и сохранение инцидента', () => {
  it('принимает строго локальный cleanup без глобального инцидента', () => {
    const task = source({ returnTo: 'cleanup', pipelineIncident: undefined });
    const report = {
      ...diagnosis,
      pipelineIncident: {
        evidence: ['Cleanup повторяется.', 'Исправления названы.'],
        affectedStages: ['cleanup'],
        check: { stage: 'cleanup', expectation: 'Cleanup завершается один раз.' },
      },
    };
    expect(incidentDeclarationProblem(report.pipelineIncident, task, report)).toBeNull();
    expect(incidentFromReport(task, report, ['0002-fix'], now)).toEqual({
      localRecovery: {
        evidence: 'Cleanup повторяется.\nИсправления названы.',
        expectation: 'Cleanup завершается один раз.',
        fixedBy: ['0002-fix'],
      },
    });
    expect(incidentFromReport(task, report, [], now).problem).toContain('исправлений');
    expect(
      incidentDeclarationProblem(
        { ...report.pipelineIncident, affectedStages: ['cleanup', 'design'] },
        task,
        report,
      ),
    ).toContain('свидетельство');
    expect(
      incidentDeclarationProblem(report.pipelineIncident, source({ returnTo: 'cleanup' }), report),
    ).toContain('свидетельство');
  });
  it('сохраняет все свидетельства и этап разбора без смены идентичности диагноза', () => {
    const report = globalThis.structuredClone(diagnosis);
    report.pipelineIncident.evidence = ['Инструмент не запускается.', 'Разбор воспроизводит сбой.'];
    report.pipelineIncident.affectedStages.push('postmortem');
    const task = source();
    const first = incidentFromReport(task, report, ['0002-fix'], now).incident;
    expect(first.evidence).toBe(report.pipelineIncident.evidence.join('\n'));
    expect(first.affectedStages).toContain('postmortem');
    first.probeStartedAt = now;
    expect(
      incidentFromReport(
        { ...task, pipelineIncident: first },
        {
          ...report,
          pipelineIncident: { ...report.pipelineIncident, evidence: first.evidence },
        },
        ['0002-fix'],
        now,
      ).incident,
    ).toEqual(first);
    const copied = parseCard(
      {
        id: '6a981dc012e0a4bfb4d3c087',
        name: 'Источник',
        desc: joinDescription('Текст', metaOf({ ...task, pipelineIncident: first })),
        idLabels: ['f'],
        idList: 'x',
      },
      { stateByList: new Map([['x', 'failed']]), labelKeyById: new Map([['f', 'feature']]) },
    );
    expect(copied.task.pipelineIncident).toEqual(first);
    expect(
      incidentDeclarationProblem(
        {
          ...report.pipelineIncident,
          check: {
            stage: 'postmortem',
            expectation: 'Нельзя проверять разбором',
          },
        },
        { ...task, returnTo: 'postmortem' },
        report,
      ),
    ).toBeTruthy();
  });
  it.each([[], [''], ['факт', 1], ['факт', null], {}, 42])(
    'не угадывает свидетельства из повреждённого значения %j',
    (evidence) => {
      expect(
        incidentDeclarationProblem(
          { ...diagnosis.pipelineIncident, evidence },
          source(),
          diagnosis,
        ),
      ).toContain('свидетельство');
    },
  );
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
  it('даёт локальной служебной починке ход перед независимой работой', () => {
    const repair = base('0003-repair', {
      area: 'pipeline',
      dependsOn: ['0004-prerequisite'],
    });
    const prerequisite = base('0004-prerequisite', {
      area: 'pipeline',
      status: 'postmortem',
    });
    const blocked = base('0001-blocked', {
      status: 'blocked',
      dependsOn: [repair.id],
    });
    const unrelated = base('0002-unrelated', { status: 'postmortem', priority: 0 });
    const tasks = [blocked, repair, prerequisite, unrelated];
    const policy = incidentPolicy(state(tasks));
    expect(policy.active).toBe(false);
    expect(policy.isRecovery(prerequisite, 'postmortem')).toBe(true);
    expect(
      incidentPolicy(
        state([blocked, repair, { ...prerequisite, dependsOn: [repair.id] }]),
      ).isRecovery(prerequisite, 'postmortem'),
    ).toBe(true);
    expect(
      launches(scan(state(tasks, { config: { ...config, maxConcurrent: 1 } }))).map(
        (item) => item.taskId,
      ),
    ).toEqual([prerequisite.id]);
    expect(
      incidentPolicy(
        state([{ ...blocked, status: 'completed' }, repair, prerequisite, unrelated]),
      ).isRecovery(prerequisite, 'postmortem'),
    ).toBe(false);
  });
  it('локальный приоритет не обходит удержание этапа общего инцидента', () => {
    const blocked = base('0005-blocked', {
      status: 'blocked',
      dependsOn: ['0006-local-repair'],
    });
    const repair = base('0006-local-repair', { area: 'pipeline', status: 'design' });
    const tasks = [source(), blocked, repair, base('0007-unrelated', { status: 'postmortem' })];
    const policy = incidentPolicy(state(tasks));
    expect(policy.isRecovery(repair, 'design')).toBe(true);
    expect(policy.allows(repair, 'design')).toBe(false);
    expect(
      launches(scan(state(tasks, { config: { ...config, maxConcurrent: 1 } }))).map(
        (item) => item.taskId,
      ),
    ).toEqual(['0007-unrelated']);
  });
  it('учитывает recovery.fixedBy до переноса источника в blocked', () => {
    const repair = base('0006-repair', { area: 'pipeline' });
    const failed = base('0005-failed', {
      status: 'failed',
      recovery: { causedBy: 'pipeline', fixedBy: [repair.id], returns: 0 },
    });
    expect(incidentPolicy(state([failed, repair])).isRecovery(repair, 'design')).toBe(true);
    expect(
      incidentPolicy(
        state([{ ...failed, recovery: { ...failed.recovery, causedBy: 'task' } }, repair]),
      ).isRecovery(repair, 'design'),
    ).toBe(false);
  });
  it('приоритизирует исправления и зависимости, удерживая затронутые игровые попытки', () => {
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
  it('ведёт приоритет через recovery.fixedBy и не пропускает обычные удержания', () => {
    const fix = base('0002-fix', {
      status: 'failed',
      area: 'pipeline',
      recovery: { causedBy: 'pipeline', fixedBy: ['0003-prerequisite'], returns: 0 },
    });
    const prerequisite = base('0003-prerequisite', {
      status: 'postmortem',
      area: 'pipeline',
      recovery: { causedBy: 'pipeline', fixedBy: [fix.id], returns: 0 },
    });
    const unrelated = base('0004-unrelated', { status: 'postmortem', priority: 0 });
    const tasks = [source(), fix, prerequisite, unrelated];
    expect(incidentPolicy(state(tasks)).isRecovery(prerequisite, 'postmortem')).toBe(true);
    const ready = scan(state(tasks, { config: { ...config, maxConcurrent: 1 } }));
    expect(launches(ready).map((item) => item.taskId)).toEqual([prerequisite.id]);
    const held = scan(
      state([source(), fix, { ...prerequisite, dependsOn: ['0009-missing'] }, unrelated], {
        config: { ...config, maxConcurrent: 1 },
      }),
    );
    expect(launches(held).map((item) => item.taskId)).toEqual([unrelated.id]);
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
