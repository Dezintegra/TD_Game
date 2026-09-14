import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  INCIDENT_REPORT_RECOVERIES,
  incidentRecoveryKey,
} from '../config/incident-report-recoveries.mjs';
import {
  prepareIncidentReportRecovery,
  enqueueIncidentReportRecovery,
} from './incident-report-recovery.mjs';
import { createIncidentRecoveryIo } from './io.mjs';
import { deliveryFixture } from './testing/report-delivery-fixture.mjs';
import { receiptConfig } from './testing/report-recipient.mjs';
import { withReceipt } from './report-receipts.mjs';
import { execute } from './execute.mjs';
import { scan } from './scan.mjs';
import { incidentRecoveryHeld } from './pipeline-incidents.mjs';
import { emptyScheduling } from './scheduling.mjs';

const item = INCIDENT_REPORT_RECOVERIES[0];
const startedAt = '2026-09-14T12:04:23.537Z';
const now = '2026-09-15T10:00:00Z';
const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture({ newIncident = false } = {}) {
  const incident = {
    id: item.incidentId,
    openedAt: '2026-09-13T00:00:00Z',
    evidence: 'инструмент design не работал',
    affectedStages: ['design'],
    check: { stage: 'design', expectation: 'Проверить исходный design' },
    fixedBy: [item.repairTaskId],
    probeStartedAt: startedAt,
    verifiedAt: null,
    verificationEvidence: null,
  };
  const currentIncident = newIncident
    ? {
        ...incident,
        id: 'new-receiver-incident',
        probeStartedAt: null,
        evidence: 'строгий тип evidence отверг отчёт',
      }
    : incident;
  const haltKey = `${item.launchId}:halt`;
  const f = deliveryFixture({
    stage: 'design',
    taskOverrides: withReceipt(
      {
        id: item.taskId,
        status: 'failed',
        returnTo: 'design',
        categories: ['infrastructure'],
        pipelineIncident: currentIncident,
        links: { change: item.change, commits: item.commits },
        recovery: { causedBy: 'pipeline', fixedBy: [item.repairTaskId], returns: 1 },
      },
      haltKey,
    ),
    memberOverrides: {
      id: item.repairTaskId,
      status: 'completed',
      pipelineIncident: undefined,
      recovery: undefined,
      returnTo: null,
    },
    reportOverrides: {
      links: { change: item.change, commits: item.commits },
      incidentVerification: {
        incidentId: item.incidentId,
        passed: true,
        evidence: ['первое свидетельство', 'второе свидетельство', 'третье свидетельство'],
      },
    },
  });
  cleanups.push(f.cleanup);
  const first = f.open();
  first.store.acknowledge(f.entry.reportId);
  const cardId = first.recipient.state().cards[0].id;
  first.recipient.trello.delete(`cards/${cardId}/idMembers/test-member`);
  const haltJournal = `Запуск ${item.launchId}: проверка восстановления не подтверждена`;
  const linkageJournal = `Отказ ${item.launchId} привёл к диагнозу ${currentIncident.id}`;
  first.recipient.trello.post(`cards/${cardId}/actions/comments`, { text: haltJournal });
  first.recipient.trello.post(`cards/${cardId}/actions/comments`, { text: linkageJournal });
  const original = {
    taskId: item.taskId,
    launchId: item.launchId,
    stage: 'design',
    startedAt,
    machine: 'NB3391',
    assignment: { taskId: item.taskId, stage: 'design', branch: `worktree-${item.taskId}` },
    task: { ...f.task, status: 'design', returnTo: null, pipelineIncident: incident },
    report: f.report,
  };
  const input = {
    original,
    history: {
      through: now,
      launches: [{ launchId: item.launchId, stage: 'design', startedAt, machine: 'NB3391' }],
      appliedResults: [],
      sources: ['история запуска и журнала'],
    },
    halt: { launchId: item.launchId, operationKey: haltKey, journal: haltJournal },
    charge: {
      launchId: item.launchId,
      state: 'confirmed',
      costUsd: 3,
      evidence: 'квитанция исходного расхода',
    },
    linkage: {
      originalIncidentId: item.incidentId,
      currentIncidentId: currentIncident.id,
      launchId: item.launchId,
      journal: linkageJournal,
    },
    check: {
      incidentId: currentIncident.id,
      expectation: currentIncident.check.expectation,
      startedAt: now,
    },
  };
  function open() {
    const opened = f.open();
    const helper = createIncidentRecoveryIo({
      store: opened.recipient.store,
      trello: opened.recipient.trello,
      snapshot: opened.recipient.state(),
      config: receiptConfig,
      reportStore: opened.store,
      ownsLock: () => true,
    });
    return {
      ...opened,
      io: {
        ...opened.io,
        ...helper,
        now,
        tokenActionBlocked: () => false,
        incidentRecoveryGitEvidence: () => ({
          ok: true,
          branchOnRemote: true,
          unpushed: 0,
          lastCommitAt: now,
        }),
      },
    };
  }
  return { f, input, open, cardId };
}
async function scanned(opened) {
  const tasks = opened.io.allTaskIds().map((id) => opened.io.readTask(id));
  return scan({
    tasks,
    config: receiptConfig,
    now,
    stageCommands: {},
    scheduling: emptyScheduling(),
    incidentRecoveries: await opened.io.readIncidentRecoveries(),
    reports: opened.store.entries(),
    registry: { entries: tasks.map((task) => ({ taskId: task.id, path: 'isolated-tree' })) },
  });
}

describe('адресная приёмка исходного design', () => {
  it.each([false, true])(
    'применяет старый отчёт один раз; новый диагноз = %s',
    async (newIncident) => {
      const f = fixture({ newIncident });
      const opened = f.open();
      const before = globalThis.structuredClone(f.input.original.report);
      const prepared = await prepareIncidentReportRecovery(f.input, opened.io);
      expect(opened.recipient.state().puts).toBe(0);
      const action = await enqueueIncidentReportRecovery(prepared, opened.io);
      expect(opened.store.get(action.reportId).report).toEqual(before);
      const results = await execute([action], opened.io);
      expect(results[0], JSON.stringify(results)).toMatchObject({
        result: 'done',
        status: 'audit',
      });
      const restarted = f.open();
      const task = restarted.io.readTask(item.taskId);
      expect(task).toMatchObject({
        status: 'audit',
        spentUsd: 4,
        links: { change: item.change },
        recovery: { returns: 1 },
        pipelineIncident: { probeStartedAt: newIncident ? now : startedAt, verifiedAt: now },
      });
      expect(task.links.commits).toEqual(item.commits);
      for (const evidence of before.incidentVerification.evidence) {
        expect(task.pipelineIncident.verificationEvidence).toContain(evidence);
        expect(
          restarted.recipient
            .state()
            .comments.map((comment) => comment.text)
            .join('\n'),
        ).toContain(evidence);
      }
      expect(restarted.store.entries()).toEqual([]);
      expect((await restarted.io.readIncidentRecoveries())[item.taskId].complete).toBe(true);
      expect(await prepareIncidentReportRecovery(f.input, restarted.io)).toMatchObject({
        complete: true,
      });
      expect((await execute([action], restarted.io))[0].result).toBe('skipped');
      expect(restarted.recipient.state().puts).toBe(1);
      expect((await scanned(restarted)).actions).toContainEqual(
        expect.objectContaining({ kind: 'continue-stage', taskId: item.taskId, stage: 'audit' }),
      );
      expect(f.input.original.report).toEqual(before);
      restarted.recipient.trello.put(`cards/${f.cardId}`, { idList: 'list-design' });
      expect((await restarted.io.readIncidentRecoveries())[item.taskId].complete).toBe(false);
    },
  );
  it.each([
    ['PUT', '/cards-unused', 'after'],
    ['POST', '/actions/comments', 'before'],
    ['POST', '/actions/comments', 'after'],
  ])('сбой %s %s %s держит источник до подтверждённого повтора', async (method, route, when) => {
    const f = fixture({ newIncident: true });
    const first = f.open();
    const prepared = await prepareIncidentReportRecovery(f.input, first.io);
    const action = await enqueueIncidentReportRecovery(prepared, first.io);
    first.recipient.fail(method, method === 'PUT' ? `cards/${f.cardId}` : route, when);
    expect((await execute([action], first.io))[0].result).toBe('failed');
    const second = f.open();
    expect((await second.io.readIncidentRecoveries())[item.taskId].complete).toBe(false);
    expect(
      (await scanned(second)).actions.filter(
        (action) => action.taskId === item.taskId && action.kind !== 'transfer-report',
      ),
    ).toEqual([]);
    const resumed = await prepareIncidentReportRecovery(
      { original: { taskId: item.taskId } },
      second.io,
    );
    expect(resumed.entry.plan).toEqual(second.store.get(action.reportId).plan);
    expect(
      (await execute([await enqueueIncidentReportRecovery(resumed, second.io)], second.io))[0]
        .result,
    ).toBe('done');
    expect(f.open().recipient.state().puts).toBe(1);
    expect((await f.open().io.readIncidentRecoveries())[item.taskId].complete).toBe(true);
  });
  it('удерживает пустую очередь до подготовки и после рестарта без истории', async () => {
    const f = fixture({ newIncident: true });
    for (const opened of [f.open(), f.open()]) {
      expect((await scanned(opened)).actions.some((action) => action.taskId === item.taskId)).toBe(
        false,
      );
      const actions = [
        'return-task',
        'start-stage',
        'continue-stage',
        'fail-stage',
        'reconcile-task',
      ].map((kind) => ({ kind, taskId: item.taskId, stage: 'design' }));
      actions.push({
        kind: 'start-stage',
        taskId: 'other',
        stage: 'deploy',
        batch: ['other', item.taskId],
      });
      expect(
        (await execute(actions, opened.io)).every((result) => result.result === 'skipped'),
      ).toBe(true);
      expect(opened.recipient.state().puts).toBe(0);
    }
    delete f.input.history;
    await expect(prepareIncidentReportRecovery(f.input, f.open().io)).rejects.toThrow(
      'полной истории',
    );
    expect(incidentRecoveryHeld(item.taskId)).toBe(true);
    expect(
      incidentRecoveryHeld(item.taskId, {
        incidentRecoveries: { [item.taskId]: { complete: true, key: 'wrong' } },
      }),
    ).toBe(true);
  });
  it.each([
    [
      'ID',
      (input) => {
        input.original.report.incidentVerification.incidentId = 'wrong';
      },
    ],
    [
      'начало пробы',
      (input) => {
        input.original.task.pipelineIncident.probeStartedAt = null;
      },
    ],
    [
      'новый запуск',
      (input) => {
        input.history.launches.push({ launchId: 'new', stage: 'design', startedAt: now });
      },
    ],
    [
      'новый результат',
      (input) => {
        input.history.appliedResults.push({ launchId: 'new', stage: 'audit', at: now });
      },
    ],
    [
      'списание',
      (input) => {
        input.charge.state = 'unknown';
      },
    ],
    [
      'связь',
      (input) => {
        input.linkage.currentIncidentId = 'wrong';
      },
    ],
    [
      'исходный отчёт',
      (input) => {
        input.original.report.outcome = 'failed';
      },
    ],
  ])('не пишет при негодном свидетельстве: %s', async (_label, damage) => {
    const f = fixture({ newIncident: true });
    damage(f.input);
    const opened = f.open();
    await expect(prepareIncidentReportRecovery(f.input, opened.io)).rejects.toThrow(
      'incident recovery:',
    );
    expect(opened.recipient.state().puts).toBe(0);
    expect(opened.store.entries()).toEqual([]);
  });
  it('отказывает без замка, отправленного следа и при чужом захвате', async () => {
    const f = fixture();
    const opened = f.open();
    await expect(
      prepareIncidentReportRecovery(f.input, { ...opened.io, ownsSupervisorLock: () => false }),
    ).rejects.toThrow('владения');
    await expect(
      prepareIncidentReportRecovery(f.input, {
        ...opened.io,
        incidentRecoveryGitEvidence: () => ({ ok: false }),
      }),
    ).rejects.toThrow('коммиты');
    opened.recipient.trello.post(`cards/${f.cardId}/idMembers`, { value: 'other' });
    await expect(prepareIncidentReportRecovery(f.input, opened.io)).rejects.toThrow('захвачен');
    expect(opened.recipient.state().puts).toBe(0);
  });
  it('expected не позволяет перезаписать изменённую после подготовки карточку', async () => {
    const f = fixture();
    const opened = f.open();
    const action = await enqueueIncidentReportRecovery(
      await prepareIncidentReportRecovery(f.input, opened.io),
      opened.io,
    );
    opened.recipient.trello.put(`cards/${f.cardId}`, { idList: 'list-design' });
    const result = await execute([action], opened.io);
    expect(result[0].result).toBe('failed');
    expect(opened.recipient.state().puts).toBe(1);
    expect(opened.store.entries()).toHaveLength(1);
    expect((await opened.io.readIncidentRecoveries())[item.taskId].complete).toBe(false);
  });
  it('проверяет все части длинного журнала после сбоя между ними', async () => {
    const f = fixture({ newIncident: true });
    f.input.original.report.summary = 'подробный результат '.repeat(1100);
    const first = f.open();
    const action = await enqueueIncidentReportRecovery(
      await prepareIncidentReportRecovery(f.input, first.io),
      first.io,
    );
    const post = first.recipient.trello.post;
    let posted = 0;
    first.recipient.trello.post = (route, data) => {
      if (route.endsWith('/actions/comments') && ++posted === 2)
        return { ok: false, why: 'вторая часть не записана' };
      return post(route, data);
    };
    expect((await execute([action], first.io))[0].result).toBe('failed');
    const second = f.open();
    expect(second.io.readTask(item.taskId).pipelineIncident.verifiedAt).toBe(now);
    expect((await second.io.readIncidentRecoveries())[item.taskId].complete).toBe(false);
    expect((await execute([action], second.io))[0].result).toBe('done');
    const third = f.open();
    expect((await third.io.readIncidentRecoveries())[item.taskId].complete).toBe(true);
    expect(third.recipient.state().puts).toBe(1);
    // Получатель потерял часть журнала: один verifiedAt и финальная квитанция недостаточны.
    const get = third.recipient.trello.get;
    third.recipient.trello.get = (route, data) => {
      const result = get(route, data);
      if (route.endsWith('/actions') && result.ok)
        result.data = result.data.filter(
          (comment) =>
            !comment.data.text.includes(':0 -->') ||
            comment.data.text.includes('incident-recovery:'),
        );
      return result;
    };
    expect((await third.io.readIncidentRecoveries())[item.taskId].complete).toBe(false);
  });
  it('настоящие точки запуска передают подтверждения в state и не снимают recovered заранее', () => {
    for (const name of ['supervise', 'cycle']) {
      const body = readFileSync(new URL(`../bin/${name}.mjs`, import.meta.url), 'utf8');
      expect(body).toContain('createIncidentRecoveryIo');
      expect(body).toContain('incidentRecoveries');
      expect(body).toContain('readIncidentRecoveries');
    }
    expect(readFileSync(new URL('../bin/supervise.mjs', import.meta.url), 'utf8')).toContain(
      '!incidentRecoveryHeld',
    );
    expect(incidentRecoveryKey(item)).toContain(item.launchId);
  });
});
