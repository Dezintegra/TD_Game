/** Все карточки, изменяемые доставкой, защищены до её завершения. */
export function reportTaskIds(report) {
  const replacements = Array.isArray(report?.consolidations)
    ? report.consolidations.slice(0, 5)
    : [];
  return [
    ...new Set(
      [
        report?.taskId,
        ...(Array.isArray(report?.resumptions)
          ? report.resumptions.slice(0, 5).map((i) => i?.taskId)
          : []),
        ...(Array.isArray(report?.classifications)
          ? report.classifications.slice(0, 8).map((i) => i?.taskId)
          : []),
        ...(Array.isArray(report?.batch) ? report.batch : []),
        ...replacements.flatMap((item) => [item?.sourceId, item?.targetId]),
      ].filter((id) => typeof id === 'string'),
    ),
  ];
}
