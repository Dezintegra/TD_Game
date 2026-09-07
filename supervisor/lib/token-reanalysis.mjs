import { createHash } from 'node:crypto';
import { TOKEN_CAPPED_STAGES, TOKEN_RESUME_STATES } from '../config/transitions.mjs';
import { tokenAdmission } from './token-hold.mjs';
import { taskTokens, taskTokenStatus } from './token-budget.mjs';
import { applyTransition, resetAttempts } from './task-file.mjs';

/** Ранний анализ не повышает окончательный бюджет и назначается один раз. */
export function tokenReanalysisAdmission(task, stage, config, ledger = {}) {
  const threshold = config.codexTaskReanalysisTokens;
  if (
    config.provider !== 'codex' ||
    task.type !== 'feature' ||
    !TOKEN_CAPPED_STAGES.includes(stage) ||
    task.tokenReanalysis ||
    !Number.isSafeInteger(threshold) ||
    threshold <= 0 ||
    tokenAdmission(task, stage, config, ledger) ||
    !taskTokenStatus(ledger, task.id).complete
  )
    return null;
  const spent = taskTokens(ledger, task.id);
  return spent >= threshold
    ? {
        spent,
        threshold,
        explanation: `Израсходовано ${spent} токенов; достигнут порог анализа ${threshold}. Нужен повторный анализ дробности; неделимая задача продолжит сохранённый этап до окончательного лимита.`,
      }
    : null;
}

export function tokenReanalysisProblem(task) {
  const context = task.tokenReanalysis;
  return context?.phase === 'analyzing' &&
    TOKEN_RESUME_STATES.includes(context.originStatus) &&
    context.originStatus !== 'decompose' &&
    Number.isFinite(context.originPriority) &&
    context.originPriority >= 0 &&
    (context.originReturnTo === null || typeof context.originReturnTo === 'string') &&
    context.originAttempts &&
    typeof context.originAttempts === 'object' &&
    !Array.isArray(context.originAttempts) &&
    typeof context.originDecomposed === 'boolean'
    ? null
    : 'Не сохранён контекст возврата из бюджетного анализа.';
}

export const tokenAnalysisReportKey = (report) =>
  createHash('sha256').update(JSON.stringify(report)).digest('hex');

export function finishTokenReanalysis(task, next, report, now) {
  const context = task.tokenReanalysis;
  return {
    ...next,
    priority: context.originPriority,
    returnTo: context.originReturnTo,
    attempts: { ...context.originAttempts },
    decomposed: context.originDecomposed,
    tokenReanalysis: {
      ...context,
      phase: 'completed',
      completedAt: now,
      summary: report.summary,
      reportKey: tokenAnalysisReportKey(report),
    },
  };
}

export async function analyzeTokenBudget(action, io) {
  const task = io.readTask(action.taskId);
  if (!task || task.status !== action.from || task.tokenReanalysis)
    return { result: 'skipped', why: 'состояние уже изменилось' };
  if (task.owner && task.owner !== io.machine)
    return { result: 'skipped', why: 'задача другой станции' };
  if (io.tokenActionBlocked?.(task.id))
    return { result: 'skipped', why: 'есть живая сессия или готовый отчёт' };
  const analysis = io.tokenReanalysisAdmission
    ? io.tokenReanalysisAdmission(task, action.stage)
    : action.analysis;
  if (!analysis) return { result: 'skipped', why: 'бюджет изменился, нужен новый снимок' };
  const context = {
    phase: 'analyzing',
    originStatus: task.status,
    originReturnTo: task.returnTo ?? null,
    originPriority: task.priority,
    originAttempts: { ...task.attempts },
    originDecomposed: Boolean(task.decomposed),
    startedAt: io.now,
    ...analysis,
  };
  const problem = tokenReanalysisProblem({ tokenReanalysis: context });
  if (problem) return { result: 'failed', why: problem };
  const moved = applyTransition(
    { ...task, tokenReanalysis: context },
    {
      status: 'decompose',
      now: io.now,
      note: analysis.explanation,
    },
  );
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };
  // Повторный анализ читает новую причину, а не продолжает старую декомпозицию.
  io.forgetSession?.(task.id, 'decompose');
  const saved = await io.saveTask(
    { ...resetAttempts(moved.task), decomposed: false },
    {
      at: io.now,
      from: task.status,
      to: 'decompose',
      what: analysis.explanation,
      source: 'supervisor',
    },
    `chore(backlog): ${task.id} ${task.status} → decompose (ранний порог токенов)`,
  );
  return saved.ok
    ? { result: 'done', status: 'decompose' }
    : { result: 'failed', why: saved.why ?? saved.outcome };
}
