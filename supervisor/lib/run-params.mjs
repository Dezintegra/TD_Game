import { runSourceProblem } from './run-source.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Проверяем до JSON.stringify: он молча теряет undefined, функции и особые объекты. */
export function runParamsProblem(params) {
  if (!object(params)) return 'run.params: требуется JSON-объект';
  const ancestors = new Set();
  function visit(value, path) {
    if (value === null || ['string', 'boolean'].includes(typeof value)) return null;
    if (typeof value === 'number')
      return Number.isFinite(value) && !Object.is(value, -0)
        ? null
        : `${path}: несохраняемое число`;
    if (typeof value !== 'object') return `${path}: несохраняемое JSON-значение`;
    if (ancestors.has(value)) return `${path}: циклическая ссылка`;
    const array = Array.isArray(value);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      return `${path}: требуется обычный JSON-объект`;
    ancestors.add(value);
    const keys = Reflect.ownKeys(value).filter((key) => !(array && key === 'length'));
    if (array && keys.length !== value.length) return `${path}: разреженный массив`;
    for (const key of keys) {
      if (typeof key !== 'string') return `${path}: символьный ключ не сохраняется`;
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
        return `${path}.${key}: свойство массива не сохраняется`;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        return `${path}.${key}: требуется обычное перечисляемое значение`;
      const problem = visit(descriptor.value, `${path}.${key}`);
      if (problem) return problem;
    }
    ancestors.delete(value);
    return null;
  }
  return visit(params, 'run.params');
}

/** Допуск не достраивает утраченные поля и не судит о вычислимости ожидания. */
export function benchmarkRunProblem(run) {
  const problem = runParamsProblem(run?.params);
  if (problem) return problem;
  if (run.kind === 'arena' && Object.keys(run.params).length === 0)
    return 'run.params: заказ арены пуст';
  if (Object.hasOwn(run.params, 'profilePairs')) {
    const pairs = run.params.profilePairs;
    if (!Array.isArray(pairs) || pairs.length === 0)
      return 'run.params.profilePairs: требуется непустой массив пар';
    for (const [index, pair] of pairs.entries()) {
      if (!Array.isArray(pair) || pair.length !== 2)
        return `run.params.profilePairs[${index}]: требуются две стороны`;
      for (const [side, profile] of pair.entries())
        if (typeof profile !== 'string' || !profile.trim())
          return `run.params.profilePairs[${index}][${side}]: требуется непустой профиль`;
    }
  }
  return runSourceProblem(run);
}
