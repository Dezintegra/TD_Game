import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TUNING_FLAGS = new Set([
  '--income',
  '--speed',
  '--tower-hp',
  '--base-hp',
  '--radius',
  '--map',
  '--assault-range',
]);
const DECIMAL = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

export function parseTuningArgs(input = '') {
  const tokens = input.trim() ? input.trim().split(/\s+/) : [];
  const seen = new Set();
  for (let i = 0; i < tokens.length; i += 2) {
    const flag = tokens[i];
    if (!TUNING_FLAGS.has(flag)) throw new Error(`tuning_args: неизвестный ключ ${flag}`);
    if (seen.has(flag)) throw new Error(`tuning_args: повтор ключа ${flag}`);
    const value = tokens[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`tuning_args: отсутствует значение ${flag}`);
    }
    if (!DECIMAL.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0) {
      throw new Error(
        `tuning_args: ${flag} требует положительный конечный множитель, получено ${value}`,
      );
    }
    seen.add(flag);
    if (flag === '--assault-range' && Number(value) !== 0.5 && Number(value) !== 1)
      throw new Error('tuning_args: --assault-range допускает только 0.5/1');
  }
  return tokens;
}

export function buildArenaArgs(env) {
  const args = ['run', '--matches', env.MATCHES ?? '', '--seed', env.SEED ?? ''];
  if (env.PROFILES) args.push('--profiles', env.PROFILES);
  if (env.SECONDS_LIMIT) args.push('--seconds', env.SECONDS_LIMIT);
  args.push(...parseTuningArgs(env.TUNING_ARGS));
  const trace = env.TRACE_ASSAULT_SEEDS?.trim() ?? '';
  if (trace) {
    const raw = trace.split(',');
    if (raw.some((value) => !/^[0-9]+$/.test(value)))
      throw new Error('trace_assault_seeds: invalid seed');
    const seeds = raw.map(Number),
      first = Number(env.SEED),
      count = Number(env.MATCHES);
    if (
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      new Set(seeds).size !== seeds.length ||
      seeds.some((seed) => !Number.isSafeInteger(seed) || seed < first || seed >= first + count)
    )
      throw new Error('trace_assault_seeds: duplicate or outside batch');
    args.push('--trace-assault-seeds', seeds.join(','));
  }
  return args;
}

// Подмена процесса нужна тестам: проверка доставки не должна считать матчи.
export function runArenaWorkflow(env, spawn = spawnSync, reportError = console.error) {
  try {
    const args = buildArenaArgs(env);
    const result = spawn(process.execPath, ['apps/arena/dist/main.js', ...args], {
      shell: false,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`арена завершена сигналом ${result.signal}`);
    if (result.status === null) throw new Error('арена завершена без кода возврата');
    return result.status;
  } catch (error) {
    reportError(`Запуск арены: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runArenaWorkflow(process.env);
}
