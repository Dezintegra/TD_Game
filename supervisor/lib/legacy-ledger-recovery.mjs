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
export function sessionEvidence(text, { sessionId, cwd, projectRoot = null, after = null }) {
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
  const actualCwd = pathKey(meta.cwd);
  const expectedCwd = pathKey(cwd);
  const root = pathKey(projectRoot).replace(/\/$/, '');
  if (
    !cwd ||
    (actualCwd !== expectedCwd &&
      !(root && (actualCwd === root || actualCwd.startsWith(`${root}/`))))
  )
    return fail('cwd сессии не совпадает с задачей');

  const turns = new Map();
  let activeTurn = null;
  let lastCompleted = null;
  const records = new Map();
  const legacy = [];
  for (const event of events) {
    const payload = event?.payload;
    if (event?.type !== 'event_msg' && event?.type !== 'token_usage_record') continue;
    if (payload?.type === 'task_started') {
      if (typeof payload.turn_id !== 'string' || !payload.turn_id || activeTurn)
        return fail('незавершённый turn');
      if (turns.has(payload.turn_id)) return fail('turn запущен повторно');
      turns.set(payload.turn_id, 'active');
      activeTurn = payload.turn_id;
      continue;
    }
    if (payload?.type === 'task_complete') {
      if (payload.turn_id !== activeTurn || turns.get(payload.turn_id) !== 'active')
        return fail('task_complete без активного task_started');
      turns.set(payload.turn_id, 'completed');
      activeTurn = null;
      lastCompleted = { turnId: payload.turn_id, at: Date.parse(event.timestamp) };
      continue;
    }
    if (event.type === 'event_msg' && payload?.type === 'token_count') {
      if (!activeTurn) return fail('token_count вне активного turn');
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
    if (item.turnId !== activeTurn) return fail('record вне активного turn');
    const previous = records.get(item.responseId);
    if (previous && !same(previous, item)) return fail('конфликтующий response_id');
    if (!previous) records.set(item.responseId, item);
  }
  if (!turns.size || activeTurn || [...turns.values()].some((state) => state !== 'completed'))
    return fail('незавершённый turn');
  if (
    after != null &&
    (!lastCompleted || !Number.isFinite(lastCompleted.at) || lastCompleted.at < Date.parse(after))
  )
    return fail('stale completed turn');

  if (records.size) {
    let input = 0;
    let output = 0;
    let previousInput = 0;
    let previousOutput = 0;
    for (const record of records.values()) {
      input += record.usage.input_tokens;
      output += record.usage.output_tokens;
      if (
        !Number.isSafeInteger(input) ||
        !Number.isSafeInteger(output) ||
        record.thread.input_tokens < previousInput ||
        record.thread.output_tokens < previousOutput ||
        record.thread.input_tokens !== input ||
        record.thread.output_tokens !== output
      )
        return fail('непрерывность thread_token_usage не доказана');
      previousInput = record.thread.input_tokens;
      previousOutput = record.thread.output_tokens;
    }
    if (after != null && [...records.values()].at(-1).turnId !== lastCompleted.turnId)
      return fail('evidence не принадлежит текущему turn');
    return {
      ok: true,
      source: 'token_usage_record',
      snapshot: [...records.values()].at(-1).thread,
    };
  }
  if (!legacy.length) return fail('нет usage evidence');
  for (let index = 1; index < legacy.length; index += 1)
    if (
      legacy[index].input_tokens < legacy[index - 1].input_tokens ||
      legacy[index].output_tokens < legacy[index - 1].output_tokens
    )
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
      // Обычный v2-снимок уже ведёт сам супервизор. Восстановитель берёт
      // только унаследованную неизвестность, чтобы не переписывать живую историю.
      if (!session.reasons.includes('legacy-unknown')) continue;
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
