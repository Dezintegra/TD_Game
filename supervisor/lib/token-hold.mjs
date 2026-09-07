import { TOKEN_CAPPED_STAGES, TOKEN_RESUME_STATES } from '../config/transitions.mjs';
import { taskTokens, taskTokenStatus } from './token-budget.mjs';
import { effectiveTokenLimit } from './user-token-limit.mjs';

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
