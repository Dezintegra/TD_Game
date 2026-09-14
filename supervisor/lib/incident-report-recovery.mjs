import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import {
  INCIDENT_REPORT_RECOVERIES,
  incidentRecoveryKey,
  incidentRecoveryOperationKey,
} from '../config/incident-report-recoveries.mjs';
import { prepareReportPlan } from './report-plan.mjs';
import { verifyIncident, incidentStateProblem } from './pipeline-incidents.mjs';
import { judgeDenials } from './denials.mjs';
import { hasReceipt, partReceipt, receiptOf } from './report-receipts.mjs';
import { journalBody } from './journal.mjs';
import { splitJournalEntry } from './comments.mjs';
import { pendingDependencies } from './dependencies.mjs';

const text = (value) => typeof value === 'string' && value.trim().length > 0;
const date = (value) => text(value) && Number.isFinite(Date.parse(value));
export const recoveryDigest = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => globalThis.structuredClone(value);
const demand = (condition, why) => {
  if (!condition) throw new Error(`incident recovery: ${why}`);
};
const confirmationKey = (item) => `${incidentRecoveryKey(item)}:confirmation`;

/** Подтверждение не зависит от наличия конверта и проверяет все части журнала. */
export function confirmIncidentRecovery(item, task, comments) {
  const key = incidentRecoveryKey(item);
  const candidates = comments.filter((body) =>
    body.endsWith(partReceipt(confirmationKey(item), 0)),
  );
  if (candidates.length !== 1)
    return { key, complete: false, why: 'нет единственной квитанции полной доставки' };
  try {
    const match = candidates[0].match(/<!-- incident-recovery:([A-Za-z0-9+/=]+) -->/);
    const proof = JSON.parse(Buffer.from(match?.[1] ?? '', 'base64').toString('utf8'));
    const hashes = new Set(comments.map(recoveryDigest));
    const incident = task?.pipelineIncident;
    const receipts = task?.reportReceipts ?? [];
    const recoveryIndex = receipts.indexOf(receiptOf(incidentRecoveryOperationKey(item)));
    // Последующие штатные переходы добавляют квитанции. Ручная смена статуса
    // сразу после восстановления не выдаётся за известный результат audit.
    const knownStatus =
      task?.status === 'audit' || (recoveryIndex >= 0 && recoveryIndex < receipts.length - 1);
    const complete =
      proof.key === key &&
      proof.taskId === item.taskId &&
      hasReceipt(task, incidentRecoveryOperationKey(item)) &&
      knownStatus &&
      task.links?.change === item.change &&
      date(incident?.verifiedAt) &&
      incident.id === proof.incidentId &&
      incident.verifiedAt === proof.verifiedAt &&
      incident.probeStartedAt === proof.probeStartedAt &&
      recoveryDigest(incident.verificationEvidence ?? '') === proof.evidenceHash &&
      Array.isArray(proof.commentHashes) &&
      proof.commentHashes.length > 0 &&
      proof.commentHashes.every((hash) => hashes.has(hash));
    return {
      key,
      complete,
      why: complete ? null : 'переход, инцидент или полный журнал не подтверждены',
    };
  } catch {
    return { key, complete: false, why: 'повреждена квитанция полной доставки' };
  }
}

export function isIncidentRecoveryEntry(entry, item) {
  const recovery = entry?.plan?.incidentRecovery;
  return (
    entry?.taskId === item.taskId &&
    entry.stage === item.stage &&
    entry.launchId === incidentRecoveryKey(item) &&
    recovery?.key === incidentRecoveryKey(item) &&
    recovery.originalLaunchId === item.launchId &&
    isDeepStrictEqual(entry.report, recovery.original?.report) &&
    entry.plan.operations?.length === 2 &&
    entry.plan.operations[0].key === incidentRecoveryOperationKey(item) &&
    entry.plan.operations[0].kind === 'saveTask' &&
    entry.plan.operations[0].args[0].id === item.taskId &&
    entry.plan.operations[0].args[0].status === 'audit' &&
    entry.plan.operations[0].expected?.status === 'failed' &&
    entry.plan.operations[1].key === confirmationKey(item) &&
    entry.plan.operations[1].kind === 'amendTask' &&
    entry.plan.operations[1].args[0] === item.taskId
  );
}

/** Только подготовка. Исторические свидетельства предоставляет владелец замка, не worker. */
export async function prepareIncidentReportRecovery(input, io) {
  demand(await io.ownsSupervisorLock?.(), 'нет исключительного владения супервизора');
  const original = input.original;
  const item = INCIDENT_REPORT_RECOVERIES.find((item) => item.taskId === original?.taskId);
  demand(item, 'нет адресного поручения');
  const key = incidentRecoveryKey(item);
  const confirmations = await io.readIncidentRecoveries();
  if (confirmations[item.taskId]?.complete) return { complete: true, key };
  const pending = io.reportStore.entries().filter((entry) => entry.taskId === item.taskId);
  if (pending.length) {
    demand(
      pending.length === 1 && isIncidentRecoveryEntry(pending[0], item),
      'конкурирующий или частично исполненный прежний отчёт',
    );
    return { key, entry: pending[0] };
  }
  const snapshot = await io.readIncidentRecoverySnapshot(item.taskId);
  demand(snapshot.ok, snapshot.why ?? 'карточка недоступна');
  const current = snapshot.task;
  demand(
    current.status === 'failed' && current.returnTo === item.stage,
    'источник не остановлен на исходном этапе',
  );
  demand(snapshot.members?.length === 0 && !current.owner, 'источник захвачен');
  demand(!io.tokenActionBlocked?.(item.taskId), 'источник занят рабочим запуском или отчётом');
  demand(
    original.launchId === item.launchId &&
      original.stage === item.stage &&
      date(original.startedAt) &&
      text(original.machine),
    'личность исходного запуска не подтверждена',
  );
  demand(
    original.assignment?.taskId === item.taskId &&
      original.assignment.stage === item.stage &&
      original.assignment.branch === `worktree-${item.taskId}`,
    'исходное назначение не совпадает',
  );
  demand(
    original.task?.id === item.taskId &&
      original.task.status === item.stage &&
      original.task.pipelineIncident?.id === item.incidentId &&
      !original.task.pipelineIncident.verifiedAt,
    'нет исходного снимка пробы',
  );
  demand(
    original.report?.taskId === item.taskId &&
      original.report.stage === item.stage &&
      original.report.outcome === 'done' &&
      original.report.links?.change === item.change,
    'исходный конечный отчёт не совпадает',
  );
  demand(current.links?.change === item.change, 'изменение источника заменено');
  const historicalTask = clone(original.task);
  historicalTask.pipelineIncident.probeStartedAt ??= original.probeStartedAt;
  const historical = verifyIncident(historicalTask, original.report, io.now);
  demand(historical?.incident, historical?.problem ?? 'исходная проба не проверена');
  demand(!incidentStateProblem(historicalTask.pipelineIncident), 'исходный инцидент неполон');
  const history = input.history;
  demand(
    date(history?.through) &&
      Date.parse(history.through) >= Date.parse(io.now) &&
      Array.isArray(history.launches) &&
      Array.isArray(history.appliedResults) &&
      Array.isArray(history.sources) &&
      history.sources.length > 0 &&
      history.sources.every(text),
    'нет полной истории запусков до текущей проверки',
  );
  demand(
    history.launches.some(
      (launch) =>
        launch.launchId === item.launchId &&
        launch.startedAt === original.startedAt &&
        launch.machine === original.machine &&
        launch.stage === item.stage,
    ),
    'исходного запуска нет в истории',
  );
  demand(
    !history.launches.some(
      (launch) =>
        launch.launchId !== item.launchId &&
        (!date(launch.startedAt) ||
          (Date.parse(launch.startedAt) >= Date.parse(original.startedAt) &&
            launch.stage !== 'postmortem')),
    ),
    'есть более новая работа или неполная личность запуска',
  );
  const halt = input.halt;
  demand(
    !history.appliedResults.some(
      (result) =>
        result.launchId !== item.launchId &&
        (!date(result.at) ||
          (Date.parse(result.at) >= Date.parse(original.startedAt) &&
            result.stage !== 'postmortem')),
    ),
    'есть более новый применённый результат',
  );
  demand(
    halt?.launchId === item.launchId &&
      text(halt.operationKey) &&
      hasReceipt(current, halt.operationKey) &&
      text(halt.journal) &&
      snapshot.comments.some((body) => body.includes(halt.journal)) &&
      halt.journal.includes('проверка восстановления не подтверждена'),
    'нет подтверждения ошибочного halt этого запуска',
  );
  demand(
    input.charge?.launchId === item.launchId &&
      input.charge.state === 'confirmed' &&
      input.charge.costUsd === (original.report.costUsd ?? original.costUsd) &&
      text(input.charge.evidence) &&
      Number.isFinite(input.charge.costUsd) &&
      input.charge.costUsd >= 0 &&
      current.spentUsd >= input.charge.costUsd,
    'прежний расход не подтверждён',
  );
  const incident = current.pipelineIncident;
  demand(
    incident && !incident.verifiedAt && !incidentStateProblem(incident),
    'текущий инцидент неполон или уже изменён',
  );
  demand(
    incident.check.stage === item.stage && text(incident.check.expectation),
    'проверка текущего инцидента относится к другому этапу',
  );
  const related = input.linkage;
  if (incident.id !== item.incidentId) {
    demand(
      related?.originalIncidentId === item.incidentId &&
        related.currentIncidentId === incident.id &&
        related.launchId === item.launchId &&
        text(related.journal) &&
        snapshot.comments.some((body) => body.includes(related.journal)),
      'связь нового диагноза с ошибочным отказом не доказана',
    );
  }
  const records = io.dependencyRecords?.() ?? [];
  const all = io
    .allTaskIds()
    .map((id) => io.readTask(id))
    .filter((task) => task && !records.some((record) => record.id === task.id));
  const required = [...new Set([...incident.fixedBy, item.repairTaskId])];
  demand(
    !pendingDependencies({ ...current, dependsOn: required, dependencyResults: [] }, all, [], {
      records,
    }).length,
    'исправления текущего диагноза не завершены',
  );
  demand(
    input.check?.incidentId === incident.id &&
      input.check.expectation === incident.check.expectation &&
      date(input.check.startedAt) &&
      Date.parse(input.check.startedAt) <= Date.parse(io.now) &&
      Date.parse(input.check.startedAt) >= Date.parse(incident.openedAt),
    'нет начала адресной проверки текущего приёмника',
  );
  const git = await io.incidentRecoveryGitEvidence(item, original);
  demand(git?.ok, git?.why ?? 'не подтверждены удалённые коммиты и изменение');
  const trust = judgeDenials({
    report: original.report,
    stage: item.stage,
    denials: original.report.denials ?? [],
    evidence: { ...git, stageStartedAt: original.startedAt },
  });
  demand(trust.verdict === 'passing', trust.why);
  // Исторический контекст нужен только чистой приёмке; expected всегда берётся с живой карточки.
  const plan = await prepareReportPlan(
    { taskId: item.taskId, stage: item.stage, reportId: key },
    {
      ...io,
      readTask: (id) => (id === item.taskId ? clone(historicalTask) : io.readTask(id)),
      readReport: () => clone(original.report),
      stageStartedAt: () => original.startedAt,
      stageEvidence: () => git,
    },
  );
  demand(
    plan.result.status === 'audit' &&
      plan.operations.length === 1 &&
      plan.operations[0].kind === 'saveTask',
    'штатная приёмка не дала единственного перехода в audit',
  );
  const operation = plan.operations[0];
  const accepted = operation.args[0];
  const verificationEvidence =
    incident.id === item.incidentId
      ? historical.incident.verificationEvidence
      : `Исправленный приёмник проверил исходный ${item.stage}, launchId ${item.launchId}. ${incident.check.expectation}\n${historical.incident.verificationEvidence}`;
  operation.expected = clone(current);
  operation.key = incidentRecoveryOperationKey(item);
  operation.args[0] = {
    ...clone(current),
    status: 'audit',
    statusChangedAt: io.now,
    returnTo: null,
    attempts: accepted.attempts,
    pipelineIncident: {
      ...incident,
      probeStartedAt:
        incident.id === item.incidentId
          ? historicalTask.pipelineIncident.probeStartedAt
          : input.check.startedAt,
      verifiedAt: io.now,
      verificationEvidence,
    },
  };
  const journal = operation.args[1];
  journal.from = 'failed';
  journal.what = `Пересмотр ошибочного halt исходного запуска ${item.launchId}. ${original.report.summary}`;
  journal.decisions = [
    ...(journal.decisions ?? []),
    `Историческая проба ${item.incidentId} начата ${historicalTask.pipelineIncident.probeStartedAt}; исходный отчёт сохранён без изменений.`,
    `Проверка текущего инцидента ${incident.id}: ${verificationEvidence}`,
    `Расход запуска ${item.launchId} уже учтён: ${input.charge.evidence}. Повторного списания нет.`,
  ];
  operation.args[2] = 'chore(backlog): recover original incident report';
  const body =
    `**failed → audit**\n\n${journalBody({
      ...journal,
      completionSummary: operation.args[0].completionSummary ?? journal.completionSummary,
    })}` + (journal.reportTransferKey ? `\n\n<!-- report:${journal.reportTransferKey} -->` : '');
  const commentHashes = splitJournalEntry(body, {
    marker: io.recoveryCommentConfig.marker,
    source: journal.source,
    limit: io.recoveryCommentConfig.maxTextLength - partReceipt(operation.key, 999999).length,
  }).map((part, index) => recoveryDigest(part + partReceipt(operation.key, index)));
  const savedIncident = operation.args[0].pipelineIncident;
  const proof = {
    key,
    taskId: item.taskId,
    incidentId: incident.id,
    probeStartedAt: savedIncident.probeStartedAt,
    verifiedAt: io.now,
    evidenceHash: recoveryDigest(verificationEvidence),
    commentHashes,
  };
  const proofText = `Полная исправляющая доставка исходного запуска ${item.launchId}.\n<!-- incident-recovery:${Buffer.from(JSON.stringify(proof)).toString('base64')} -->`;
  demand(
    splitJournalEntry(proofText, {
      marker: io.recoveryCommentConfig.marker,
      source: 'supervisor',
      limit:
        io.recoveryCommentConfig.maxTextLength - partReceipt(confirmationKey(item), 999999).length,
    }).length === 1,
    'квитанция полной доставки превышает допустимый размер',
  );
  plan.operations.push({
    key: confirmationKey(item),
    kind: 'amendTask',
    args: [
      item.taskId,
      proofText,
      'chore(backlog): confirm incident report recovery',
      'supervisor',
    ],
    expected: null,
  });
  plan.cleanup = [];
  plan.incidentRecovery = {
    key,
    originalLaunchId: item.launchId,
    original: clone(original),
    history: clone(history),
    halt: clone(halt),
    charge: clone(input.charge),
    linkage: clone(related ?? null),
    check: clone(input.check),
  };
  return { key, plan, original: clone(original) };
}

/** Конверт фиксируется раньше доставки. Обрыв между accept и update не даёт перепланирования. */
export async function enqueueIncidentReportRecovery(prepared, io) {
  demand(await io.ownsSupervisorLock?.(), 'нет исключительного владения супервизора');
  if (prepared.complete) return null;
  if (prepared.entry)
    return {
      kind: 'transfer-report',
      taskId: prepared.entry.taskId,
      stage: prepared.entry.stage,
      reportId: prepared.entry.reportId,
    };
  const original = prepared.original;
  const entry = io.reportStore.accept(original.report, {
    launchId: prepared.key,
    startedAt: original.startedAt,
    machine: original.machine,
  });
  if (entry.plan)
    demand(
      isDeepStrictEqual(entry.plan, { ...prepared.plan, reportId: entry.reportId }),
      'план уже зафиксирован иначе',
    );
  else
    io.reportStore.update(entry.reportId, { plan: { ...prepared.plan, reportId: entry.reportId } });
  demand(io.reportStore.verifySaved().ok, 'конверт не подтверждён на диске');
  return {
    kind: 'transfer-report',
    taskId: entry.taskId,
    stage: entry.stage,
    reportId: entry.reportId,
  };
}
