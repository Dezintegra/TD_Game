import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function normalizeTokenUsage(usage) {
  if (
    !usage ||
    !['input_tokens', 'output_tokens'].every(
      (key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0,
    )
  )
    return null;
  if (!Number.isSafeInteger(usage.input_tokens + usage.output_tokens)) return null;
  if (
    usage.cached_input_tokens != null &&
    (!Number.isSafeInteger(usage.cached_input_tokens) ||
      usage.cached_input_tokens < 0 ||
      usage.cached_input_tokens > usage.input_tokens)
  )
    return null;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    ...(usage.cached_input_tokens != null
      ? { cached_input_tokens: usage.cached_input_tokens }
      : {}),
  };
}

export function emptyTokenSession() {
  return { knownTokens: 0, snapshot: null, reasons: [] };
}

export function tokenLaunch(sessionId = null, baseline = null) {
  return { sessionId, baseline, observations: {}, reasons: [], completed: false };
}

function reason(target, value) {
  if (!target.reasons.includes(value)) target.reasons.push(value);
}

// Идентичность берётся из запуска и позиции события, а не из суммы токенов.
// Поэтому replay старого снимка не выглядит новым уменьшением счётчика.
export function reduceTokenObservation(session, launch, ordinal, usage) {
  const nextSession = globalThis.structuredClone(session);
  const nextLaunch = globalThis.structuredClone(launch);
  const snapshot = normalizeTokenUsage(usage);
  const observation = snapshot ?? { unknown: 'invalid-usage' };
  const previous = launch.observations[ordinal];
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(observation)) {
      reason(nextSession, 'conflicting-observation');
      reason(nextLaunch, 'conflicting-observation');
    }
    return { session: nextSession, launch: nextLaunch };
  }
  nextLaunch.observations[ordinal] = observation;
  if (!snapshot) {
    reason(nextSession, 'invalid-usage');
    reason(nextLaunch, 'invalid-usage');
  } else {
    const prior = session.snapshot;
    if (prior && ['input_tokens', 'output_tokens'].some((key) => snapshot[key] < prior[key])) {
      reason(nextSession, 'decreased-usage');
      reason(nextLaunch, 'decreased-usage');
    }
    // Сохраняем настоящий снимок, не синтетический покомпонентный максимум.
    nextSession.knownTokens = Math.max(
      session.knownTokens,
      snapshot.input_tokens + snapshot.output_tokens,
    );
    nextSession.snapshot = snapshot;
  }
  return { session: nextSession, launch: nextLaunch };
}

export function launchTokenUsage(session, launch) {
  if (session.reasons.length || launch.reasons.length || !launch.baseline || !session.snapshot)
    return null;
  const usage = {};
  for (const key of ['input_tokens', 'output_tokens']) {
    usage[key] = session.snapshot[key] - launch.baseline[key];
    if (usage[key] < 0) return null;
  }
  // Кэш входит в input; его падение не портит известную разность input/output.
  if (session.snapshot.cached_input_tokens != null)
    usage.cached_input_tokens = Math.max(
      0,
      session.snapshot.cached_input_tokens - (launch.baseline.cached_input_tokens ?? 0),
    );
  return usage;
}

// CLI reports cumulative input (including cache) and output for each session.
// Keep maxima independently of reports and session lifecycle: retries are idempotent.
export function recordTokenUsage(ledger, taskId, sessionId, usage) {
  if (!sessionId || !usage) return false;
  if (
    !['input_tokens', 'output_tokens'].every(
      (key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0,
    )
  )
    return false;
  const total = usage.input_tokens + usage.output_tokens;
  if (!Number.isSafeInteger(total)) return false;
  const sessions = ledger[taskId] ?? {};
  if (total <= (sessions[sessionId] ?? -1)) return false;
  ledger[taskId] = { ...sessions, [sessionId]: total };
  return true;
}

export function taskTokens(ledger, taskId) {
  return Object.values(ledger[taskId] ?? {}).reduce((sum, tokens) => sum + tokens, 0);
}

export function readTokenLedger(root, config) {
  const path = join(root, config.paths.local, 'codex-usage.json');
  if (!existsSync(path)) return {};
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  if (
    !object(ledger) ||
    !Object.values(ledger).every(
      (sessions) =>
        object(sessions) &&
        Object.values(sessions).every((tokens) => Number.isSafeInteger(tokens) && tokens >= 0),
    )
  )
    throw new Error(`Повреждён счётчик токенов: ${path}`);
  return ledger;
}

export function writeTokenLedger(root, config, ledger) {
  const dir = join(root, config.paths.local);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'codex-usage.json');
  writeFileSync(path + '.tmp', JSON.stringify(ledger, null, 2));
  renameSync(path + '.tmp', path);
}
