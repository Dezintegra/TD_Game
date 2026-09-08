import { createHash } from 'node:crypto';
import { haltOf } from './apply-report.mjs';
import { addSpent, applyTransition } from './task-file.mjs';

const reportKey = (report) => createHash('sha256').update(JSON.stringify(report)).digest('hex');

/** Ключ действует только для того перехода, который сохранил отказ. */
export function hasReportRejection(task, report) {
  const saved = task.reportRejection;
  return (
    saved?.key === reportKey(report) &&
    saved.status === task.status &&
    saved.at === task.statusChangedAt
  );
}

/** Даже при самообновлении сначала доставляем оставшиеся части журнала. */
export async function finishReportRejection(task, report, io) {
  if (task.delayJournal) {
    if (!io.flushDelayJournal) return { result: 'failed', why: 'нет доставки журнала отказа' };
    const saved = await io.flushDelayJournal(task);
    if (!saved.ok) return { result: 'failed', why: saved.why ?? saved.outcome };
  }
  io.forgetSession?.(task.id, report.stage);
  if (task.status === 'postmortem') io.forgetSession?.(task.id, 'postmortem');
  io.removeReport(task.id, report.stage);
  return { result: 'done', status: task.status, why: task.reportRejection.reason };
}

/** Постоянная ошибка отчёта останавливает его задачу, а не очередь супервизора. */
export async function rejectReport(task, report, reason, io) {
  // Карточка могла сменить этап независимо от отчёта. Не откатываем чужой переход.
  const moved =
    task.status === report.stage
      ? applyTransition(task, { status: haltOf(task), now: io.now, note: reason })
      : { task };
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };
  const key = reportKey(report);
  const message = `chore(backlog): preserve rejected report ${task.id}:${report.stage}`;
  // Полный отчёт доставляется частями ДО перехода: конверт в описании карточки
  // ограничен длиной и не должен содержать две копии большого ответа модели.
  const preserved = await io.amendTask(
    task.id,
    `Отчёт ${task.id}:${report.stage} не применён: ${reason}\n\n` +
      'Полный отчёт сохранён для разбора.\n\n```json\n' +
      JSON.stringify(report, null, 2) +
      '\n```',
    message,
    'supervisor',
    `report-rejection:${key}`,
  );
  if (!preserved.ok) return { result: 'failed', why: preserved.why ?? preserved.outcome };
  const next = addSpent(
    {
      ...moved.task,
      reportRejection: { key, reason, status: moved.task.status, at: moved.task.statusChangedAt },
    },
    report.costUsd,
  );
  const saved = await io.saveTask(
    next,
    {
      at: io.now,
      from: task.status,
      to: next.status,
      source: 'supervisor',
      deliveryKey: `report-rejection:${key}`,
      problem: `Отчёт ${task.id}:${report.stage} не применён: ${reason}`,
      what:
        'Полный отчёт сохранён в журнале перед этим переходом. Повтор переноса без изменения ' +
        'исходных данных не исправит эту ошибку. Проверить причину отказа и актуальные зависимости.',
    },
    message,
  );
  if (!saved.ok) return { result: 'failed', why: saved.why ?? saved.outcome };
  return finishReportRejection(next, report, io);
}
