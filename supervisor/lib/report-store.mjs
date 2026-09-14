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

export const REPORT_STORE_VERSION = 2;
const dispositions = [
  'ordinary',
  'diagnosing',
  'infrastructure-held',
  'retry-ready',
  'retry-claimed',
  'settled',
];

function validate(value) {
  if (![1, REPORT_STORE_VERSION].includes(value?.version))
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
  return value.reports;
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
  try {
    reports = validate(JSON.parse(disk.readFileSync(path, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error(`report store ${path}: ${error.message}`, { cause: error });
    reports = [];
  }
  function commit(next) {
    const data = JSON.stringify({ version: REPORT_STORE_VERSION, reports: next });
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
      reports = JSON.parse(data).reports;
    } catch (error) {
      throw new Error(`report store ${path}: ${error.message}`, { cause: error });
    } finally {
      if (fd !== undefined) disk.closeSync(fd);
    }
  }
  return {
    entries: () => structuredClone(reports),
    get: (id) => structuredClone(reports.find((entry) => entry.reportId === id) ?? null),
    verifySaved() {
      try {
        const saved = validate(JSON.parse(disk.readFileSync(path, 'utf8')));
        if (JSON.stringify(saved) !== JSON.stringify(reports))
          return { ok: false, count: 0, why: 'очередь на диске отличается от принятой в памяти' };
        return { ok: true, count: saved.length };
      } catch (error) {
        if (error.code === 'ENOENT' && reports.length === 0) return { ok: true, count: 0 };
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
