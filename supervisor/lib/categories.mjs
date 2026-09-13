import { delayStateProblem } from './delay-analysis.mjs';

export const CATEGORIES = ['ux', 'mechanics', 'balance', 'infrastructure'];

export function categoriesProblem(value, required = false) {
  if (value === undefined && !required) return null;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => !CATEGORIES.includes(item)) ||
    new Set(value).size !== value.length
  )
    return `categories: нужен непустой список без повторов из ${CATEGORIES.join(', ')}`;
  return null;
}

// Эти поля принадлежат протоколу ожидания, а не колонке или меткам Trello.
export const ROUTING_FIELDS = [
  'delayAnalysis',
  'delayJournal',
  'creationKey',
  'blockedContext',
  'reanalysis',
  'analysisGeneration',
  'spentUsd',
];
export function routingFields(value) {
  return Object.fromEntries(
    ROUTING_FIELDS.filter((key) => Object.hasOwn(value ?? {}, key)).map((key) => [key, value[key]]),
  );
}

export function routingProblem(task) {
  const delayProblem = delayStateProblem(task);
  if (delayProblem) return delayProblem;
  if (task.reanalysis !== undefined && typeof task.reanalysis !== 'boolean')
    return 'reanalysis не boolean';
  if (
    task.analysisGeneration !== undefined &&
    (!Number.isSafeInteger(task.analysisGeneration) || task.analysisGeneration < 0)
  )
    return 'analysisGeneration не целое неотрицательное число';
  const context = task.blockedContext;
  if (context === undefined && task.status !== 'blocked') return null;
  if (
    !context ||
    typeof context !== 'object' ||
    Array.isArray(context) ||
    typeof context.operation !== 'string' ||
    !context.operation ||
    !Number.isFinite(context.priority) ||
    context.priority < 0 ||
    typeof context.from !== 'string' ||
    !Array.isArray(context.reasons) ||
    !context.reasons.length
  )
    return 'неполный blockedContext';
  for (const reason of context.reasons) {
    if (
      !reason ||
      typeof reason.taskId !== 'string' ||
      !task.dependsOn?.includes(reason.taskId) ||
      typeof reason.reason !== 'string' ||
      !reason.reason.trim() ||
      typeof reason.result !== 'string' ||
      !reason.result.trim()
    )
      return 'blockedContext: каждому предшественнику нужны ссылка, reason и result';
  }
  return null;
}
