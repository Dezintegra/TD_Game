import { createHash } from 'node:crypto';
import { sameToolContext } from './stage-tool-health.mjs';

export const HISTORICAL_DIAGNOSTIC_TARGETS = Object.freeze({
  '0156-svesti-komandy-etapov-k-odnoy-obolochke-': ['revise', 'historical-revise'],
  '0208-zavesti-storozha-na-ssylki-po-nomeram-sh': ['revise', 'historical-revise'],
  '0175-razmetit-komandnye-bloki-supervisor-skil': ['revise', 'historical-revise-design'],
  '0074-zhurnal-zadachi-v-prompte-etapa-obrezaet': ['audit', 'historical-audit'],
});
const fields = ['schemaVersion', 'requestId', 'taskId', 'stage', 'sourceLaunchId', 'profile'];
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function parseDiagnosticRequest(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key)) ||
    value.schemaVersion !== 1 ||
    fields
      .slice(1)
      .some(
        (key) =>
          typeof value[key] !== 'string' ||
          !value[key] ||
          value[key].trim() !== value[key] ||
          value[key].length > 200,
      ) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value.requestId)
  )
    throw new Error('invalid diagnostic request');
  const target =
    Object.hasOwn(HISTORICAL_DIAGNOSTIC_TARGETS, value.taskId) &&
    HISTORICAL_DIAGNOSTIC_TARGETS[value.taskId];
  if (!target || target[0] !== value.stage || target[1] !== value.profile)
    throw new Error('unassigned diagnostic profile');
  const request = Object.fromEntries(fields.map((key) => [key, value[key]]));
  return { request, fingerprint: hash(JSON.stringify(request)) };
}

function sameSource(a, b) {
  return (
    a &&
    b &&
    sameToolContext(a.context, b.context) &&
    [
      'taskId',
      'stage',
      'cwd',
      'branch',
      'head',
      'providerVersion',
      'runtimeSha',
      'generation',
    ].every((key) => typeof a[key] === 'string' && a[key] && a[key] === b[key])
  );
}

/** Владелец передаёт проверки и общий захват scheduler; библиотека не трогает карточки. */
export function createAddressedToolDiagnostics({
  store,
  authorize = () => null,
  inspect = () => null,
  acquire = () => null,
  admit = () => ({ allowed: false }),
  diagnose,
  accounting,
  now = () => new Date().toISOString(),
}) {
  const active = new Set();
  const failures = new Set();
  const refused = (reason) => ({ ok: false, reason });
  function saved(id) {
    const verification = store.verifySaved();
    if (!verification.ok) throw new Error(verification.why);
    const entry = store.getDiagnostic(id);
    if (!entry) return refused('not-found');
    const bytes = JSON.stringify(entry);
    return { ok: true, entry, bytes, sha256: hash(bytes) };
  }
  async function check(request, authorization) {
    const current = await inspect(request, authorization);
    if (current?.busy) throw new Error('busy');
    if (
      current?.verified !== true ||
      !sameSource(authorization.source, current.source) ||
      current.source.taskId !== request.taskId ||
      current.source.stage !== request.stage ||
      current.source.cwd !== current.source.context.cwd
    )
      throw new Error('unverified-context-or-ownership');
    if (current.paused && authorization.duringPause !== true) throw new Error('manual-pause');
    const admission = await admit(request, authorization);
    if (admission?.allowed !== true) throw new Error(admission?.reason ?? 'launch-held');
    return current.source;
  }
  return {
    get blocked() {
      return failures.size > 0;
    },
    get activeCount() {
      return active.size;
    },
    async get(requestId) {
      try {
        const entry = store.getDiagnostic(requestId);
        if (!entry) return refused('not-found');
        const auth = await authorize(entry.request, entry.fingerprint, 'get');
        if (auth?.allowed !== true) return refused('unauthorized');
        return saved(requestId);
      } catch (error) {
        return refused(error.message);
      }
    },
    async submit(value) {
      let request;
      let release;
      try {
        const parsed = parseDiagnosticRequest(value);
        request = parsed.request;
        const { fingerprint } = parsed;
        const authorization = await authorize(request, fingerprint, 'submit');
        if (
          authorization?.allowed !== true ||
          authorization.fingerprint !== fingerprint ||
          authorization.generation !== authorization.source?.generation
        )
          return refused('unauthorized');
        const previous = store.getDiagnostic(request.requestId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) return refused('fingerprint-conflict');
          return saved(request.requestId);
        }
        if (
          active.has(request.taskId) ||
          failures.has(request.taskId) ||
          store
            .diagnosticEntries()
            .some(
              (entry) =>
                entry.request.taskId === request.taskId &&
                !['completed', 'refused'].includes(entry.state),
            )
        )
          return refused('busy');
        // Захват синхронен и общий с обычной выдачей; await до него не резервирует дерево.
        const reservation = acquire(request.taskId);
        if (typeof reservation !== 'function') return refused('busy');
        release = reservation;
        active.add(request.taskId);
        const source = await check(request, authorization);
        const startedAt = now();
        store.acceptDiagnostic(request, { fingerprint, source, authorization, at: startedAt });
        const meter = accounting({
          request,
          source,
          saveIntent: (launchId, control) =>
            store.diagnosticLaunchIntent(request.requestId, {
              launchId,
              control,
              startedAt: now(),
            }),
          saveRaw: (launchId, run, metadata) =>
            store.diagnosticRawResult(request.requestId, launchId, {
              ...run,
              diagnostic: metadata,
            }),
          readReceipt: (launchId) =>
            store
              .getDiagnostic(request.requestId)
              .launches.find((item) => item.launchId === launchId)?.receipt,
          saveReceipt: (launchId, receipt) =>
            store.diagnosticAccounted(request.requestId, launchId, receipt),
        });
        const result = await diagnose({
          request,
          source,
          profile: request.profile,
          onStart: async (launchId, control) => {
            await check(request, authorization);
            await meter.onStart(launchId, control);
            await check(request, authorization);
          },
          onResult: meter.onResult,
        });
        const launches = store.getDiagnostic(request.requestId).launches;
        if (result.accountingError || launches.some((launch) => launch.state !== 'accounted')) {
          failures.add(request.taskId);
          return refused(result.accountingError ?? 'accounting-pending');
        }
        // Полный raw остаётся в store; публичные первичные ссылки формирует host transport.
        const { runs, ...evidence } = result;
        store.completeDiagnostic(request.requestId, {
          requestId: request.requestId,
          source,
          startedAt,
          finishedAt: now(),
          evidence,
          primary: (runs ?? []).map((run) => ({
            launchId: run.launchId,
            sha256: hash(JSON.stringify(run)),
          })),
        });
        return saved(request.requestId);
      } catch (error) {
        if (
          request &&
          store.diagnosticEntries().some((entry) => entry.requestId === request.requestId)
        )
          failures.add(request.taskId);
        return refused(error.message);
      } finally {
        if (release) {
          active.delete(request.taskId);
          release();
        }
      }
    },
  };
}
