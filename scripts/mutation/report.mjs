const cell = (value) =>
  String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');

export function renderReport(report) {
  const lines = [
    '# Mutation canaries',
    '',
    `SHA: ${report.sha}`,
    `Run: ${report.runId}`,
    `Actions: ${report.actionsUrl || 'local'}`,
    `Mode: ${report.ref === 'refs/heads/main' ? 'main' : 'diagnostic (no Issue writes)'}`,
    '',
    'Только перечисленные пары; полнота покрытия правил не заявляется.',
    '',
    '| Mutation | Tuning | Test | Baseline | Mutant | Result | Reason |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const result of report.results)
    lines.push(
      `| ${[
        result.mutation?.id,
        JSON.stringify(result.mutation?.tuning),
        result.pair ? `${result.pair.testFile}: ${result.pair.fullName.join(' > ')}` : '',
        result.baseline?.status,
        result.mutant?.status,
        result.status,
        result.reason,
      ]
        .map(cell)
        .join(' | ')} |`,
    );
  lines.push('', `Counts: ${JSON.stringify(report.counts)}`, `Exit: ${report.exitCode}`, '');
  return lines.join('\n');
}
