import { createHash } from 'node:crypto';
import { reportTaskIds } from './report-targets.mjs';

export function backlogFingerprint(task, tasks) {
  const related = new Set([
    ...(task.links?.related ?? []),
    ...(task.dependsOn ?? []),
    ...(task.splitInto ?? []),
  ]);
  return createHash('sha256')
    .update(
      JSON.stringify([
        task.title,
        task.description,
        task.status,
        task.area,
        task.links,
        task.dependsOn,
        task.dependencyResults,
        tasks
          .filter((t) => related.has(t.id))
          .map((t) => [t.id, t.status, t.links, t.splitInto, t.closureReason])
          .sort((a, b) => a[0].localeCompare(b[0])),
      ]),
    )
    .digest('hex');
}

/** Один ограниченный анализ изменений, без повторной оплаты неизменившейся доски. */
export function planBacklogReview({ tasks, running = [], reports = [], machine }) {
  const audits = tasks.filter((t) => t.backlogReview);
  if (audits.some((t) => !['completed', 'closed', 'failed'].includes(t.status))) return null;
  const reviewed = new Set(
    audits.flatMap((t) =>
      Object.entries(t.backlogReview.fingerprints ?? {}).map(([id, hash]) => `${id}:${hash}`),
    ),
  );
  const selected = [];
  for (const task of tasks) {
    if (
      task.backlogReview ||
      !['candidate', 'new', 'maintenance', 'failed', 'awaiting-po'].includes(task.status) ||
      (task.owner && task.owner !== machine) ||
      running.some((r) => r.taskId === task.id || r.batch?.includes(task.id)) ||
      reports.some((r) => reportTaskIds(r).includes(task.id))
    )
      continue;
    const fingerprint = backlogFingerprint(task, tasks);
    if (reviewed.has(`${task.id}:${fingerprint}`)) continue;
    selected.push([task.id, fingerprint]);
    if (selected.length === 8) break;
  }
  return selected.length
    ? { kind: 'queue-backlog-review', fingerprints: Object.fromEntries(selected) }
    : null;
}

export async function queueBacklogReview(action, io) {
  const tasks = io
    .allTaskIds()
    .map((id) => io.readTask(id))
    .filter(Boolean);
  const running = tasks.filter((t) => io.tokenActionBlocked?.(t.id)).map((t) => ({ taskId: t.id }));
  const plan = planBacklogReview({ tasks, machine: io.machine, running });
  if (!plan || JSON.stringify(plan.fingerprints) !== JSON.stringify(action.fingerprints))
    return { result: 'skipped', why: 'опись уже изменилась или сверка назначена' };
  const ids = Object.keys(action.fingerprints);
  const { nextId, taskFromRequest } = await import('./requests.mjs');
  const id = nextId(io.allTaskIds(), 'Сверка актуальности бэклога');
  const made = taskFromRequest(
    {
      type: 'note',
      area: 'pipeline',
      categories: ['infrastructure'],
      title: 'Сверить актуальность изменившихся карточек бэклога',
      description: `Ограниченный аналитический проход: ${ids.join(', ')}. Сопоставить предмет с актуальным кодом, выполненными преемниками и связанными карточками. Проверить дубли, сохранность критериев, устаревшие замеры и неверную область. Использовать consolidations, classifications, resumptions и amendments общего контракта. Не реализовывать соседние задачи и не запускать прогоны. Отсутствие доказательств назвать явно; не создавать новую задачу только для повторения этой сверки. Результат — конкретные решения и сохранённые причины; отсутствие изменений является допустимым done.`,
      priority: 50,
    },
    { id, now: io.now },
  );
  if (!made.task) return { result: 'failed', why: made.problems.join('; ') };
  const task = {
    ...made.task,
    backlogReview: { fingerprints: action.fingerprints },
    links: { ...made.task.links, related: ids },
  };
  const result = await io.createTask(task);
  return result.ok ? { result: 'done', taskId: id } : { result: 'failed', why: result.outcome };
}
