import * as fs from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const { structuredClone } = globalThis;
const text = (value) => typeof value === 'string' && value.trim().length > 0;

function validRejection(entry) {
  if (entry.rejection === undefined || entry.rejection === null) return true;
  return (
    entry.plan == null &&
    entry.progress?.length === 0 &&
    entry.rejection.kind === 'invalid-report' &&
    text(entry.rejection.why) &&
    text(entry.rejection.at) &&
    Number.isFinite(Date.parse(entry.rejection.at))
  );
}

export const REPORT_STORE_VERSION = 3;
const dispositions = [
  'ordinary',
  'diagnosing',
  'infrastructure-held',
  'retry-ready',
  'retry-claimed',
  'settled',
];

function validate(value) {
  if (![1, 2, REPORT_STORE_VERSION].includes(value?.version))
    throw new Error('unsupported report store version');
  if (!Array.isArray(value.reports)) throw new Error('invalid report queue');
  const ids = new Set();
  for (const entry of value.reports) {
    if (value.version === 1 && entry) entry.disposition = 'ordinary';
    if (
      !entry ||
      !['reportId', 'taskId', 'stage'].every(
        (key) => typeof entry[key] === 'string' && entry[key],
      ) ||
      !dispositions.includes(entry.disposition) ||
      (entry.report === null
        ? entry.disposition === 'ordinary'
        : !entry.report || typeof entry.report !== 'object' || Array.isArray(entry.report)) ||
      (entry.disposition !== 'ordinary' &&
        (!text(entry.launchId) ||
          !entry.originalResult ||
          !Array.isArray(entry.batch) ||
          !['known', 'unknown'].includes(entry.git?.state) ||
          !['not-required', 'pending', 'confirmed'].includes(entry.charge?.state))) ||
      !Array.isArray(entry.progress) ||
      !validRejection(entry) ||
      ids.has(entry.reportId)
    )
      throw new Error('invalid report envelope');
    ids.add(entry.reportId);
  }
  if (value.version < 3 && Object.hasOwn(value, 'diagnosticRequests'))
    throw new Error('diagnostic collection in legacy store');
  const diagnosticRequests = value.version < 3 ? [] : value.diagnosticRequests;
  if (!Array.isArray(diagnosticRequests)) throw new Error('invalid diagnostic collection');
  const requestIds = new Set();
  for (const entry of diagnosticRequests) {
    if (
      !entry ||
      !text(entry.requestId) ||
      !text(entry.fingerprint) ||
      !entry.request ||
      entry.request.requestId !== entry.requestId ||
      !entry.source ||
      !entry.authorization ||
      !text(entry.createdAt) ||
      !['accepted', 'running', 'completed', 'refused', 'uncertain'].includes(entry.state) ||
      !Array.isArray(entry.launches) ||
      requestIds.has(entry.requestId) ||
      (['completed', 'refused'].includes(entry.state) && !entry.result)
    )
      throw new Error('invalid diagnostic request');
    const launches = new Set();
    for (const launch of entry.launches) {
      if (
        !text(launch.launchId) ||
        !text(launch.startedAt) ||
        !launch.control ||
        !['intent', 'raw', 'accounted'].includes(launch.state) ||
        launches.has(launch.launchId) ||
        (launch.state !== 'intent' && !launch.run) ||
        (launch.state === 'accounted' && !launch.receipt)
      )
        throw new Error('invalid diagnostic launch');
      launches.add(launch.launchId);
    }
    requestIds.add(entry.requestId);
  }
  return { reports: value.reports, diagnosticRequests };
}

/** Совпадение этапа не доказывает совпадение запуска после возврата задачи. */
export function sameReportLaunch(entry, launch) {
  if (entry.taskId !== launch.taskId || entry.stage !== launch.stage) return false;
  if (launch.launchId) return Boolean(entry.launchId && entry.launchId === launch.launchId);
  return Boolean(
    entry.startedAt &&
    entry.machine &&
    entry.startedAt === launch.startedAt &&
    entry.machine === launch.machine,
  );
}

/** Единственный владелец замка пишет синхронно: завершения не обгоняют фиксацию. */
export function openReportStore(path, { disk = fs, uuid = randomUUID } = {}) {
  let reports;
  let diagnosticRequests;
  try {
    ({ reports, diagnosticRequests } = validate(JSON.parse(disk.readFileSync(path, 'utf8'))));
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error(`report store ${path}: ${error.message}`, { cause: error });
    reports = [];
    diagnosticRequests = [];
  }
  const restored = new Set(
    diagnosticRequests.filter((entry) => entry.state === 'running').map((entry) => entry.requestId),
  );
  let pendingDiagnostics = null;
  function commit(next, diagnostics = diagnosticRequests) {
    if (pendingDiagnostics && diagnostics !== pendingDiagnostics)
      throw new Error('diagnostic storage pending');
    const data = JSON.stringify({
      version: REPORT_STORE_VERSION,
      reports: next,
      diagnosticRequests: diagnostics,
    });
    validate(JSON.parse(data));
    const temporary = `${path}.tmp`;
    let fd;
    try {
      disk.mkdirSync(dirname(path), { recursive: true });
      fd = disk.openSync(temporary, 'w');
      disk.writeFileSync(fd, data, 'utf8');
      disk.fsyncSync(fd);
      disk.closeSync(fd);
      fd = undefined;
      disk.renameSync(temporary, path);
      if (disk.readFileSync(path, 'utf8') !== data) throw new Error('store readback failed');
      reports = JSON.parse(data).reports;
      diagnosticRequests = JSON.parse(data).diagnosticRequests;
    } catch (error) {
      throw new Error(`report store ${path}: ${error.message}`, { cause: error });
    } finally {
      if (fd !== undefined) disk.closeSync(fd);
    }
  }
  function diagnostic(id) {
    const entry = diagnosticRequests.find((item) => item.requestId === id);
    if (!entry) throw new Error(`unknown diagnostic request ${id}`);
    return entry;
  }
  function changeDiagnostic(id, transform) {
    if (pendingDiagnostics) throw new Error('diagnostic storage pending');
    const next = diagnosticRequests.map((entry) =>
      entry.requestId === id ? transform(structuredClone(entry)) : entry,
    );
    validate(
      JSON.parse(
        JSON.stringify({ version: REPORT_STORE_VERSION, reports, diagnosticRequests: next }),
      ),
    );
    try {
      commit(reports, next);
    } catch (error) {
      // После завершения процесса повторяется запись, а не запуск.
      pendingDiagnostics = next;
      throw error;
    }
    return structuredClone(diagnostic(id));
  }
  return {
    diagnosticEntries: () => structuredClone(diagnosticRequests),
    getDiagnostic(id) {
      if (pendingDiagnostics) throw new Error('diagnostic storage pending');
      const entry = diagnosticRequests.find((item) => item.requestId === id);
      return entry
        ? structuredClone({ ...entry, ...(restored.has(id) ? { state: 'uncertain' } : {}) })
        : null;
    },
    acceptDiagnostic(request, { fingerprint, source, authorization, at }) {
      if (pendingDiagnostics) throw new Error('diagnostic storage pending');
      const previous = diagnosticRequests.find((entry) => entry.requestId === request.requestId);
      if (previous) {
        if (
          previous.fingerprint !== fingerprint ||
          JSON.stringify(previous.request) !== JSON.stringify(request)
        )
          throw new Error('diagnostic fingerprint conflict');
        return this.getDiagnostic(request.requestId);
      }
      const entry = {
        requestId: request.requestId,
        request,
        fingerprint,
        source,
        authorization,
        createdAt: at,
        state: 'accepted',
        launches: [],
        result: null,
      };
      commit(reports, [...diagnosticRequests, entry]);
      return this.getDiagnostic(request.requestId);
    },
    diagnosticLaunchIntent(id, launch) {
      const entry = diagnostic(id);
      if (
        restored.has(id) ||
        !['accepted', 'running'].includes(entry.state) ||
        entry.launches.some(
          (item) => item.state !== 'accounted' || item.launchId === launch.launchId,
        )
      )
        throw new Error('diagnostic launch uncertain or closed');
      return changeDiagnostic(id, (current) => ({
        ...current,
        state: 'running',
        launches: [...current.launches, { ...launch, state: 'intent' }],
      }));
    },
    diagnosticRawResult(id, launchId, run) {
      const launch = diagnostic(id).launches.find((item) => item.launchId === launchId);
      if (!launch) throw new Error('unknown diagnostic launch');
      if (launch.run) {
        if (JSON.stringify(launch.run) !== JSON.stringify(run))
          throw new Error('diagnostic raw conflict');
        return this.getDiagnostic(id);
      }
      return changeDiagnostic(id, (entry) => ({
        ...entry,
        launches: entry.launches.map((item) =>
          item.launchId === launchId ? { ...item, state: 'raw', run } : item,
        ),
      }));
    },
    diagnosticAccounted(id, launchId, receipt) {
      const launch = diagnostic(id).launches.find((item) => item.launchId === launchId);
      if (!launch?.run) throw new Error('diagnostic raw result required');
      if (launch.receipt && JSON.stringify(launch.receipt) !== JSON.stringify(receipt))
        throw new Error('diagnostic receipt conflict');
      return changeDiagnostic(id, (entry) => ({
        ...entry,
        launches: entry.launches.map((item) =>
          item.launchId === launchId ? { ...item, state: 'accounted', receipt } : item,
        ),
      }));
    },
    completeDiagnostic(id, result, state = 'completed') {
      const entry = diagnostic(id);
      if (!['completed', 'refused', 'uncertain'].includes(state))
        throw new Error('invalid diagnostic completion');
      if (entry.result) {
        if (JSON.stringify(entry.result) !== JSON.stringify(result) || entry.state !== state)
          throw new Error('diagnostic completion conflict');
        return this.getDiagnostic(id);
      }
      if (state === 'completed' && entry.launches.some((launch) => launch.state !== 'accounted'))
        throw new Error('diagnostic accounting pending');
      const saved = changeDiagnostic(id, (current) => ({ ...current, state, result }));
      restored.delete(id);
      return saved;
    },
    retryDiagnosticStorage() {
      if (!pendingDiagnostics) return;
      commit(reports, pendingDiagnostics);
      pendingDiagnostics = null;
    },
    entries: () => structuredClone(reports),
    get: (id) => structuredClone(reports.find((entry) => entry.reportId === id) ?? null),
    archive(id) {
      const entry = reports.find((item) => item.reportId === id);
      if (!entry) throw new Error(`unknown report ${id}`);
      const target = `${path}.diagnostics/${encodeURIComponent(id)}.json`;
      disk.mkdirSync(dirname(target), { recursive: true });
      const data = JSON.stringify(entry);
      const fd = disk.openSync(`${target}.tmp`, 'w');
      try {
        disk.writeFileSync(fd, data, 'utf8');
        disk.fsyncSync(fd);
      } finally {
        disk.closeSync(fd);
      }
      disk.renameSync(`${target}.tmp`, target);
      if (disk.readFileSync(target, 'utf8') !== data)
        throw new Error('diagnostic archive readback failed');
    },
    verifySaved() {
      if (pendingDiagnostics) return { ok: false, count: 0, why: 'diagnostic storage pending' };
      try {
        const saved = validate(JSON.parse(disk.readFileSync(path, 'utf8')));
        if (JSON.stringify(saved) !== JSON.stringify({ reports, diagnosticRequests }))
          return { ok: false, count: 0, why: 'очередь на диске отличается от принятой в памяти' };
        return { ok: true, count: saved.reports.length };
      } catch (error) {
        if (error.code === 'ENOENT' && reports.length === 0 && diagnosticRequests.length === 0)
          return { ok: true, count: 0 };
        return {
          ok: false,
          count: 0,
          why: `сохранность очереди не подтверждена: ${error.message}`,
        };
      }
    },
    accept(report, launch = {}) {
      const context = { ...launch, taskId: report.taskId, stage: report.stage };
      const existing = reports.find((entry) => sameReportLaunch(entry, context));
      if (existing) return structuredClone(existing);
      const entry = {
        reportId: uuid(),
        taskId: report.taskId,
        stage: report.stage,
        launchId: launch.launchId ?? null,
        startedAt: launch.startedAt ?? null,
        machine: launch.machine ?? null,
        disposition: 'ordinary',
        report: structuredClone(report),
        plan: null,
        progress: [],
      };
      commit([...reports, entry]);
      return structuredClone(entry);
    },
    retain(result, launch) {
      const existing = reports.find((entry) => sameReportLaunch(entry, launch));
      if (existing) return structuredClone(existing);
      const entry = {
        reportId: uuid(),
        taskId: launch.taskId,
        stage: launch.stage,
        launchId: launch.launchId,
        startedAt: launch.startedAt,
        machine: launch.machine,
        disposition: 'diagnosing',
        report: structuredClone(result.report ?? null),
        originalResult: structuredClone(result),
        assignment: structuredClone(launch.assignment ?? {}),
        batch: structuredClone(launch.batch ?? []),
        charge: structuredClone(launch.charge ?? { state: 'pending', launchId: launch.launchId }),
        git: structuredClone(launch.git ?? { state: 'unknown', reason: 'not-inspected' }),
        context: structuredClone(launch.context ?? null),
        evidence: null,
        retry: null,
        plan: null,
        progress: [],
      };
      commit([...reports, entry]);
      return structuredClone(entry);
    },
    update(id, { plan, progress, disposition, evidence, retry, charge, git } = {}) {
      if (!reports.some((entry) => entry.reportId === id)) throw new Error(`unknown report ${id}`);
      const current = reports.find((entry) => entry.reportId === id);
      if (disposition && disposition !== 'ordinary' && current.disposition === 'ordinary')
        throw new Error('cannot reclassify ordinary delivery');
      if (charge && charge.launchId !== current.launchId)
        throw new Error('charge belongs to another launch');
      commit(
        reports.map((entry) =>
          entry.reportId === id
            ? {
                ...entry,
                ...(plan === undefined ? {} : { plan }),
                ...(progress === undefined ? {} : { progress }),
                ...(disposition === undefined ? {} : { disposition }),
                ...(evidence === undefined ? {} : { evidence }),
                ...(retry === undefined ? {} : { retry }),
                ...(charge === undefined ? {} : { charge }),
                ...(git === undefined ? {} : { git }),
              }
            : entry,
        ),
      );
    },
    reject(id, { why, at }) {
      const entry = reports.find((item) => item.reportId === id);
      if (!entry) throw new Error(`unknown report ${id}`);
      // После первой записи ошибка может означать потерянное подтверждение.
      if (entry.plan != null || entry.progress.length)
        throw new Error('cannot reject a planned report');
      commit(
        reports.map((item) =>
          item.reportId === id ? { ...item, rejection: { kind: 'invalid-report', why, at } } : item,
        ),
      );
    },
    retry(id) {
      if (!reports.some((entry) => entry.reportId === id)) throw new Error(`unknown report ${id}`);
      commit(
        reports.map((entry) => (entry.reportId === id ? { ...entry, rejection: null } : entry)),
      );
    },
    acknowledge(id) {
      if (reports.some((entry) => entry.reportId === id))
        commit(reports.filter((entry) => entry.reportId !== id));
    },
  };
}
