/** Неверные зависимости удерживают задачу, а не превращаются в пустой список. */
export function dependencyFormatProblem(task) {
  const ids = Object.hasOwn(task, 'dependsOn') ? task.dependsOn : [];
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'string' || !/^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*$/.test(id))
  ) {
    return 'dependsOn должен быть массивом полных идентификаторов задач';
  }
  if (ids.includes(task.id)) return `самоссылка ${task.id}`;
  if (new Set(ids).size !== ids.length) return 'dependsOn содержит повторные идентификаторы';
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
      problem: matches.length ? 'неоднозначный идентификатор' : 'нет подтверждения выполнения',
    };
  const predecessor = matches[0];
  if (predecessor.valid === false || dependencyFormatProblem(predecessor))
    return { problem: 'негодный предшественник' };
  if (predecessor.status !== 'completed') return { problem: `не выполнен (${predecessor.status})` };
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
    const ids = byId.get(id)?.dependsOn;
    if (Array.isArray(ids)) for (const next of ids) stack.push({ id: next, exit: false });
  }
  return null;
}

/** Исчезновение карточки не доказывает завершение; принимаем только явное completed. */
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
    const result = (task.dependencyResults ?? []).find((item) => item.taskId === id);
    if (result) {
      const resolved = resultPredecessor(id, tasks, records, invalid);
      const unmet =
        resolved.problem ??
        (resolved.predecessor.links?.pr !== result.pr
          ? 'links.pr не совпадает с ожидаемым PR'
          : mergeEvidenceProblem(evidence[result.pr], result.pr, mainBranch));
      return unmet ? [`${id} (PR #${result.pr}: ${unmet})`] : [];
    }
    const matches = tasks.filter((item) => item.id === id);
    if (matches.length === 1 && matches[0].status === 'completed') return [];
    if (matches.length === 0 && archivedClosed.includes(id)) return [];
    return [
      `${id} (${matches.length > 1 ? 'неоднозначный идентификатор' : (matches[0]?.status ?? 'нет подтверждения выполнения')})`,
    ];
  });
}
