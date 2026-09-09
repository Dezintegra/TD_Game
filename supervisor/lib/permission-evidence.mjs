// Нормализацию выполняет сборщик native-событий: текст модели сюда не годится.
// contexts связывает каждый заход с его реальным снимком; additive имеет иной digest.
export function classifyPermissionEvidence(evidence = {}) {
  const result = (settings, target, reason) => ({
    settings,
    target,
    verified: settings === 'applied' && target === 'enforced',
    reason,
  });
  const unknown = (reason) => result('unknown', 'unknown', reason);
  const { contexts, loading, independent, positive, negative } = evidence;
  const validContext = (context) =>
    ['session', 'tool', 'digest'].every(
      (key) => typeof context?.[key] === 'string' && context[key].length > 0,
    );
  const bound = (item, context) =>
    validContext(context) &&
    item?.native === true &&
    item.complete === true &&
    typeof item.toolUseId === 'string' &&
    item.toolUseId.length > 0 &&
    ['session', 'tool', 'digest'].every((key) => item[key] === context[key]);
  const loaded = (item, context) =>
    validContext(context) &&
    item?.provenance === 'launch-metadata' &&
    ['session', 'tool', 'digest'].every((key) => item[key] === context[key]);

  if (!validContext(contexts?.baseline) || !validContext(contexts?.additive)) {
    return unknown('missing-context');
  }
  const runs = ['baseline', 'additive'];
  if (runs.some((run) => !loaded(loading?.[run], contexts[run]))) {
    return unknown('unconfirmed-loading');
  }
  if (runs.some((run) => loading[run].status === 'not-applied')) {
    return result('not-applied', 'unknown', 'source-not-applied');
  }
  if (runs.some((run) => loading[run].status !== 'confirmed')) {
    return unknown('unconfirmed-loading');
  }
  if (
    evidence.nativeToolAvailable !== true ||
    evidence.complete !== true ||
    evidence.comparison?.onlyAdditiveDeny !== true ||
    evidence.comparison?.otherSourcesUnchanged !== true ||
    contexts.baseline.tool !== contexts.additive.tool ||
    contexts.baseline.session === contexts.additive.session ||
    contexts.baseline.digest === contexts.additive.digest
  ) {
    return unknown('incomparable-or-incomplete');
  }
  const controls = [
    [independent?.baseline, contexts.baseline, 'program-result'],
    [independent?.denied, contexts.additive, 'policy-denied'],
    [independent?.companion, contexts.additive, 'program-result'],
  ];
  if (
    controls.some(
      ([event, context, kind]) =>
        !bound(event, context) ||
        event.kind !== kind ||
        (kind === 'program-result' && event.exitCode !== 0),
    ) ||
    !independent.baseline.command ||
    independent.baseline.command !== independent.denied.command ||
    !independent.companion.command ||
    independent.companion.command === independent.denied.command ||
    independent.denied.toolUseId === independent.companion.toolUseId
  ) {
    return unknown('independent-control-unconfirmed');
  }
  // Исследуемая пара относится к исходному снимку, а не к произвольному canary.
  if (
    !bound(positive, contexts.baseline) ||
    !bound(negative, contexts.baseline) ||
    positive.toolUseId === negative.toolUseId ||
    positive.kind !== 'program-result'
  ) {
    return result('applied', 'unknown', 'target-pair-incomplete');
  }
  if (negative.kind === 'policy-denied') {
    return result('applied', 'enforced', 'policy-denied-negative');
  }
  if (negative.kind === 'program-result') {
    return result('applied', 'not-enforced', 'negative-reached-program');
  }
  return result('applied', 'unknown', 'negative-unconfirmed');
}
