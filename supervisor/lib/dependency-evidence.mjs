import { NEEDS_SESSION } from '../config/transitions.mjs';
import {
  dependencyFormatProblem,
  mergeEvidenceProblem,
  resultPredecessor,
} from './dependencies.mjs';

export const DEPENDENCY_READ_TIMEOUT_MS = 10_000;

/** Один снимок — один набор чтений. Ошибка GitHub удерживает только зависимые задачи. */
export async function collectDependencyEvidence({
  tasks = [],
  dependencyRecords = [],
  invalid = [],
  running = [],
  reports = [],
  config,
  root,
  run,
}) {
  const numbers = new Set();
  for (const task of tasks) {
    if (task.status !== 'new' && !NEEDS_SESSION.includes(task.status)) continue;
    if (
      running.some((item) => item.taskId === task.id) ||
      reports.some(
        (item) =>
          item.taskId === task.id ||
          (item.stage === 'deploy' && Array.isArray(item.batch) && item.batch.includes(task.id)),
      )
    )
      continue;
    if (dependencyFormatProblem(task)) continue;
    for (const result of task.dependencyResults ?? []) {
      const { predecessor } = resultPredecessor(result.taskId, tasks, dependencyRecords, invalid);
      if (predecessor?.links?.pr === result.pr) numbers.add(result.pr);
    }
  }
  const evidence = {};
  for (const pr of numbers) {
    let record;
    try {
      if (!root || !config?.mainBranch)
        throw new Error('не определены репозиторий или главная ветка');
      const response = await run(
        ['pr', 'view', String(pr), '--json', 'number,state,mergedAt,baseRefName'],
        'gh',
        root,
        { timeout: DEPENDENCY_READ_TIMEOUT_MS },
      );
      if (response.code !== 0) throw new Error(String(response.stderr || 'ошибка чтения GitHub'));
      const value = JSON.parse(response.stdout);
      const problem = mergeEvidenceProblem(value, pr, config.mainBranch);
      record = problem
        ? { number: pr, problem }
        : {
            number: value.number,
            state: value.state,
            mergedAt: value.mergedAt,
            baseRefName: value.baseRefName,
          };
    } catch (error) {
      record = { number: pr, problem: `нет доказательства: ${error.message}` };
    }
    evidence[pr] = Object.freeze(record);
  }
  return Object.freeze(evidence);
}
