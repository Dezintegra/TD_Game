/** Неверные зависимости удерживают задачу, а не превращаются в пустой список. */
export function dependencyFormatProblem(task) {
  if (!Object.hasOwn(task, 'dependsOn')) return null;
  const ids = task.dependsOn;
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'string' || !/^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*$/.test(id))
  ) {
    return 'dependsOn должен быть массивом полных идентификаторов задач';
  }
  if (ids.includes(task.id)) return `самоссылка ${task.id}`;
  if (new Set(ids).size !== ids.length) return 'dependsOn содержит повторные идентификаторы';
  return null;
}

/** Исчезновение карточки не доказывает завершение; принимаем только явное closed. */
export function pendingDependencies(task, tasks, archivedClosed = []) {
  const problem = dependencyFormatProblem(task);
  if (problem) return [problem];
  return (task.dependsOn ?? []).flatMap((id) => {
    const matches = tasks.filter((item) => item.id === id);
    if (matches.length === 1 && matches[0].status === 'closed') return [];
    if (matches.length === 0 && archivedClosed.includes(id)) return [];
    return [
      `${id} (${matches.length > 1 ? 'неоднозначный идентификатор' : (matches[0]?.status ?? 'нет подтверждения закрытия')})`,
    ];
  });
}
