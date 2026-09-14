import { randomUUID } from 'node:crypto';
import { countSpawnFailure } from './task-file.mjs';
import { launchCharge } from './tool-work-evidence.mjs';

export function matchingRetryClaim(entry, assignment) {
  const claim = assignment.infrastructureRetry;
  return Boolean(
    entry &&
    entry.disposition === 'retry-claimed' &&
    entry.reportId === claim?.reportId &&
    entry.launchId === claim.sourceLaunchId &&
    entry.retry?.newLaunchId === assignment.launchId &&
    entry.taskId === assignment.taskId &&
    entry.stage === assignment.stage &&
    entry.retry.recovery?.verdict === 'healthy',
  );
}

function available(store, entry, extra = {}) {
  store.update(entry.reportId, {
    disposition: 'retry-ready',
    retry: {
      ...entry.retry,
      ...extra,
      state: 'available',
      newLaunchId: null,
      spawnState: null,
    },
  });
}

async function handoff(store, entry) {
  store.update(entry.reportId, {
    disposition: 'settled',
    retry: { ...entry.retry, state: 'consumed' },
  });
  store.archive(entry.reportId);
  store.acknowledge(entry.reportId);
  return { result: 'done', status: entry.stage, why: 'replacement handoff confirmed' };
}

/** The active envelope is the entitlement. Neither a report nor a timer grants another. */
export async function retryToolStage(action, io) {
  const store = io.reportStore;
  let entry = store?.get(action.reportId);
  if (!entry || entry.taskId !== action.taskId || entry.stage !== action.stage)
    return { result: 'skipped', why: 'retry envelope does not match' };
  if (entry.stage === 'deploy')
    return { result: 'skipped', why: 'deploy effects are not verified' };
  try {
    if (entry.disposition === 'settled') return await handoff(store, entry);
    if (entry.disposition === 'retry-claimed') {
      if (entry.retry.failurePlan) return await finishFailedSpawn(store, entry, io);
      const seen = io.inspectRetryLaunch?.(entry) ?? { state: 'unknown' };
      if (seen.state === 'born') return await handoff(store, entry);
      if (seen.state === 'absent') available(store, entry);
      return {
        result: 'skipped',
        why:
          seen.state === 'absent'
            ? 'unstarted claim restored'
            : 'replacement spawn remains uncertain',
      };
    }
    if (
      entry.disposition !== 'retry-ready' ||
      entry.retry?.state !== 'available' ||
      entry.retry.recovery?.verdict !== 'healthy'
    )
      return { result: 'skipped', why: 'retry is not ready' };
    const gate = io.mayLaunch?.(entry.assignment);
    if (gate && !gate.allowed) return { result: 'skipped', why: gate.why ?? 'availability-held' };
    let task = io.readTask(entry.taskId);
    if (!task || task.status !== entry.stage || (task.owner && task.owner !== io.machine))
      return { result: 'skipped', why: 'retry source ownership changed' };
    if (io.tokenAdmission?.(task, entry.stage) || io.tokenReanalysisAdmission?.(task, entry.stage))
      return { result: 'skipped', why: 'token admission holds replacement' };
    if (io.requiresFreshStart) {
      const acquired = await io.acquire(task);
      if (!acquired.ok)
        return { result: 'skipped', why: acquired.why ?? 'retry ownership is unavailable' };
      const fresh = await io.readStartTask(task, { evidence: io.dependencyEvidence ?? {} });
      if (!fresh.ok) return { result: 'skipped', why: fresh.why };
      task = fresh.task;
    }
    const registry = io.registryEntry(entry.taskId);
    if (
      entry.assignment.path &&
      (registry?.path !== entry.assignment.path || registry.branch !== entry.assignment.branch)
    )
      return { result: 'skipped', why: 'retry workspace changed' };
    const newLaunchId = randomUUID();
    const submitted = Boolean(entry.originalResult.parsedReport ?? entry.report);
    const sessionId = submitted ? null : (io.lastSession?.(entry.taskId, entry.stage) ?? null);
    const assignment = {
      ...entry.assignment,
      task,
      launchId: newLaunchId,
      charge: launchCharge(newLaunchId),
      sessionId,
      continuation: Boolean(sessionId),
      reason: 'замещающий запуск после подтверждённого восстановления инструментов',
      infrastructureRetry: { reportId: entry.reportId, sourceLaunchId: entry.launchId },
      toolRecovery: {
        reportId: entry.reportId,
        originalReport: entry.originalResult.parsedReport ?? entry.report,
        diagnosis: entry.evidence,
        recovery: entry.retry.recovery,
        git: entry.git,
      },
    };
    store.update(entry.reportId, {
      disposition: 'retry-claimed',
      retry: { ...entry.retry, state: 'claimed', newLaunchId, spawnState: 'prepared', assignment },
    });
    const spawned = io.spawnStage(assignment);
    entry = store.get(entry.reportId);
    if (!spawned.ok) {
      if (['busy', 'availability-held'].includes(spawned.reason)) {
        available(store, entry, spawned.retryRecheck ? { recovery: null } : {});
        return { result: 'skipped', why: spawned.why };
      }
      if (spawned.reason !== 'not-born')
        return { result: 'skipped', why: 'unrecognized spawn result retained' };
      const operation = { key: `${entry.reportId}:not-born:${newLaunchId}`, expected: task };
      const args = [
        countSpawnFailure(task),
        {
          at: io.now,
          from: task.status,
          to: task.status,
          problem: `Замещающий этап не запустился: ${spawned.why}.`,
        },
        'chore(pipeline): record failed replacement spawn',
      ];
      store.update(entry.reportId, { retry: { ...entry.retry, failurePlan: { args, operation } } });
      return await finishFailedSpawn(store, store.get(entry.reportId), io);
    }
    const seen = io.inspectRetryLaunch?.(entry) ?? { state: 'unknown' };
    if (seen.state !== 'born')
      return { result: 'skipped', why: 'replacement birth not durably confirmed' };
    io.recordSchedulingLaunch?.(task);
    return await handoff(store, entry);
  } catch (error) {
    return { result: 'failed', why: `retained tool retry ${entry.reportId}: ${error.message}` };
  }
}

async function finishFailedSpawn(store, entry, io) {
  const { args, operation } = entry.retry.failurePlan;
  const written = await io.saveTask(...args, [], operation);
  if (!written.ok) return { result: 'failed', why: written.why ?? written.outcome };
  available(store, entry, { failurePlan: null });
  return { result: 'failed', why: 'replacement did not start; entitlement preserved' };
}
