import { collectDependencyEvidence } from './dependency-evidence.mjs';

/** Общая сборка входов допуска для смотрящего цикла и живого супервизора. */
export async function buildDependencyState({
  backlog,
  config,
  root,
  run,
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
    dependencyEvidence: await collectDependencyEvidence({ ...state, config, root, run }),
  };
}
