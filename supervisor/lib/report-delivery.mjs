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

function renameRequest(entry, index, id) {
  const before = entry.plan.operations[index].args[0].id;
  // Ключ операции остаётся идентичностью заявки. Уже подтверждённые
  // операции и исходные снимки не переписываются при выборе её номера.
  for (const operation of entry.plan.operations) {
    if (entry.progress.includes(operation.key)) continue;
    operation.args = replaceId(operation.args, before, id);
  }
  entry.plan.result = replaceId(entry.plan.result, before, id);
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
          const reservedIds = entry.plan.operations
            .filter((item) => item.kind === 'createTask' && item.key !== operation.key)
            .map((item) => item.args[0].id);
          const reserved = await io.reserveReportTask(operation.args[0], operation, reservedIds);
          if (!reserved.ok) throw new Error(reserved.why ?? reserved.outcome);
          if (reservedIds.some((id) => id.split('-')[0] === reserved.task.id.split('-')[0]))
            throw new Error('request reservation conflicts with another planned operation');
          const oldId = operation.args[0].id;
          if (reserved.task.id !== oldId) {
            renameRequest(entry, index, reserved.task.id);
            operation = entry.plan.operations[index];
          }
        }
        store.update(entry.reportId, { plan: entry.plan, progress: [...entry.progress, intent] });
        entry = store.get(entry.reportId);
      }
      const args = operation.args;
      if (
        operation.kind === 'saveTask' &&
        args[0].id !== entry.taskId &&
        entry.report.consolidations?.some((item) =>
          [item.sourceId, item.targetId].includes(args[0].id),
        ) &&
        io.tokenActionBlocked?.(args[0].id)
      )
        throw new Error('участник поглощения занят; доставка отложена');
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
    // Отметка о выкладке ставится ЗДЕСЬ — после того как весь план применён
    // и принят, а не при его составлении. От неё считается срок следующего
    // пакета, и план, составленный, но не доехавший, отодвинул бы этот срок
    // на пять часов ни за что.
    //
    // Ставится она по состоявшейся выкладке: упавший заход срок не двигает.
    if (
      entry.stage === 'deploy' &&
      entry.report?.outcome === 'done' &&
      Array.isArray(entry.report?.batch)
    )
      io.markDeployed?.(io.now);
    return entry.plan.result;
  } catch (error) {
    return { result: 'failed', why: `pending report ${entry.reportId}: ${error.message}` };
  }
}
