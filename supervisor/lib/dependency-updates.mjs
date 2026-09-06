import { dependencyCycleProblem, dependencyFormatProblem } from './dependencies.mjs';

const fail = (why) => ({ ok: false, outcome: 'failed', why });

/** Дополнение не вправе ослаблять уже сохранённое условие или менять порядок. */
export function mergeDependencyUpdate(task, update) {
  const problem =
    dependencyFormatProblem(task) ?? dependencyFormatProblem({ ...update, id: task.id });
  if (problem) return fail(`${task.id}: ${problem}`);
  const dependsOn = [...(task.dependsOn ?? [])];
  const dependencyResults = (task.dependencyResults ?? []).map((item) => ({ ...item }));
  for (const id of update.dependsOn) if (!dependsOn.includes(id)) dependsOn.push(id);
  for (const result of update.dependencyResults) {
    const existing = dependencyResults.find((item) => item.taskId === result.taskId);
    if (existing && (existing.kind !== result.kind || existing.pr !== result.pr))
      return fail(
        `${task.id}: конфликт результата ${result.taskId}, PR ${existing.pr} / ${result.pr}`,
      );
    if (!existing) dependencyResults.push({ ...result });
  }
  const candidate = { ...task, dependsOn, dependencyResults };
  const mergedProblem = dependencyFormatProblem(candidate);
  return mergedProblem ? fail(`${task.id}: ${mergedProblem}`) : { ok: true, task: candidate };
}

/** Коллекция сохраняет архивные и негодные совпадения до разрешения адресатов. */
export function planDependencyUpdates(updates, sourceId, records) {
  if (updates === undefined) return { ok: true, updates: [], tasks: [] };
  if (!Array.isArray(updates)) return fail('dependencyUpdates: ожидается массив');
  const seen = new Set();
  const candidates = [];
  for (const [index, update] of updates.entries()) {
    const prefix = `dependencyUpdates[${index}] (${update?.taskId ?? '?'})`;
    if (
      !update ||
      typeof update !== 'object' ||
      Array.isArray(update) ||
      Object.keys(update).length !== 4 ||
      !['taskId', 'dependsOn', 'dependencyResults', 'reason'].every((key) =>
        Object.hasOwn(update, key),
      )
    )
      return fail(`${prefix}: ожидаются taskId, dependsOn, dependencyResults, reason`);
    // Тот же валидатор полного ID, без второго определения его формы.
    if (dependencyFormatProblem({ dependsOn: [update.taskId] }))
      return fail(`${prefix}: нужен полный ID адресата`);
    if (typeof update.reason !== 'string' || !update.reason.trim())
      return fail(`${prefix}: пустое reason`);
    if (!Array.isArray(update.dependsOn) || !update.dependsOn.length)
      return fail(`${prefix}: dependsOn должен быть непустым`);
    const problem = dependencyFormatProblem({ ...update, id: update.taskId });
    if (problem) return fail(`${prefix}: ${problem}`);
    if (seen.has(update.taskId)) return fail(`${prefix}: повтор адресата`);
    seen.add(update.taskId);
    const matches = records.filter((item) => item.id === update.taskId);
    if (matches.length !== 1) return fail(`${prefix}: адресат отсутствует или неоднозначен`);
    const target = matches[0];
    if (
      target.valid === false ||
      target.archived ||
      target.status === 'closed' ||
      target.id === sourceId
    )
      return fail(`${prefix}: недопустимый адресат`);
    const merged = mergeDependencyUpdate(target, update);
    if (!merged.ok) return merged;
    candidates.push(merged.task);
  }
  const graph = records.map((item) => candidates.find((task) => task.id === item.id) ?? item);
  for (const task of candidates) {
    const problem = dependencyCycleProblem(task, graph);
    if (problem) return fail(`${task.id}: ${problem}`);
  }
  return { ok: true, updates, tasks: candidates };
}
