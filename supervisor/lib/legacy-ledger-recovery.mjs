import { normalizeTokenUsage, migrateTokenLedger } from './token-budget.mjs';

const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const pathKey = (value) =>
  String(value ?? '')
    .replaceAll('\\', '/')
    .toLowerCase();

function usage(value) {
  const normalized = normalizeTokenUsage(value);
  if (!normalized || value?.total_tokens !== normalized.input_tokens + normalized.output_tokens)
    return null;
  return normalized;
}

const total = (value) => value.input_tokens + value.output_tokens;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/**
 * Разобрать один JSONL сеанса. Имя файла намеренно не участвует в доверии:
 * перенос или копия не должны превращаться в доказательство принадлежности.
 */
export function sessionEvidence(text, { sessionId, cwd }) {
  const fail = (reason) => ({ ok: false, reason });
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      return fail('повреждён JSONL');
    }
  }
  const metas = events.filter((event) => event?.type === 'session_meta');
  if (metas.length !== 1) return fail('неоднозначные метаданные сессии');
  const meta = metas[0].payload;
  if (!object(meta) || meta.id !== sessionId || meta.session_id !== sessionId)
    return fail('session_meta не совпадает с искомой сессией');
  if (!cwd || pathKey(meta.cwd) !== pathKey(cwd)) return fail('cwd сессии не совпадает с задачей');

  const started = new Set();
  const completed = new Set();
  const records = new Map();
  const legacy = [];
  for (const event of events) {
    const payload = event?.payload;
    if (event?.type !== 'event_msg' && event?.type !== 'token_usage_record') continue;
    if (payload?.type === 'task_started' && typeof payload.turn_id === 'string')
      started.add(payload.turn_id);
    if (payload?.type === 'task_complete' && typeof payload.turn_id === 'string')
      completed.add(payload.turn_id);
    if (event.type === 'event_msg' && payload?.type === 'token_count') {
      const snapshot = usage(payload.info?.total_token_usage);
      if (!snapshot) return fail('некорректный legacy token_count');
      legacy.push(snapshot);
    }
    if (event.type !== 'token_usage_record') continue;
    if (
      payload?.thread_id !== sessionId ||
      payload?.session_id !== sessionId ||
      typeof payload.turn_id !== 'string' ||
      !payload.turn_id ||
      typeof payload.response_id !== 'string' ||
      !payload.response_id
    )
      return fail('token_usage_record не принадлежит сессии');
    const item = {
      turnId: payload.turn_id,
      responseId: payload.response_id,
      usage: usage(payload.usage),
      thread: usage(payload.thread_token_usage),
    };
    if (!item.usage || !item.thread) return fail('некорректные числа token_usage_record');
    const previous = records.get(item.responseId);
    if (previous && !same(previous, item)) return fail('конфликтующий response_id');
    if (!previous) records.set(item.responseId, item);
  }
  if (!started.size || ![...started].every((turn) => completed.has(turn)))
    return fail('незавершённый turn');

  if (records.size) {
    let summed = 0;
    let previous = 0;
    for (const record of records.values()) {
      if (!started.has(record.turnId)) return fail('record без task_started');
      summed += total(record.usage);
      const cumulative = total(record.thread);
      if (!Number.isSafeInteger(summed) || cumulative < previous || cumulative !== summed)
        return fail('непрерывность thread_token_usage не доказана');
      previous = cumulative;
    }
    return {
      ok: true,
      source: 'token_usage_record',
      snapshot: [...records.values()].at(-1).thread,
    };
  }
  if (!legacy.length) return fail('нет usage evidence');
  for (let index = 1; index < legacy.length; index += 1)
    if (total(legacy[index]) < total(legacy[index - 1]))
      return fail('legacy token_count уменьшился');
  return { ok: true, source: 'legacy-token_count', snapshot: legacy.at(-1) };
}

/** Построить только монотонные изменения v2; чтение и запись остаются у CLI. */
export function recoveryPlan(ledger, evidenceBySession) {
  const current = migrateTokenLedger(ledger);
  const next = globalThis.structuredClone(current);
  const proposed = [];
  const unresolved = [];
  for (const [taskId, task] of Object.entries(current.tasks)) {
    for (const [sessionId, session] of Object.entries(task.sessions)) {
      const evidence = evidenceBySession.get(`${taskId}:${sessionId}`);
      if (!evidence?.ok) {
        unresolved.push({ taskId, sessionId, reason: evidence?.reason ?? 'сессия не найдена' });
        continue;
      }
      const recovered = total(evidence.snapshot);
      if (recovered < session.knownTokens) {
        unresolved.push({ taskId, sessionId, reason: 'доказанная сумма меньше knownTokens' });
        continue;
      }
      const target = next.tasks[taskId].sessions[sessionId];
      target.knownTokens = Math.max(target.knownTokens, recovered);
      target.snapshot = evidence.snapshot;
      target.reasons = target.reasons.filter((reason) => reason !== 'legacy-unknown');
      if (!same(target, session))
        proposed.push({
          taskId,
          sessionId,
          source: evidence.source,
          knownTokens: target.knownTokens,
        });
    }
  }
  return { ledger: next, proposed, unresolved };
}

export const recoveryPathKey = pathKey;
