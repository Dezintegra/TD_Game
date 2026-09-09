import { isAbsolute, normalize } from 'node:path';

export const tuningKeys = ['income', 'speed', 'towerHealth', 'baseHealth', 'unitRadius', 'map'];
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
export const pairKey = (pair) => JSON.stringify([pair.mutationId, pair.testFile, pair.fullName]);

export function validateCatalog({ mutations, pairs }) {
  const errors = [];
  if (!Array.isArray(mutations) || !Array.isArray(pairs))
    return ['Expected mutations and pairs arrays'];
  if (!pairs.length) errors.push('Empty pairs');
  const ids = new Set();
  for (const mutation of mutations) {
    if (!mutation || !nonempty(mutation.id) || ids.has(mutation.id)) {
      errors.push('Missing or duplicate mutation id');
      continue;
    }
    ids.add(mutation.id);
    const entries = Object.entries(mutation.tuning ?? {});
    if (
      !nonempty(mutation.description) ||
      !entries.length ||
      entries.some(
        ([key, value]) => !tuningKeys.includes(key) || !Number.isFinite(value) || value <= 0,
      ) ||
      entries.every(([, value]) => value === 1)
    )
      errors.push(`Invalid mutation: ${mutation.id}`);
  }
  const seen = new Set();
  for (const pair of pairs) {
    if (!pair) {
      errors.push('Invalid pair');
      continue;
    }
    const key = pairKey(pair);
    if (
      !ids.has(pair.mutationId) ||
      seen.has(key) ||
      !nonempty(pair.testFile) ||
      isAbsolute(pair.testFile) ||
      normalize(pair.testFile).split(/[\\/]/).includes('..') ||
      !Array.isArray(pair.fullName) ||
      !pair.fullName.length ||
      !pair.fullName.every(nonempty) ||
      !nonempty(pair.rationale) ||
      !tuningKeys.includes(pair.probe)
    )
      errors.push(`Invalid pair: ${key}`);
    seen.add(key);
  }
  return errors;
}

// Не доверяем одному коду возврата: отчёт обязан доказать выполнение тела.
export function phaseError(report, expected) {
  if (
    !report ||
    report.runId !== expected.runId ||
    report.phase !== expected.phase ||
    report.pairKey !== pairKey(expected.pair)
  )
    return 'Missing or foreign report';
  if (report.error || report.runnerErrors?.length || report.hookErrors?.length)
    return report.error || 'Runner or hook error';
  if (
    report.selectedCount !== 1 ||
    report.bodyEntered !== true ||
    report.bodyExited !== true ||
    report.testFile !== expected.pair.testFile ||
    JSON.stringify(report.fullName) !== JSON.stringify(expected.pair.fullName)
  )
    return 'Selected test was not executed exactly once';
  if (
    report.tuningVerified !== true ||
    report.sharedVerified !== true ||
    (expected.phase === 'mutant' && report.derivedChanged !== true)
  )
    return 'Tuning was not verified';
  if (!['passed', 'failed'].includes(report.status)) return 'Test skipped or incomplete';
  if (report.status === 'failed' && report.assertionFailure !== true)
    return 'Non-assertion failure';
  return null;
}

export function classifyPair(pair, baseline, mutant, runId) {
  const baselineError = phaseError(baseline, { pair, phase: 'baseline', runId });
  if (baselineError || baseline.status !== 'passed')
    return { status: 'error', reason: baselineError || 'Baseline failed' };
  const mutantError = phaseError(mutant, { pair, phase: 'mutant', runId });
  if (mutantError) return { status: 'error', reason: mutantError };
  return { status: mutant.status === 'failed' ? 'detected' : 'survived' };
}

export function summarize(results) {
  const counts = Object.fromEntries(
    ['detected', 'survived', 'uncovered', 'error'].map((status) => [
      status,
      results.filter((result) => result.status === status).length,
    ]),
  );
  return {
    counts,
    exitCode: counts.error || counts.detected + counts.survived === 0 ? 2 : counts.survived ? 1 : 0,
  };
}
