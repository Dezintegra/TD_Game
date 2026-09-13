import { createHash } from 'node:crypto';

/** Повтор одного отчёта должен ссылаться на те же карточки продолжения. */
export function closureRequestKey(task, report, index) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        task.id,
        task.status,
        task.statusChangedAt,
        report.summary,
        report.requests,
        index,
      ]),
    )
    .digest('hex');
}

/** Причина живёт дольше этапа: уборка не должна подменять её своим итогом. */
export function closureReasonFor(report, successors = [], link = (id) => id) {
  const summary = report.summary.trim();
  if (report.outcome === 'moot')
    return `Предмет снят: ${summary}\n\nПроверено: ${String(report.evidence).trim()}`;
  const reason =
    report.outcome === 'split'
      ? 'Исходная задача разделена на самостоятельные части.'
      : 'Работа по исходной заметке передана отдельным задачам.';
  return `${reason} ${summary}\n\nПродолжение работы:\n${successors.map((id) => `- ${link(id)}`).join('\n')}`;
}

/** Совместимость со старой уборкой: берём доказательство, а не выдумываем его. */
export function recoverClosureReason(task, journal = '') {
  if (typeof task.closureReason === 'string' && task.closureReason.trim())
    return task.closureReason.trim();
  const notes = [
    ...(task.history ?? []).map((item) => item.note ?? ''),
    ...String(journal).split(/\r?\n\s*\r?\n/),
  ];
  return (
    notes
      .findLast((note) => note.startsWith('Предмет снят:') && note.includes('Проверено:'))
      ?.trim() ?? null
  );
}
