// Старые слаги обрезались на сороковом знаке, иногда на дефисе. Такой
// полный ID уже существует на доске и не должен терять свои зависимости.
const TASK_ID = /^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*-?$/;

/** Неверные зависимости удерживают задачу, а не превращаются в пустой список. */
export function dependencyFormatProblem(task) {
  const ids = Object.hasOwn(task, 'dependsOn') ? task.dependsOn : [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !TASK_ID.test(id))) {
    return 'dependsOn должен быть массивом полных идентификаторов задач';
  }
  if (ids.includes(task.id)) return `самоссылка ${task.id}`;
  if (new Set(ids).size !== ids.length) return 'dependsOn содержит повторные идентификаторы';
  if (Object.hasOwn(task, 'splitInto')) {
    const parts = task.splitInto;
    if (
      !Array.isArray(parts) ||
      parts.length === 0 ||
      parts.some((id) => typeof id !== 'string' || !TASK_ID.test(id))
    )
      return 'splitInto должен быть непустым массивом полных идентификаторов задач';
    if (parts.includes(task.id)) return `самоссылка splitInto ${task.id}`;
    if (new Set(parts).size !== parts.length) return 'splitInto содержит повторные идентификаторы';
  }
  if (Object.hasOwn(task, 'dependencyResults')) {
    const results = task.dependencyResults;
    if (!Array.isArray(results)) return 'dependencyResults должен быть массивом';
    const seen = new Set();
    for (const result of results) {
      if (
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        Object.keys(result).length !== 3 ||
        !Object.hasOwn(result, 'taskId') ||
        !Object.hasOwn(result, 'kind') ||
        !Object.hasOwn(result, 'pr') ||
        result.kind !== 'merged-pr' ||
        !Number.isInteger(result.pr) ||
        result.pr <= 0 ||
        !ids.includes(result.taskId)
      )
        return 'dependencyResults: ожидается { taskId из dependsOn, kind: merged-pr, pr: положительное целое }';
      if (seen.has(result.taskId)) return `dependencyResults: повтор ${result.taskId}`;
      seen.add(result.taskId);
    }
  }
  return null;
}

/** Для результата архивные ID недостаточны; негодные дубликаты тоже учитываются. */
export function resultPredecessor(id, tasks, records = [], invalid = []) {
  const matches = [
    ...tasks,
    ...records,
    ...invalid.map((item) => ({ ...item, valid: false })),
  ].filter((item) => item.id === id);
  if (matches.length !== 1)
    return {
      problem: matches.length ? 'неоднозначный идентификатор' : 'нет подтверждения закрытия',
    };
  const predecessor = matches[0];
  if (predecessor.valid === false || dependencyFormatProblem(predecessor))
    return { problem: 'негодный предшественник' };
  if (predecessor.status !== 'closed') return { problem: `не закрыт (${predecessor.status})` };
  return { predecessor };
}

/** Проверяем поля доказательства заново: один флаг успеха ничего не доказывает. */
export function mergeEvidenceProblem(evidence, pr, mainBranch) {
  if (!evidence || !mainBranch) return 'нет доказательства вливания';
  if (evidence.number !== pr) return 'не совпадает номер PR в доказательстве';
  if (evidence.state !== 'MERGED') return evidence.problem ?? 'PR не влит';
  if (
    typeof evidence.mergedAt !== 'string' ||
    !evidence.mergedAt.trim() ||
    !Number.isFinite(Date.parse(evidence.mergedAt))
  )
    return 'нет корректной даты вливания';
  if (evidence.baseRefName !== mainBranch) return 'другая база PR';
  return null;
}

/** Даже закрытая карточка не позволяет обойти цикл объявленных предусловий. */
export function dependencyCycleProblem(task, tasks, records = []) {
  const byId = new Map([...tasks, ...records, task].map((item) => [item.id, item]));
  const visiting = new Set();
  const checked = new Set();
  const stack = [{ id: task.id, exit: false }];
  while (stack.length) {
    const { id, exit } = stack.pop();
    if (exit) {
      visiting.delete(id);
      checked.add(id);
      continue;
    }
    if (visiting.has(id)) return `цикл зависимостей через ${id}`;
    if (checked.has(id)) continue;
    visiting.add(id);
    stack.push({ id, exit: true });
    const current = byId.get(id);
    for (const ids of [current?.dependsOn, current?.splitInto]) {
      if (Array.isArray(ids)) for (const next of ids) stack.push({ id: next, exit: false });
    }
  }
  return null;
}

/** Закрытие разделённой задачи означает результат только вместе со всеми её частями. */
export function pendingCompletion(
  id,
  tasks,
  archivedClosed = [],
  { records = [], invalid = [] } = {},
) {
  const byId = new Map();
  for (const item of [...tasks, ...records]) {
    const matches = byId.get(item.id) ?? [];
    matches.push(item);
    byId.set(item.id, matches);
  }
  const invalidIds = new Set(invalid.map((item) => item.id));
  const visiting = new Set();
  const checked = new Set();
  const pending = [];
  const stack = [{ id, path: [id], exit: false }];
  while (stack.length) {
    const step = stack.pop();
    if (step.exit) {
      visiting.delete(step.id);
      checked.add(step.id);
      continue;
    }
    const waitFor = (why) => pending.push(`${step.path.join(' → ')} (${why})`);
    if (visiting.has(step.id)) {
      waitFor('цикл декомпозиции');
      continue;
    }
    if (checked.has(step.id)) continue;
    const matches = byId.get(step.id) ?? [];
    if (invalidIds.has(step.id) || matches.some((item) => item.valid === false)) {
      waitFor('не разобрана');
      continue;
    }
    if (matches.length > 1) {
      waitFor('неоднозначный идентификатор');
      continue;
    }
    const current = matches[0];
    if (!current) {
      // Старые файловые хранилища передают только доказанные закрытые ID.
      // Если полная архивная карточка есть, этот список её не подменяет.
      if (!archivedClosed.includes(step.id)) waitFor('нет подтверждения закрытия');
      continue;
    }
    const problem = dependencyFormatProblem(current);
    if (problem) {
      waitFor(problem);
      continue;
    }
    if (current.status !== 'closed') {
      waitFor(current.status ?? 'нет подтверждения закрытия');
      continue;
    }
    visiting.add(step.id);
    stack.push({ ...step, exit: true });
    for (const child of [...(current.splitInto ?? [])].reverse()) {
      stack.push({ id: child, path: [...step.path, child], exit: false });
    }
  }
  return pending;
}

/** Исчезновение карточки не доказывает завершение; принимаем только явное closed. */
export function pendingDependencies(
  task,
  tasks,
  archivedClosed = [],
  { records = [], invalid = [], evidence = {}, mainBranch } = {},
) {
  const problem = dependencyFormatProblem(task);
  if (problem) return [problem];
  const cycle = dependencyCycleProblem(task, tasks, records);
  if (cycle) return [cycle];
  return (task.dependsOn ?? []).flatMap((id) => {
    const pending = pendingCompletion(id, tasks, archivedClosed, { records, invalid });
    const result = (task.dependencyResults ?? []).find((item) => item.taskId === id);
    if (result) {
      const resolved = resultPredecessor(id, tasks, records, invalid);
      const unmet =
        resolved.problem ??
        (resolved.predecessor.links?.pr !== result.pr
          ? 'links.pr не совпадает с ожидаемым PR'
          : mergeEvidenceProblem(evidence[result.pr], result.pr, mainBranch));
      return [...pending, ...(unmet ? [`${id} (PR #${result.pr}: ${unmet})`] : [])];
    }
    return pending;
  });
}
