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
    if (
      prior?.cached_input_tokens != null &&
      snapshot.cached_input_tokens != null &&
      snapshot.cached_input_tokens < prior.cached_input_tokens
    ) {
      nextSession.diagnostics ??= [];
      if (!nextSession.diagnostics.includes('decreased-cache'))
        nextSession.diagnostics.push('decreased-cache');
    }
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
  const snapshot = launchTokenSnapshot(launch);
  if (session.reasons.length || launch.reasons.length || !launch.baseline || !snapshot) return null;
  const usage = {};
  for (const key of ['input_tokens', 'output_tokens']) {
    usage[key] = snapshot[key] - launch.baseline[key];
    if (usage[key] < 0) return null;
  }
  // Кэш входит в input; его падение не портит известную разность input/output.
  if (snapshot.cached_input_tokens != null)
    usage.cached_input_tokens = Math.max(
      0,
      snapshot.cached_input_tokens - (launch.baseline.cached_input_tokens ?? 0),
    );
  return usage;
}

export function launchTokenSnapshot(launch) {
  const ordinals = Object.keys(launch.observations)
    .map(Number)
    .sort((a, b) => b - a);
  for (const ordinal of ordinals) {
    const snapshot = normalizeTokenUsage(launch.observations[ordinal]);
    if (snapshot) return snapshot;
  }
  return null;
}

export function taskTokens(ledger, taskId) {
  const data = ledger.version === 2 ? ledger : migrateTokenLedger(ledger);
  return Object.values(data.tasks[taskId]?.sessions ?? {}).reduce(
    (sum, session) => sum + session.knownTokens,
    0,
  );
}

export function writeTokenLedger(root, config, ledger) {
  migrateTokenLedger(ledger);
  const dir = join(root, config.paths.local);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'codex-usage.json');
  writeFileSync(path + '.tmp', JSON.stringify(ledger, null, 2));
  renameSync(path + '.tmp', path);
}

const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const reasonsValid = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const snapshotValid = (value) =>
  value === null || (object(value) && normalizeTokenUsage(value) !== null);

export function migrateTokenLedger(data) {
  const invalid = () => {
    throw new Error('Повреждён счётчик токенов или неизвестна версия');
  };
  if (!object(data)) return invalid();
  if ('version' in data) {
    if (data.version !== 2 || !object(data.tasks)) return invalid();
    for (const task of Object.values(data.tasks)) {
      if (!object(task) || !object(task.sessions) || !object(task.launches)) return invalid();
      for (const session of Object.values(task.sessions)) {
        if (
          !object(session) ||
          !nonnegative(session.knownTokens) ||
          !snapshotValid(session.snapshot) ||
          !reasonsValid(session.reasons) ||
          (session.snapshot &&
            session.knownTokens < session.snapshot.input_tokens + session.snapshot.output_tokens)
        )
          return invalid();
      }
      for (const launch of Object.values(task.launches)) {
        if (
          !object(launch) ||
          !(launch.sessionId === null || typeof launch.sessionId === 'string') ||
          !snapshotValid(launch.baseline) ||
          !object(launch.observations) ||
          !reasonsValid(launch.reasons) ||
          typeof launch.completed !== 'boolean'
        )
          return invalid();
        for (const [ordinal, observation] of Object.entries(launch.observations)) {
          if (
            !/^[1-9][0-9]*$/.test(ordinal) ||
            !Number.isSafeInteger(Number(ordinal)) ||
            !(
              object(observation) &&
              (normalizeTokenUsage(observation) || observation.unknown === 'invalid-usage')
            )
          )
            return invalid();
        }
      }
    }
    return globalThis.structuredClone(data);
  }
  const ledger = { version: 2, tasks: {} };
  for (const [taskId, sessions] of Object.entries(data)) {
    if (!object(sessions) || !Object.values(sessions).every(nonnegative)) return invalid();
    ledger.tasks[taskId] = {
      sessions: Object.fromEntries(
        Object.entries(sessions).map(([id, knownTokens]) => [
          id,
          { knownTokens, snapshot: null, reasons: ['legacy-unknown'] },
        ]),
      ),
      launches: {},
    };
  }
  return ledger;
}

export function readTokenLedger(root, config) {
  const path = join(root, config.paths.local, 'codex-usage.json');
  return migrateTokenLedger(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
}

export function beginTokenLaunch(ledger, taskId, launchId, sessionId = null) {
  const task = (ledger.tasks[taskId] ??= { sessions: {}, launches: {} });
  if (Object.hasOwn(task.launches, launchId)) return;
  const baseline = sessionId
    ? (task.sessions[sessionId]?.snapshot ?? null)
    : { input_tokens: 0, output_tokens: 0 };
  task.launches[launchId] = tokenLaunch(sessionId, baseline);
  if (sessionId && !baseline) reason(task.launches[launchId], 'missing-baseline');
}

export function bindTokenSession(ledger, taskId, launchId, sessionId) {
  const task = ledger.tasks[taskId];
  const launch = task.launches[launchId];
  if (typeof sessionId !== 'string' || !sessionId) {
    reason(launch, 'unknown-session');
    return;
  }
  if (launch.sessionId && launch.sessionId !== sessionId) {
    reason(launch, 'changed-session');
    return;
  }
  // thread.started с уже известным thread не доказывает новый нулевой накопитель.
  if (!launch.sessionId && task.sessions[sessionId])
    launch.baseline = task.sessions[sessionId].snapshot;
  launch.sessionId = sessionId;
  if (!Object.hasOwn(task.sessions, sessionId)) task.sessions[sessionId] = emptyTokenSession();
}

export function observeTokenUsage(ledger, taskId, launchId, ordinal, usage) {
  const task = ledger.tasks[taskId];
  const launch = task.launches[launchId];
  if (!launch.sessionId) {
    reason(launch, 'unknown-session');
    launch.observations[ordinal] = normalizeTokenUsage(usage) ?? { unknown: 'invalid-usage' };
    return;
  }
  const session = task.sessions[launch.sessionId] ?? emptyTokenSession();
  const next = reduceTokenObservation(session, launch, ordinal, usage);
  task.sessions[launch.sessionId] = next.session;
  task.launches[launchId] = next.launch;
}

export function completeTokenLaunch(ledger, taskId, launchId, unknown = null) {
  const task = ledger.tasks[taskId];
  const launch = task.launches[launchId];
  launch.completed = true;
  if (!Object.keys(launch.observations).length) reason(launch, 'missing-usage');
  if (!launch.sessionId) reason(launch, 'unknown-session');
  if (unknown) reason(launch, unknown);
  const session = task.sessions[launch.sessionId];
  if (session) for (const value of launch.reasons) reason(session, value);
}

export function taskTokenStatus(ledger, taskId) {
  const data = ledger.version === 2 ? ledger : migrateTokenLedger(ledger);
  const task = data.tasks[taskId];
  const reasons = new Set();
  let blocked = false;
  if (ledger.writeErrors?.includes(taskId)) reasons.add('storage-error');
  if (ledger.writeErrors?.includes(taskId)) blocked = true;
  for (const session of Object.values(task?.sessions ?? {})) {
    for (const value of session.reasons) reasons.add(value);
    if (session.reasons.length && !acceptedTokenMinimum(session)) blocked = true;
  }
  for (const launch of Object.values(task?.launches ?? {})) {
    for (const value of launch.reasons) reasons.add(value);
    if (launch.reasons.length && !acceptedTokenMinimum(launch)) blocked = true;
    if (!launch.completed) {
      reasons.add('unfinished-launch');
      blocked = true;
    }
  }
  return {
    complete: reasons.size === 0,
    reasons: [...reasons],
    ...(reasons.size && !blocked ? { acceptedIncomplete: true } : {}),
  };
}

// Сначала сохраняем копию целиком; неудачная запись не делает retry пустой операцией.
export function commitTokenLedger(ledger, update, save) {
  const next = globalThis.structuredClone(ledger);
  update(next);
  migrateTokenLedger(next);
  if (JSON.stringify(next) === JSON.stringify(ledger)) return false;
  save(next);
  Object.assign(ledger, next);
  return true;
}

// Допуск по минимуму не утверждает полноту: исходные причины остаются для аудита и отката.
const RECOVERABLE_USAGE_REASONS = new Set([
  'missing-usage',
  'stdout-unavailable',
  'unreported-tail',
  'незавершённый turn',
]);
export function acceptedTokenMinimum(target) {
  const proof = target?.recovery;
  return (
    proof?.policy === 'interrupted-minimum-v1' &&
    proof.complete === false &&
    /^[a-f0-9]{64}$/.test(proof.digest ?? '') &&
    normalizeTokenUsage(proof.snapshot) !== null &&
    Array.isArray(proof.reasons) &&
    JSON.stringify(proof.snapshot) ===
      JSON.stringify(
        target.snapshot ?? (target.observations ? launchTokenSnapshot(target) : null),
      ) &&
    target.reasons.length > 0 &&
    target.reasons.every(
      (value) => RECOVERABLE_USAGE_REASONS.has(value) && proof.reasons.includes(value),
    )
  );
}

export function tokenAccountingAllowed(status) {
  return status.complete || status.acceptedIncomplete === true;
}

export function tokenAccountingNote(ledger, taskId) {
  const status = taskTokenStatus(ledger, taskId);
  return status.acceptedIncomplete
    ? 'Учтён подтверждённый минимум ' +
        taskTokens(ledger, taskId) +
        ' токенов; неизвестный хвост прерванного запуска сохранён. Продолжение разрешено политикой восстановления в пределах прежнего учётного бюджета.'
    : '';
}

/** Вызывается только для остановленной задачи; транзакцией владеет супервизор. */
export function recoverTokenLaunch(ledger, taskId, launchId, evidence) {
  const task = ledger.tasks[taskId];
  const launch = task?.launches[launchId];
  const session = task?.sessions[launch?.sessionId];
  if (
    !session ||
    !launch.completed ||
    launch.recovery ||
    !launch.reasons.length ||
    ![...session.reasons, ...launch.reasons].every((value) =>
      RECOVERABLE_USAGE_REASONS.has(value),
    ) ||
    Object.values(task.launches).filter((item) => item.sessionId === launch.sessionId).length !==
      1 ||
    !evidence?.ok ||
    evidence.source !== 'token_usage_record' ||
    typeof evidence.complete !== 'boolean' ||
    !/^[a-f0-9]{64}$/.test(evidence.digest ?? '')
  )
    return false;
  const snapshot = normalizeTokenUsage(evidence.snapshot);
  if (
    !snapshot ||
    snapshot.input_tokens + snapshot.output_tokens < session.knownTokens ||
    ['input_tokens', 'output_tokens'].some(
      (key) =>
        snapshot[key] < (session.snapshot?.[key] ?? 0) ||
        snapshot[key] < (launch.baseline?.[key] ?? 0),
    )
  )
    return false;
  const proof = {
    policy: 'interrupted-minimum-v1',
    complete: evidence.complete,
    digest: evidence.digest,
    turnId: evidence.turnId,
    snapshot,
    reasons: [...new Set([...session.reasons, ...launch.reasons])],
  };
  session.knownTokens = snapshot.input_tokens + snapshot.output_tokens;
  session.snapshot = snapshot;
  session.recovery = proof;
  launch.recovery = globalThis.structuredClone(proof);
  const ordinal = Math.max(0, ...Object.keys(launch.observations).map(Number)) + 1;
  launch.observations[ordinal] = snapshot;
  if (evidence.complete) {
    session.reasons = [];
    launch.reasons = [];
  }
  return true;
}
