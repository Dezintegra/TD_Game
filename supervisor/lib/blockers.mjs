import { createHash } from 'node:crypto';
import {
  reviewingDelay,
  reviewingQuestion,
  delayReportProblem,
  delaySummary,
  delayFacts,
  delayDependencies,
  delayEntry,
  delayKey,
  beginDelayAnalysis,
} from './delay-analysis.mjs';
import { checkCard } from './validate-card.mjs';
import { categoriesProblem } from './categories.mjs';
import {
  dependencyCycleProblem,
  dependencyFormatProblem,
  pendingDependencies,
} from './dependencies.mjs';
import { nextId, taskFromRequest } from './requests.mjs';
import { addSpent, applyTransition } from './task-file.mjs';

export const BLOCKABLE = [
  'decompose',
  'design',
  'audit',
  'implement',
  'revise',
  'triage',
  'benchmark',
  'interpret',
];
const nonempty = (s) => typeof s === 'string' && s.trim().length > 0;

export function blockerReportProblem(task, report) {
  if (!BLOCKABLE.includes(report.stage) && !reviewingDelay(task))
    return 'этот этап не может объявить предпосылку';
  if (reviewingDelay(task)) {
    const problem = delayReportProblem(task, report);
    if (problem) return problem;
  }
  if (task.status !== report.stage && task.status !== 'blocked') return 'отчёт о другом этапе';
  if (!Array.isArray(report.blockers) || report.blockers.length === 0) return 'не названы блокеры';
  if (categoriesProblem(report.categories, true)) return categoriesProblem(report.categories, true);
  if (report.requests !== undefined && !Array.isArray(report.requests)) return 'requests не массив';
  for (const blocker of report.blockers) {
    if (!blocker || !nonempty(blocker.reason) || !nonempty(blocker.result))
      return 'каждому блокеру нужны reason и result';
    if (Number(nonempty(blocker.taskId)) + Number(nonempty(blocker.requestKey)) !== 1)
      return 'блокеру нужна ровно одна ссылка taskId или requestKey';
    if (Object.hasOwn(blocker, 'dependencyResult')) {
      const result = blocker.dependencyResult;
      if (
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        Object.keys(result).length !== 2 ||
        result.kind !== 'merged-pr' ||
        !Number.isInteger(result.pr) ||
        result.pr <= 0
      )
        return 'dependencyResult: ожидается { kind: merged-pr, pr: положительное целое }';
    }
  }
  return null;
}

// Ключ относится к отчёту этапа; повтор после сетевого обрыва не выдаёт новые ID.
export const blockerOperation = (task, report) =>
  `${task.id}:${task.analysisGeneration ?? 0}:${createHash('sha256').update(JSON.stringify(report)).digest('hex')}`;

export function planBlockers(task, report, known, now) {
  const problem = blockerReportProblem(task, report) || dependencyFormatProblem(task);
  if (problem) return { problem };
  const operation = blockerOperation(task, report);
  const requests = report.requests ?? [];
  const keys = requests.map((r) => r?.key);
  if (keys.some((key) => !nonempty(key)) || new Set(keys).size !== keys.length)
    return { problem: 'заявкам нужны уникальные key' };
  const required = new Set(report.blockers.map((b) => b.requestKey).filter(Boolean));
  if ([...required].some((key) => !keys.includes(key))) return { problem: 'нет заявки блокера' };
  const planned = [];
  const keyToId = new Map();
  const taken = known.map((t) => t.id);
  for (const request of requests) {
    const categoryProblem = categoriesProblem(request.categories, true);
    if (categoryProblem) return { problem: categoryProblem };
    const creationKey = `${operation}:${request.key}`;
    const matches = known.filter((t) => t.creationKey === creationKey);
    if (matches.length > 1) return { problem: 'неоднозначный результат создания предпосылки' };
    if (matches.length === 1) {
      if (matches[0].valid === false) return { problem: 'созданная предпосылка повреждена' };
      keyToId.set(request.key, matches[0].id);
      continue;
    }
    const id = nextId(taken, request.title);
    const built = taskFromRequest(request, { id, now, sourceId: task.id });
    if (!built.task) return { problem: built.problems.join('; ') };
    const born = {
      ...built.task,
      creationKey,
      status: required.has(request.key) || request.type === 'run' ? 'new' : 'candidate',
      blocking: required.has(request.key),
    };
    if (reviewingDelay(task) && required.has(request.key)) {
      const criteria = report.blockers.filter((b) => b.requestKey === request.key);
      born.description +=
        `\n\nРазблокирует ${task.id}. Причина: ${report.delayAnalysis.cause}\n` +
        criteria
          .map(
            (b) =>
              `Конкретный результат и проверка: ${b.specificResult}\nОбщее исправление и защита от повторения: ${b.preventionResult}`,
          )
          .join('\n');
    }
    planned.push(born);
    taken.push(id);
    keyToId.set(request.key, id);
  }
  const reasons = report.blockers.map((b) => ({
    taskId: b.taskId ?? keyToId.get(b.requestKey),
    reason: b.reason,
    result: b.result,
    ...(b.dependencyResult ? { dependencyResult: b.dependencyResult } : {}),
    ...(reviewingDelay(task)
      ? { specificResult: b.specificResult, preventionResult: b.preventionResult }
      : {}),
  }));
  const all = [...known, ...planned];
  for (const reason of reasons) {
    const matches = all.filter((t) => t.id === reason.taskId);
    if (matches.length !== 1)
      return { problem: `предшественник ${reason.taskId} отсутствует или неоднозначен` };
    if (matches[0].valid === false)
      return { problem: `предшественник ${reason.taskId} не прошёл проверку` };
    // Кандидата нельзя молча сделать блокером: его постановку ещё не одобрили.
    // Для обязательного существующего кандидата перенос выполняется отдельно ниже.
    // Предшественник мог успеть закончиться между POST и повтором отчёта.
    // Принимаем такой прогресс, но не даём вновь блокироваться давней готовой работой.
    if (
      matches[0].status === 'completed' &&
      !reviewingQuestion(task) &&
      !matches[0].creationKey?.startsWith(`${operation}:`) &&
      !(Date.parse(matches[0].statusChangedAt) >= Date.parse(task.statusChangedAt))
    )
      return { problem: `предшественник ${reason.taskId} выполнен ещё до этого анализа` };
    // Остановка допускает ожидание существующей работы, но не доказывает её выполнение.
    if (matches[0].status === 'closed' && !matches[0].splitInto?.length)
      return { problem: `предшественник ${reason.taskId} остановлен без результата` };
  }
  const next = {
    ...task,
    categories: report.categories,
    dependsOn: [...new Set([...(task.dependsOn ?? []), ...reasons.map((r) => r.taskId)])],
    blockedContext: { operation, reasons, priority: task.priority, from: report.stage },
  };
  // Уточнение результата не должно стирать чужое условие или менять ожидаемый PR.
  const results = new Map((task.dependencyResults ?? []).map((item) => [item.taskId, item]));
  for (const reason of reasons) {
    if (!reason.dependencyResult) continue;
    const previous = results.get(reason.taskId);
    if (previous && previous.pr !== reason.dependencyResult.pr)
      return { problem: `противоречивый результат PR для ${reason.taskId}` };
    results.set(reason.taskId, { taskId: reason.taskId, ...reason.dependencyResult });
  }
  if (results.size) next.dependencyResults = [...results.values()];
  const graph = [...all.filter((t) => t.id !== task.id), next];
  const graphProblem = dependencyFormatProblem(next) || dependencyCycleProblem(next, graph);
  if (graphProblem) return { problem: graphProblem };
  return { next, planned, reasons, operation };
}

export async function transferBlocked(task, report, action, io) {
  // PUT мог пройти, а запись комментария — оборваться. Состояние уже применено.
  if (task.status === 'blocked' && task.blockedContext?.from === report.stage) {
    if (task.blockedContext.operation !== blockerOperation(task, report))
      return { result: 'failed', why: 'карточка ожидает по другому отчёту', reportRejected: true };
    const released = await io.release?.(task);
    if (released && !released.ok)
      return { result: 'failed', why: released.why ?? released.outcome };
    io.forgetSession?.(task.id, report.stage);
    io.removeReport(task.id, report.stage);
    return { result: 'done', status: 'blocked' };
  }
  const known = io.parsedCards
    ? [
        ...io.parsedCards().map((p) => ({ ...p.task, valid: checkCard(p).length === 0 })),
        ...(io.dependencyRecords?.() ?? []),
      ]
    : io
        .allTaskIds()
        .map((id) => io.readTask(id))
        .filter(Boolean);
  const plan = planBlockers(task, report, known, io.now);
  if (plan.problem) return { result: 'failed', why: plan.problem, reportRejected: true };
  for (const born of plan.planned) {
    const saved = await io.createTask(born, `chore(backlog): prerequisite ${born.id}`);
    if (!saved.ok) return { result: 'failed', why: saved.why ?? saved.outcome };
  }
  for (const id of new Set(plan.reasons.map((r) => r.taskId))) {
    const predecessor = known.find((t) => t.id === id);
    if (predecessor?.status !== 'candidate') continue;
    const promoted = applyTransition(predecessor, {
      status: 'new',
      now: io.now,
      note: `Обязательная предпосылка ${task.id}`,
    });
    const saved = await io.saveTask(
      { ...promoted.task, blocking: true },
      { from: 'candidate', to: 'new', what: `Обязательная предпосылка ${task.id}` },
    );
    if (!saved.ok) return { result: 'failed', why: saved.why ?? saved.outcome };
  }
  if (reviewingDelay(task))
    for (const reason of plan.reasons) {
      const predecessor = io.readTask(reason.taskId);
      if (!known.some((item) => item.id === reason.taskId) || !predecessor) continue;
      const what =
        `Исправление требуется для ${task.id}. Причина: ${report.delayAnalysis.cause}\n` +
        `Конкретное разблокирование и проверка: ${reason.specificResult}\n` +
        `Общее исправление и защита от повторения: ${reason.preventionResult}`;
      const written = await io.amendTask(
        reason.taskId,
        what,
        `chore(backlog): repair criteria for ${task.id}`,
        'agent',
        delayKey([plan.operation, reason.taskId]),
      );
      if (!written.ok) return { result: 'failed', why: written.why ?? written.outcome };
    }
  const note =
    (reviewingDelay(task) ? delaySummary(report.delayAnalysis) + '\n\n' : '') +
    plan.reasons
      .map(
        (r) =>
          `Ожидает выполнения карточки ${r.taskId}: ${r.reason}. Нужен результат: ${r.result}` +
          (r.specificResult
            ? `\nКонкретное разблокирование: ${r.specificResult}\nЗащита от повторения: ${r.preventionResult}`
            : ''),
      )
      .join('\n');
  const moved = applyTransition(plan.next, { status: 'blocked', note, now: io.now });
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };
  const next = addSpent({ ...moved.task, owner: null }, report.costUsd);
  for (const key of ['change', 'pr', 'run']) {
    if (report.links?.[key] != null) next.links = { ...next.links, [key]: report.links[key] };
  }
  if (reviewingDelay(task))
    next.delayAnalysis = {
      ...task.delayAnalysis,
      phase: 'waiting',
      diagnosis: report.delayAnalysis,
      reportKey: delayKey(report),
      facts: delayFacts(next),
      dependencies: delayDependencies(next, [...known, ...plan.planned]),
    };
  const entry = { from: task.status, to: 'blocked', what: note, source: 'agent', at: io.now };
  const saved = await io.saveTask(
    next,
    reviewingDelay(task) ? delayEntry(next, note, entry) : entry,
    `chore(backlog): ${task.id} ждёт предшественников`,
  );
  if (!saved.ok) return { result: 'failed', why: saved.why ?? saved.outcome };
  const released = await io.release?.(task);
  if (released && !released.ok) return { result: 'failed', why: released.why ?? released.outcome };
  io.forgetSession?.(task.id, report.stage);
  io.removeReport(task.id, report.stage);
  return { result: 'done', status: 'blocked' };
}

export async function unblockTask(action, io) {
  const task = io.readTask(action.taskId);
  if (task?.status !== 'blocked')
    return { result: 'skipped', why: 'карточка уже не заблокирована' };
  if (!task.blockedContext?.reasons?.length || !task.dependsOn?.length)
    return { result: 'skipped', why: 'нет сохранённого основания ожидания' };
  const tasks = io
    .allTaskIds()
    .map((id) => io.readTask(id))
    .filter(Boolean);
  const pending = pendingDependencies(task, tasks, action.closedDependencyIds ?? [], {
    records: action.dependencyRecords ?? [],
    invalid: action.invalid ?? [],
    evidence: action.dependencyEvidence ?? {},
    mainBranch: action.mainBranch,
  });
  if (pending.length) return { result: 'skipped', why: pending.join(', ') };
  if (task.delayAnalysis)
    return beginDelayAnalysis(
      {
        taskId: task.id,
        mode: 'verify',
        reason: `Исправления выполнены: ${task.dependsOn.join(', ')}. Проверить сохранённый разбор, конкретное разблокирование и защиту от повторения.`,
      },
      io,
    );
  const note = `Предшественники выполнены: ${task.dependsOn.join(', ')}. Новый анализ с учётом их результата.`;
  const moved = applyTransition(task, { status: 'new', now: io.now, note });
  const next = {
    ...moved.task,
    owner: null,
    reanalysis: true,
    decomposed: false,
    analysisGeneration: (task.analysisGeneration ?? 0) + 1,
    attempts: {
      ...task.attempts,
      continuations: 0,
      cycleFailures: 0,
      spawnFailures: 0,
      apiErrors: 0,
    },
  };
  // Старые сессии не должны продолжить прежний замысел после нового анализа.
  for (const stage of BLOCKABLE) io.forgetSession?.(task.id, stage);
  const saved = await io.saveTask(next, { from: 'blocked', to: 'new', what: note, at: io.now });
  return saved.ok
    ? { result: 'done', status: 'new' }
    : { result: 'failed', why: saved.why ?? saved.outcome };
}
