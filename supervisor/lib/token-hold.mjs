import { TOKEN_CAPPED_STAGES, TOKEN_RESUME_STATES } from '../config/transitions.mjs';
import { taskTokens, taskTokenStatus } from './token-budget.mjs';
import { effectiveTokenLimit } from './user-token-limit.mjs';
import { applyTransition } from './task-file.mjs';

/** Один допуск для сканера и последней проверки перед порождением процесса. */
export function tokenAdmission(task, stage, config, ledger = {}) {
  if (config.provider !== 'codex' || !TOKEN_CAPPED_STAGES.includes(stage)) return null;
  const budget = effectiveTokenLimit(task, config);
  const spent = taskTokens(ledger, task.id);
  const accounting = taskTokenStatus(ledger, task.id);
  const reason = budget.error
    ? 'invalid-limit'
    : budget.value != null && spent >= budget.value
      ? 'exhausted'
      : budget.value != null && !accounting.complete
        ? 'unknown-usage'
        : null;
  if (!reason) return null;
  return {
    spent,
    limit: budget.value,
    source: budget.source,
    reason,
    accountingComplete: accounting.complete,
    accountingReasons: accounting.reasons,
    explanation:
      budget.error ??
      (reason === 'exhausted'
        ? `Израсходовано ${spent} токенов при бюджете ${budget.value}.`
        : `Расход Codex неизвестен (${accounting.reasons.join(', ')}); запуск удержан.`),
  };
}

export function tokenHoldProblem(task) {
  const hold = task.tokenHold;
  if (
    !hold ||
    !TOKEN_RESUME_STATES.includes(hold.resumeStatus) ||
    ![...TOKEN_RESUME_STATES, 'awaiting-po'].includes(hold.originStatus) ||
    !Number.isFinite(Date.parse(hold.originSince)) ||
    !Number.isFinite(hold.originPriority) ||
    hold.originPriority < 0 ||
    !(hold.originReturnTo === null || typeof hold.originReturnTo === 'string')
  )
    return 'Не сохранён этап возврата из «Лимит токенов»: восстановите контекст по истории карточки.';
  return null;
}

/** Служебная запись не касается сессии, реестра, лимита или счётчиков. */
export async function changeTokenHold(action, io) {
  const task = io.readTask(action.taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет' };
  if (task.owner && task.owner !== io.machine)
    return { result: 'skipped', why: 'задача другой станции' };
  if (io.tokenActionBlocked?.(task.id))
    return { result: 'skipped', why: 'есть живая сессия или готовый отчёт' };
  const entering = action.kind === 'hold-token-budget';
  if ((entering && task.status !== action.from) || (!entering && task.status !== 'token-limit'))
    return { result: 'skipped', why: 'состояние уже изменилось' };
  if (!entering && tokenHoldProblem(task))
    return { result: 'skipped', why: tokenHoldProblem(task) };
  const budget = io.tokenAdmission ? io.tokenAdmission(task, action.stage) : action.budget;
  const resume = action.kind === 'resume-token-budget';
  if (resume ? Boolean(budget) : !budget)
    return { result: 'skipped', why: 'бюджет изменился, нужен новый снимок' };
  let next;
  if (entering) {
    const hold = {
      originStatus: task.status,
      resumeStatus: action.resumeStatus ?? task.status,
      originSince: task.statusChangedAt ?? task.createdAt,
      originPriority: task.priority,
      originReturnTo: task.returnTo ?? null,
      originLabel: action.originLabel,
      resumeLabel: action.resumeLabel,
      blockedAt: io.now,
      ...(action.evidence ? { evidence: action.evidence } : {}),
      ...budget,
    };
    if (tokenHoldProblem({ tokenHold: hold }))
      return { result: 'failed', why: tokenHoldProblem({ tokenHold: hold }) };
    next = applyTransition(
      { ...task, tokenHold: hold },
      {
        status: 'token-limit',
        now: io.now,
        note: budget.explanation,
      },
    );
  } else if (resume) {
    next = applyTransition(task, {
      status: task.tokenHold.resumeStatus,
      now: io.now,
      note: 'Бюджет разрешает продолжение.',
    });
    if (next.task) {
      next.task.priority = task.tokenHold.originPriority;
      next.task.returnTo = task.tokenHold.originReturnTo;
      delete next.task.tokenHold;
    }
  } else {
    if (
      Object.entries(budget).every(
        ([key, value]) => JSON.stringify(task.tokenHold[key]) === JSON.stringify(value),
      )
    )
      return { result: 'skipped', why: 'сведения бюджета не изменились' };
    next = { task: { ...task, tokenHold: { ...task.tokenHold, ...budget } } };
  }
  if (!next.task) return { result: 'failed', why: next.problems.join('; ') };
  const saved = await io.saveTask(
    next.task,
    {
      at: io.now,
      from: task.status,
      to: next.task.status,
      what: resume
        ? 'Бюджет разрешает продолжение; сохранённый этап и счётчики восстановлены.'
        : tokenPanel(next.task.tokenHold),
      source: 'supervisor',
      ...(resume ? { restorePriority: task.tokenHold.originPriority } : {}),
    },
    `chore(backlog): ${task.id} ${task.status} → ${next.task.status} (бюджет токенов)`,
  );
  return saved.ok
    ? { result: 'done', status: next.task.status }
    : { result: 'failed', why: saved.why ?? saved.outcome };
}

const PANEL_OPEN = '<!-- token-budget-panel -->';
const PANEL_CLOSE = '<!-- /token-budget-panel -->';

export function withoutTokenPanel(text = '') {
  const start = text.indexOf(PANEL_OPEN);
  const end = text.indexOf(PANEL_CLOSE, start);
  return start >= 0 && end >= start
    ? (text.slice(0, start) + text.slice(end + PANEL_CLOSE.length)).trim()
    : text.trim();
}

export function tokenPanel(hold) {
  if (!hold) return '';
  const lines = [
    PANEL_OPEN,
    '## Лимит токенов',
    '',
    `**Расход:** ${hold.spent ?? 'неизвестен'} токенов${hold.accountingComplete === false ? ' (учёт неполон)' : ''}.`,
    `**Лимит:** ${hold.limit ?? 'не определён'} токенов (${hold.source === 'user' ? 'задан владельцем' : 'общий'}).`,
    `**Продолжить с этапа:** ${hold.resumeLabel ?? hold.resumeStatus ?? 'требует восстановления'}.`,
    `**До переноса:** ${hold.originLabel ?? hold.originStatus ?? 'неизвестно'}.`,
    '',
    hold.explanation ?? 'Проверьте сохранённый контекст бюджета.',
    '',
    'Для продолжения владелец пишет новый комментарий в интерфейсе этой карточки: **Лимит токенов: <полный бюджет>**. Укажите целое число больше расхода; это полный лимит, а не добавка. После достаточного повышения карточка вернётся на сохранённый этап автоматически.',
  ];
  if (hold.accountingComplete === false)
    lines.push(
      'Сначала необходимо восстановить учёт расхода; повышение лимита само по себе неизвестный расход не разрешает.',
    );
  return [...lines, PANEL_CLOSE].join('\n');
}
