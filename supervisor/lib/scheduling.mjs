const LANES = ['game', 'service'];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

/** Тип прогона и объявленная конвейерная область сильнее декоративной метки. */
export function workLane(task) {
  if (task.type !== 'feature' || task.area === 'pipeline') return 'service';
  if (LANES.includes(task.workKind) && task.workReason?.trim()) return task.workKind;
  const categories = task.categories ?? [];
  return !categories.includes('infrastructure') &&
    categories.some((item) => ['ux', 'mechanics', 'balance'].includes(item))
    ? 'game'
    : 'service';
}

export function workKindProblem(task) {
  if (task.workKind === undefined && task.workReason === undefined) return null;
  if (
    !LANES.includes(task.workKind) ||
    typeof task.workReason !== 'string' ||
    !task.workReason.trim()
  )
    return 'workKind требует game/service и непустое обоснование результата workReason';
  if (task.workKind === 'game' && (task.type !== 'feature' || task.area === 'pipeline'))
    return 'игровой результат допустим только для feature вне area: pipeline';
  return null;
}

export function emptyScheduling() {
  return { version: 1, next: 'game', lastLane: 'service', admissions: {}, recoveries: [] };
}

export function schedulingProblem(value) {
  if (
    !object(value) ||
    value.version !== 1 ||
    !LANES.includes(value.next) ||
    !LANES.includes(value.lastLane) ||
    !object(value.admissions) ||
    !Array.isArray(value.recoveries) ||
    value.recoveries.some((id) => typeof id !== 'string')
  )
    return 'неверный журнал scheduling.json';
  for (const entry of Object.values(value.admissions)) {
    if (!object(entry) || !LANES.includes(entry.lane) || !Number.isFinite(Date.parse(entry.at)))
      return 'неверная отметка первого запуска scheduling.json';
  }
  return null;
}

/** Повтор сессии меняет только направление исполнения, но не ход новых карточек. */
export function recordLaunch(state, task, at) {
  const problem = schedulingProblem(state);
  if (problem) throw new Error(problem);
  const next = globalThis.structuredClone(state);
  next.lastLane = workLane(task);
  if (task.scheduling && !Object.hasOwn(next.admissions, task.id)) {
    const lane = task.scheduling.lane;
    if (!LANES.includes(lane)) throw new Error('неверное направление первого запуска');
    Object.defineProperty(next.admissions, task.id, {
      value: { lane, at },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    next.next = lane === 'game' ? 'service' : 'game';
  }
  return next;
}

export function recordRecovery(state, id) {
  if (state.recoveries.includes(id)) return state;
  return { ...state, next: 'game', recoveries: [...state.recoveries, id] };
}

export function schedulingFields(value) {
  return Object.fromEntries(
    ['area', 'blocking', 'workKind', 'workReason', 'scheduling', 'pipelineIncident']
      .filter((key) => Object.hasOwn(value ?? {}, key))
      .map((key) => [key, value[key]]),
  );
}
