/** Planning is not evidence of process creation. Local failures do not pause the whole queue. */
export function executionSummary(planned, actions = [], repairs = [], applied = true) {
  const launches = actions.reduce((sum, item) => sum + (item.launched ?? 0), 0);
  const results = [...actions, ...repairs];
  const service = results.filter((item) => item.result === 'done' && !item.launched).length;
  const failed = results.filter((item) => item.result === 'failed').length;
  const skipped = results.filter((item) =>
    ['skipped', 'raced', 'reported'].includes(item.result),
  ).length;
  const outcome = launches
    ? 'worked'
    : service
      ? 'progress'
      : results.length
        ? 'held'
        : planned === 'worked'
          ? applied
            ? 'held'
            : 'planned'
          : planned;
  return { outcome, launches, service, failed, skipped };
}

export const executionNote = (summary) =>
  `фактически запущено процессов: ${summary.launches}; служебных действий выполнено: ${summary.service}; отказов: ${summary.failed}; пропущено: ${summary.skipped}`;
