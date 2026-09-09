export interface AssaultOptions {
  enabled: boolean;
  range: number;
  seeds: readonly number[];
}

export const parseAssaultOptions = (
  flags: ReadonlyMap<string, string>,
  batch: readonly number[],
): AssaultOptions => {
  const rawRange = flags.get('assault-range');
  if (
    rawRange !== undefined &&
    !/^[+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?$/i.test(rawRange)
  )
    throw new Error('--assault-range: expected decimal 0.5 or 1');
  const range = rawRange === undefined ? 1 : Number(rawRange);
  if (range !== 0.5 && range !== 1) throw new Error('--assault-range: expected 0.5 or 1');
  const raw = flags.get('trace-assault-seeds')?.trim() ?? '';
  const seeds =
    raw === ''
      ? []
      : raw.split(',').map((value) => {
          if (!/^[0-9]+$/.test(value)) throw new Error('invalid trace seed');
          const seed = Number(value);
          if (!Number.isSafeInteger(seed)) throw new Error('invalid trace seed');
          return seed;
        });
  if (new Set(seeds).size !== seeds.length) throw new Error('duplicate trace seed');
  if (seeds.some((seed) => !batch.includes(seed))) throw new Error('trace seed outside batch');
  return { enabled: rawRange !== undefined || seeds.length > 0, range, seeds };
};

export const assaultWorkerArgs = (options: AssaultOptions, batch: readonly number[]): string[] => {
  if (!options.enabled) return [];
  const seeds = options.seeds.filter((seed) => batch.includes(seed));
  return [
    '--assault-range',
    String(options.range),
    ...(seeds.length ? ['--trace-assault-seeds', seeds.join(',')] : []),
  ];
};

export const assaultMatchOptions = (options: AssaultOptions, seed: number) => ({
  assaultExperiment: options.enabled,
  traceAssault: options.seeds.includes(seed),
});
