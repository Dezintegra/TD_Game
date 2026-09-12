import { stateClass } from '../config/transitions.mjs';

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

/** Один выбор для продолжений и первых запусков, без чтения диска или доски. */
export function planLaunches({ candidates, running, tasks, config, scheduling, now, compare }) {
  const actions = [];
  const notes = [];
  if (scheduling?.error) return { actions, notes: [scheduling.error] };
  const memory = scheduling ?? emptyScheduling();
  const problem = schedulingProblem(memory);
  if (problem) return { actions, notes: [problem] };
  const liveTasks = running
    .map((item) => tasks.find((task) => task.id === item.taskId))
    .filter(Boolean);
  if (liveTasks.some((task) => stateClass(task) === 'exclusive'))
    return { actions, notes: ['идёт исключительный этап: новые сессии ждут тишины'] };
  let free = Math.max(0, config.maxConcurrent - running.length);
  let remaining = [...candidates].sort((a, b) => compare(a.task, b.task));
  let gameRunning = liveTasks.some((task) => workLane(task) === 'game');
  let lastLane = memory.lastLane;
  let admitted = false;
  const first = (item) =>
    item.kind === 'start-stage' ||
    (item.task.scheduling && !Object.hasOwn(memory.admissions, item.task.id));

  while (free > 0 && remaining.length) {
    const gameFirst = remaining.some((item) => first(item) && workLane(item.task) === 'game');
    const serviceFirst = remaining.some((item) => first(item) && workLane(item.task) === 'service');
    const next =
      memory.next === 'game' && !gameFirst
        ? 'service'
        : memory.next === 'service' && !serviceFirst
          ? 'game'
          : memory.next;
    const allowed = remaining.filter(
      (item) => !first(item) || (!admitted && workLane(item.task) === next),
    );
    if (!allowed.length) break;
    const protectGame =
      config.maxConcurrent >= 2 &&
      !gameRunning &&
      allowed.some((item) => workLane(item.task) === 'game');
    const preferred = protectGame ? 'game' : lastLane === 'game' ? 'service' : 'game';
    const laneItems = allowed.filter((item) => workLane(item.task) === preferred);
    const pool = laneItems.length ? laneItems : allowed;
    // Продолжения заканчивают уже начатое. Новая игровая карточка при этом
    // конкурирует со служебными продолжениями, а не ждёт их полного окончания.
    const item = pool.find((entry) => !first(entry)) ?? pool[0];
    const exclusive = stateClass({ ...item.task, status: item.stage }) === 'exclusive';
    if (exclusive && (running.length || actions.length)) {
      notes.push(
        `задача ${item.task.id}: выбран исключительный этап, исполнитель занят, ждём тишины`,
      );
      break;
    }
    const lane = workLane(item.task);
    const reason =
      `${lane === 'game' ? 'игровая' : 'служебная'} работа; ` +
      `${protectGame ? 'защищено место игры; ' : ''}следующий первый запуск: ${next}`;
    actions.push({
      kind: item.kind,
      taskId: item.task.id,
      stage: item.stage,
      ...(item.kind === 'continue-stage'
        ? { reason: 'этапу нужна сессия, живого процесса нет' }
        : {}),
      selectionReason: reason,
      ...(item.batch ? { batch: item.batch } : {}),
      ...(item.unaccounted ? { unaccounted: item.unaccounted } : {}),
      ...(item.kind === 'start-stage'
        ? { scheduling: item.task.scheduling ?? { lane, selectedAt: now, reason } }
        : {}),
    });
    notes.push(`задача ${item.task.id}: ${reason}`);
    if (first(item)) admitted = true;
    if (lane === 'game') gameRunning = true;
    lastLane = lane;
    remaining = remaining.filter((entry) => entry !== item);
    free -= 1;
    if (exclusive) break;
  }
  if (free === 0)
    for (const item of remaining)
      notes.push(`задача ${item.task.id} ждёт: исполнитель занят, свободных мест нет`);
  return { actions, notes };
}
