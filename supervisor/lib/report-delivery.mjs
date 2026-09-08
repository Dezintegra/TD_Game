import { prepareReportPlan, transferReport as transferLegacyReport } from './report-plan.mjs';

function replaceId(value, before, after) {
  if (value === before) return after;
  if (Array.isArray(value)) return value.map((item) => replaceId(item, before, after));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceId(item, before, after)]),
    );
  return value;
}

/** Намерение переживает сбой; квитанция получателя решает судьбу повтора. */
export async function transferReport(action, io) {
  if (!io.reportStore || !action.reportId) return transferLegacyReport(action, io);
  const store = io.reportStore;
  let entry = store.get(action.reportId);
  if (!entry) return { result: 'skipped', why: 'report already acknowledged' };
  if (entry.taskId !== action.taskId || entry.stage !== action.stage)
    return { result: 'failed', why: 'report identity mismatch' };
  try {
    if (!entry.plan) {
      const task = io.readTask(entry.taskId);
      if (
        !task ||
        task.status !== entry.stage ||
        Date.parse(task.statusChangedAt) > Date.parse(entry.startedAt)
      ) {
        return { result: 'failed', why: `report delivery conflicts with ${entry.taskId}` };
      }
      const plan = await prepareReportPlan(action, { ...io, readReport: () => entry.report });
      store.update(entry.reportId, { plan });
      entry = store.get(entry.reportId);
    }
    if (entry.plan.version !== 1 || entry.plan.reportId !== entry.reportId)
      throw new Error('unsupported report delivery plan');
    for (let index = 0; index < entry.plan.operations.length; index += 1) {
      let operation = entry.plan.operations[index];
      if (entry.progress.includes(operation.key)) continue;
      const intent = `intent:${operation.key}`;
      if (!entry.progress.includes(intent)) {
        if (operation.kind === 'createTask' && io.reserveReportTask) {
          const reserved = await io.reserveReportTask(operation.args[0], operation);
          if (!reserved.ok) throw new Error(reserved.why ?? reserved.outcome);
          const oldId = operation.args[0].id;
          if (reserved.task.id !== oldId) {
            entry.plan = replaceId(entry.plan, oldId, reserved.task.id);
            operation = entry.plan.operations[index];
          }
        }
        store.update(entry.reportId, { plan: entry.plan, progress: [...entry.progress, intent] });
        entry = store.get(entry.reportId);
      }
      const args = operation.args;
      let result;
      if (operation.kind === 'saveTask')
        result = await io.saveTask(args[0], args[1], args[2], args[3] ?? [], operation);
      else if (operation.kind === 'release')
        result = (await io.release?.(...args, operation)) ?? { ok: true };
      else if (operation.kind === 'amendTask')
        result = await io.amendTask(args[0], args[1], args[2], args[3], args[4], operation);
      else if (['createTask', 'askOwner', 'recordAnswer'].includes(operation.kind))
        result = await io[operation.kind](...args, operation);
      else throw new Error(`unknown report operation ${operation.kind}`);
      if (!result?.ok)
        throw new Error(result?.why ?? result?.outcome ?? `unconfirmed ${operation.kind}`);
      store.update(entry.reportId, { progress: [...entry.progress, operation.key] });
      entry = store.get(entry.reportId);
    }
    for (const args of entry.plan.cleanup) await io.forgetSession?.(...args);
    store.acknowledge(entry.reportId);
    return entry.plan.result;
  } catch (error) {
    return { result: 'failed', why: `pending report ${entry.reportId}: ${error.message}` };
  }
}
