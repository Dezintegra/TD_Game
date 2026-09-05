/** Карта этапов важнее общей модели: рутина не должна наследовать модель разбора. */
export function modelForStage(config, provider, stage) {
  const models = config.stageModels?.[provider];
  return (
    models?.[stage] ??
    models?.default ??
    (provider === 'codex' ? config.codexModel : config.stageModel)
  );
}
