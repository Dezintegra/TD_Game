import { addSpent, refundContinuation } from './task-file.mjs';
import { hasReceipt } from './report-receipts.mjs';

/** Diagnostic settlement has exactly one recipient and no report-driven effects. */
export function prepareToolSettlement(entry, task, now) {
  if (entry.disposition !== 'infrastructure-held' || entry.evidence?.verdict !== 'confirmed')
    throw new Error('independent outage confirmation is missing');
  if (entry.retry?.recovery?.verdict !== 'healthy')
    throw new Error('full recovery confirmation is missing');
  if (!['not-required', 'confirmed'].includes(entry.charge?.state))
    throw new Error('continuation receipt is unresolved');
  if (
    !task ||
    task.id !== entry.taskId ||
    task.status !== entry.stage ||
    Date.parse(task.statusChangedAt) > Date.parse(entry.startedAt) ||
    (entry.assignment.task?.owner && task.owner !== entry.assignment.task.owner)
  )
    throw new Error('infrastructure settlement conflicts with source task');
  if (entry.charge.state === 'confirmed' && !hasReceipt(task, entry.charge.key))
    throw new Error('recipient has no receipt for this launch charge');
  if (
    entry.charge.state === 'confirmed' &&
    ((task.attempts?.continuations ?? 0) < 1 || hasReceipt(task, `api-refund:${entry.launchId}`))
  )
    throw new Error('launch refund conflicts with current accounting');
  const cost =
    (entry.originalResult.answer?.cost ?? 0) +
    (entry.evidence.costUsd ?? 0) +
    (entry.retry.recoveryCostUsd ?? 0);
  const next = addSpent(entry.charge.state === 'confirmed' ? refundContinuation(task) : task, cost);
  const key = `${entry.reportId}:infrastructure:${entry.launchId}`;
  const journal = {
    at: now,
    from: task.status,
    to: task.status,
    what:
      'Подтверждён сбой инструментов этапа. Исходный результат сохранён; ' +
      'поручения отчёта не исполнены: infrastructure disposition. ' +
      (entry.charge.state === 'confirmed'
        ? 'Возвращено одно подтверждённо списанное продолжение.'
        : 'Списания не было; продолжения не возвращались.'),
    decisions: [
      JSON.stringify({
        launchId: entry.launchId,
        reportId: entry.reportId,
        report: entry.originalResult.parsedReport ?? entry.originalResult.report,
        outcome: entry.originalResult.answer?.outcome,
        why: entry.originalResult.answer?.why,
        evidence: entry.evidence.checks,
        recovery: entry.retry.recovery.checks,
        git: entry.git,
        rawResult: 'Сохранён в диагностическом архиве по reportId',
        costUsd: cost,
      }),
    ],
  };
  return {
    version: 1,
    kind: 'infrastructure',
    reportId: entry.reportId,
    operations: [
      {
        key,
        kind: 'saveTask',
        args: [next, journal, 'chore(pipeline): settle confirmed tool outage'],
        expected: task,
      },
    ],
    cleanup: [],
    result: { result: 'done', status: task.status, why: 'infrastructure settlement confirmed' },
  };
}

export function validToolSettlement(entry) {
  const plan = entry.plan;
  return (
    plan?.kind === 'infrastructure' &&
    plan.reportId === entry.reportId &&
    plan.operations.length === 1 &&
    plan.cleanup.length === 0 &&
    plan.operations[0].kind === 'saveTask' &&
    plan.operations[0].args[0].id === entry.taskId &&
    plan.operations[0].args[0].status === entry.stage
  );
}
