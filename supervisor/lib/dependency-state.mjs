import { collectReconciliation } from './backlog-reconciliation.mjs';
import { collectDependencyEvidence } from './dependency-evidence.mjs';

/** Общая сборка входов допуска для смотрящего цикла и живого супервизора. */
export async function buildDependencyState({
  backlog,
  config,
  root,
  run,
  machine,
  now = new Date().toISOString(),
  running = [],
  reports = [],
}) {
  const state = {
    tasks: backlog.tasks,
    invalid: backlog.invalid ?? [],
    marked: backlog.marked ?? [],
    closedDependencyIds: backlog.closedDependencyIds ?? [],
    dependencyRecords: backlog.dependencyRecords ?? [],
    running,
    reports,
  };
  return {
    ...state,
    reconciliationReady: true,
    reconciliationEvidence: await collectReconciliation({
      ...state,
      root,
      run,
      config,
      machine,
      now,
    }),
    dependencyEvidence: await collectDependencyEvidence({ ...state, config, root, run }),
  };
}
