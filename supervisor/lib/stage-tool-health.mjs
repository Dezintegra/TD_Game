/** Контроль связан с назначением, а не с текстом жалобы исполнителя. */
export function sameToolContext(expected, actual) {
  return (
    expected != null &&
    actual != null &&
    ['provider', 'cwd', 'environmentId', 'permissionsId'].every(
      (key) => typeof expected[key] === 'string' && expected[key] && expected[key] === actual[key],
    )
  );
}

/** Сырые факты не получают статуса failed из stderr или отсутствия события. */
export function normalizeControlFact(control, fact, context) {
  const missing = { id: control.id, argv: control.argv, status: 'missing' };
  if (
    !fact ||
    fact.checkId !== control.id ||
    fact.invocationId !== control.invocationId ||
    !sameToolContext(context, fact.context) ||
    JSON.stringify(fact.argv) !== JSON.stringify(control.argv) ||
    typeof fact.eventId !== 'string' ||
    !fact.eventId ||
    !Number.isSafeInteger(fact.sequence) ||
    fact.sequence < 0 ||
    !Number.isFinite(fact.startedAt) ||
    !Number.isFinite(fact.finishedAt) ||
    fact.finishedAt < fact.startedAt
  )
    return missing;
  const evidence = {
    ...missing,
    eventId: fact.eventId,
    sequence: fact.sequence,
    startedAt: fact.startedAt,
    finishedAt: fact.finishedAt,
    context: fact.context,
    output: typeof fact.output === 'string' ? fact.output.slice(0, 4096) : '',
  };
  if (
    fact.kind === 'spawn-error' &&
    fact.created === false &&
    typeof fact.errorCode === 'string' &&
    fact.errorCode
  ) {
    return { ...evidence, status: 'failed', errorCode: fact.errorCode };
  }
  if (fact.kind !== 'exit' || fact.completed !== true || !Number.isInteger(fact.exitCode))
    return evidence;
  // Отказ обновления ref не доказывает потерю транспорта.
  if (control.capability === 'push' && fact.exitCode !== 0) return evidence;
  if (fact.exitCode !== 0) return { ...evidence, status: 'failed', exitCode: fact.exitCode };
  if (control.marker != null && fact.output?.trim() !== control.marker) return evidence;
  return { ...evidence, status: 'passed', exitCode: 0 };
}

export function classifyToolControls({ context, controls = [], facts = [] }) {
  const checks = controls.map((control) => {
    const matching = facts.filter((fact) => fact?.checkId === control.id);
    // Не выбираем удобное событие из противоречивых результатов одного вызова.
    return normalizeControlFact(control, matching.length === 1 ? matching[0] : null, context);
  });
  const verdict = checks.some((check) => check.status === 'failed')
    ? 'confirmed'
    : checks.length > 0 && checks.every((check) => check.status === 'passed')
      ? 'healthy'
      : 'inconclusive';
  return { verdict, context, checks };
}
