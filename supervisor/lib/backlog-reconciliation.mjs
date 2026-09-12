import { mergeEvidenceProblem } from './dependencies.mjs';
import { applyTransition } from './task-file.mjs';

export const RECONCILE_STATES = [
  'failed',
  'postmortem',
  'awaiting-po',
  'design',
  'audit',
  'implement',
  'revise',
];
const INTERVAL = 15 * 60 * 1000;

export function needsReconciliation(task, now) {
  return (
    task.type === 'feature' &&
    RECONCILE_STATES.includes(task.status) &&
    Number.isInteger(task.links?.pr) &&
    task.links.pr > 0 &&
    (task.reconciliation?.pr !== task.links.pr ||
      !Number.isFinite(Date.parse(task.reconciliation?.checkedAt)) ||
      Date.parse(now) - Date.parse(task.reconciliation.checkedAt) >= INTERVAL)
  );
}

/** Чтения ограничены; сохранённая отметка обеспечивает продвижение следующей пары. */
export async function collectReconciliation({
  tasks,
  running = [],
  reports = [],
  root,
  run,
  config,
  machine,
  now,
}) {
  const result = {};
  const eligible = tasks.filter(
    (task) =>
      needsReconciliation(task, now) &&
      (!task.owner || task.owner === machine) &&
      !running.some((x) => x.taskId === task.id || x.batch?.includes(task.id)) &&
      !reports.some((x) => x.taskId === task.id || x.batch?.includes(task.id)),
  );
  for (const task of eligible.slice(0, 2)) {
    try {
      const answer = await run(
        ['pr', 'view', String(task.links.pr), '--json', 'number,state,mergedAt,baseRefName'],
        'gh',
        root,
        { timeout: 10000 },
      );
      if (answer.code !== 0) throw Error('GitHub недоступен');
      const proof = JSON.parse(answer.stdout);
      result[task.id] = {
        proof,
        problem: mergeEvidenceProblem(proof, task.links.pr, config.mainBranch),
      };
    } catch {
      result[task.id] = { proof: null, problem: 'GitHub недоступен или ответ не разобран' };
    }
  }
  return result;
}

/** Сверка не объявляет игровую работу выполненной по одному факту merge. */
export async function reconcileTask(action, io) {
  const task = io.readTask(action.taskId);
  if (
    !task ||
    task.status !== action.expectedStatus ||
    task.statusChangedAt !== action.expectedSince ||
    task.links?.pr !== action.pr ||
    (task.owner && task.owner !== io.machine)
  )
    return { result: 'skipped', why: 'карточка изменилась после снимка' };
  const problem = mergeEvidenceProblem(action.proof, task.links.pr, action.mainBranch);
  let next = {
    ...task,
    reconciliation: {
      pr: task.links.pr,
      checkedAt: io.now,
      state: problem ? 'unconfirmed' : 'merged',
    },
  };
  let why = problem ?? `PR #${task.links.pr} влит в ${action.mainBranch}`;
  if (!problem) {
    // Номер PR проверяется повторно перед записью; снимок не даёт права игнорировать гонку.
    const fresh = io.reconciliationPr?.(task.links.pr);
    const freshProblem = mergeEvidenceProblem(fresh, task.links.pr, action.mainBranch);
    if (freshProblem) return { result: 'skipped', why: freshProblem };
    const impact = io.deploymentImpact?.(task.links.pr);
    const status = impact?.needed === false ? 'cleanup' : 'review';
    why +=
      status === 'cleanup'
        ? '; служебный diff: осталась уборка'
        : '; восстановить обязательства прогона и выпуска в review';
    const moved = applyTransition(next, { status, note: why, now: io.now, reconciliation: true });
    if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };
    next = moved.task;
    delete next.question;
    delete next.delayAnalysis;
    delete next.delayJournal;
  }
  const saved = await io.saveTask(
    next,
    { at: io.now, from: task.status, to: next.status, what: `Сверка: ${why}` },
    `chore(backlog): reconcile ${task.id}`,
  );
  return saved.ok
    ? { result: 'done', status: next.status }
    : { result: 'failed', why: saved.outcome };
}
