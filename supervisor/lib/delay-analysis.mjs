import { createHash } from 'node:crypto';
import { addSpent, applyTransition } from './task-file.mjs';
import { dependencyFormatProblem } from './dependencies.mjs';

export const DELAY_HOURS = 5;
export const DELAY_STATES = [
  'triage',
  'decompose',
  'design',
  'audit',
  'implement',
  'revise',
  'benchmark',
  'interpret',
  'pr',
  'review',
  'deploy',
  'cleanup',
  'postmortem',
  'blocked',
  'awaiting-po',
];
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const evidence = (value) => Array.isArray(value) && value.length > 0 && value.every(nonempty);
export const delayKey = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const reviewingDelay = (task) =>
  task?.status === 'postmortem' && ['analyzing', 'verifying'].includes(task.delayAnalysis?.phase);
export const reviewingQuestion = (task) =>
  reviewingDelay(task) && task.delayAnalysis.originStatus === 'awaiting-po';

// Перечень сверяется с BLOCKABLE тестом без циклического импорта blockers.
export const WAIT_FROM = [
  'decompose',
  'design',
  'audit',
  'implement',
  'revise',
  'triage',
  'benchmark',
  'interpret',
];
/**
 * Предел принятого ожидания.
 *
 * Ожидание результата — законное состояние, а не заминка, и платить за разбор
 * ему незачем. Но БЕССРОЧНОЕ освобождение от разбора превращает застой
 * в вечный: 09.09.2026 тридцать шесть карточек простояли в «Заблокированы»,
 * не получив ни строки в собственном журнале, потому что правило прямо
 * освобождало их «спустя пять часов, сутки и сто циклов».
 *
 * Отсюда отдельная величина, крупнее обычного порога задержки: сутки против
 * пяти часов. Пять часов — мерка заминки на этапе, сутки — мерка того, что
 * ожидание не кончится само.
 */
export const WAIT_LIMIT_HOURS = 24;

/** Пережило ли ожидание свой предел. */
function waitOverdue(task, now) {
  const since = task.statusChangedAt ?? task.createdAt;
  const elapsed = Date.parse(now) - Date.parse(since);
  return Number.isFinite(elapsed) && elapsed > WAIT_LIMIT_HOURS * 3600000;
}

/**
 * Мерки «ждать заведомо некого» здесь нет намеренно.
 *
 * Соблазн был: считать ожидание пропавшей, негодной или двусмысленной карточки
 * безнадёжным и разбирать его немедленно. Мерка оказалась ненадёжной. Снимок
 * доски не обязан быть полным — архивные карточки в него не входят вовсе,
 * а мерка запуска честно засчитывает их по отдельному перечню закрытых. Значит
 * «пропала» на неполном снимке означает не беду, а неполный снимок, и разбор
 * ушёл бы платить за каждую задачу, ждущую архивного предшественника.
 *
 * Ожидание закрытой карточки при этом разбирается и без такой мерки: ребро
 * снимается вместе с обоснованием, и задача выходит обычной разблокировкой.
 * Остальное ловит предел по сроку.
 */
function acceptedWait(task, { now } = {}) {
  const context = task.blockedContext;
  const shaped =
    task.status === 'blocked' &&
    !task.delayAnalysis &&
    !dependencyFormatProblem(task) &&
    task.dependsOn?.length > 0 &&
    nonempty(context?.operation) &&
    WAIT_FROM.includes(context?.from) &&
    Array.isArray(context?.reasons) &&
    context.reasons.length > 0 &&
    context.reasons.every(
      (item) =>
        item &&
        task.dependsOn.includes(item.taskId) &&
        nonempty(item.reason) &&
        nonempty(item.result),
    );
  return shaped && !waitOverdue(task, now);
}

export function delayStateProblem(task) {
  const saved = task.delayAnalysis;
  if (
    saved !== undefined &&
    (!saved ||
      !nonempty(saved.episode) ||
      !DELAY_STATES.includes(saved.originStatus) ||
      !Number.isFinite(Date.parse(saved.originSince)) ||
      !['analyzing', 'verifying', 'waiting', 'monitoring'].includes(saved.phase) ||
      !nonempty(saved.facts) ||
      !Array.isArray(saved.dependencies))
  )
    return 'неполный сохранённый разбор задержки';
  const pending = task.delayJournal;
  if (
    pending !== undefined &&
    (!pending || !pending.entry || !nonempty(pending.entry.deliveryKey) || !evidence(pending.parts))
  )
    return 'неполный конверт комментария задержки';
  return null;
}

// Комментарии, попытки и служебная активность не являются новыми фактами диагноза.
const stableLinks = (links = {}) => ['change', 'pr', 'run'].map((key) => links[key] ?? null);
export const delayFacts = (task) =>
  delayKey([
    task.title,
    task.description,
    stableLinks(task.links),
    task.dependsOn,
    task.dependencyResults,
    task.blockedContext?.reasons,
    ...(task.question ? [task.question] : []),
  ]);

export function delayDependencies(task, tasks = []) {
  const ids = new Set(task.dependsOn ?? []);
  const seen = new Set();
  const result = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const found = tasks.filter((item) => item.id === id);
    const item = found.length === 1 ? found[0] : null;
    result.push({
      id,
      status:
        found.length > 1
          ? 'ambiguous'
          : item?.valid === false
            ? 'invalid'
            : (item?.status ?? 'missing'),
      links: stableLinks(item?.links),
      splitInto: item?.splitInto ?? [],
      dependsOn: item?.dependsOn ?? [],
      diagnosis: item?.delayAnalysis?.diagnosis ?? null,
    });
    for (const child of [...(item?.splitInto ?? []), ...(item?.dependsOn ?? [])]) ids.add(child);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export function delayDecision(task, { now, tasks = [], answered = false }) {
  if (task.delayJournal) return { kind: 'flush-delay-journal', taskId: task.id };
  if (acceptedWait(task, { now })) return null;
  if (task.status === 'awaiting-po' && answered) return null;
  if (!DELAY_STATES.includes(task.status) || reviewingDelay(task)) return null;
  const saved = task.delayAnalysis;
  const snapshot = delayDependencies(task, tasks);
  const facts = delayFacts(task);
  // Второй затвор бессрочности. Для ожидания эпизод считался неизменным
  // по одной лишь сохранённой фазе, без сверки времени, — и потому наблюдение
  // глушило повторный разбор навсегда, даже когда ожидание пережило предел.
  // Отсчёт идёт от входа в статус, а разбор возвращает задачу в «Заблокированы»
  // заново: значит платный разбор случается не чаще раза в сутки ожидания.
  const overdueWait = task.status === 'blocked' && waitOverdue(task, now);
  const sameEpisode =
    saved &&
    !overdueWait &&
    ((task.status === 'blocked' && saved.phase === 'waiting') ||
      (task.status === saved.originStatus && task.statusChangedAt === saved.originSince));
  if (sameEpisode) {
    if (saved.facts !== facts)
      return {
        kind: 'analyze-delay',
        taskId: task.id,
        mode: 'review',
        reason: 'Изменились факты сохранённого разбора задержки',
      };
    if (delayKey(snapshot) !== delayKey(saved.dependencies ?? []))
      return { kind: 'observe-delay', taskId: task.id, snapshot };
    return null;
  }
  const since = task.statusChangedAt ?? task.createdAt;
  const elapsed = Date.parse(now) - Date.parse(since);
  const question = task.status === 'awaiting-po';
  if (!Number.isFinite(elapsed) || elapsed < 0 || (!question && elapsed <= DELAY_HOURS * 3600000))
    return null;
  return {
    kind: 'analyze-delay',
    taskId: task.id,
    mode: 'initial',
    status: task.status,
    since,
    reason: question
      ? 'Проверить смысл ожидания ответа: требуется решение владельца или результат другой задачи.'
      : `Более ${DELAY_HOURS} часов в статусе ${task.status}: с ${since}. Требуется разбор причины задержки.`,
  };
}

export function delayEntry(task, what, extra = {}) {
  const entry = { from: task.status, to: task.status, what, ...extra };
  return { ...entry, deliveryKey: delayKey([task.id, task.delayAnalysis?.episode, entry]) };
}

export async function beginDelayAnalysis(action, io) {
  const task = io.readTask(action.taskId);
  if (!task || task.delayJournal || reviewingDelay(task))
    return { result: 'skipped', why: 'разбор уже назначен или ожидает публикации' };
  if (!DELAY_STATES.includes(task.status))
    return { result: 'skipped', why: 'карточка уже продвинулась' };
  if (task.status === 'awaiting-po' && io.readAnswer?.(task.id))
    return { result: 'skipped', why: 'владелец уже ответил' };
  if (task.owner && task.owner !== io.machine)
    return { result: 'raced', why: 'карточка занята другой станцией' };
  if (
    action.mode === 'initial' &&
    (task.status !== action.status || (task.statusChangedAt ?? task.createdAt) !== action.since)
  )
    return { result: 'skipped', why: 'состояние изменилось после снимка' };
  const old = task.delayAnalysis;
  const initial = action.mode === 'initial' || !old;
  const diagnosis = {
    ...(initial ? {} : old),
    episode: initial ? `${task.status}:${task.statusChangedAt ?? task.createdAt}` : old.episode,
    originStatus: initial ? task.status : old.originStatus,
    originSince: initial ? (task.statusChangedAt ?? task.createdAt) : old.originSince,
    originReturnTo: initial ? task.returnTo : old.originReturnTo,
    originAttempts: initial ? task.attempts : old.originAttempts,
    phase: action.mode === 'verify' ? 'verifying' : 'analyzing',
    reason: action.reason,
    facts: delayFacts(task),
    dependencies: delayDependencies(
      task,
      io
        .allTaskIds()
        .map((id) => io.readTask(id))
        .filter(Boolean),
    ),
  };
  const moved =
    task.status === 'postmortem'
      ? { task }
      : applyTransition(task, {
          status: 'postmortem',
          now: io.now,
          note: action.reason,
        });
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };
  const acquired = await io.acquire?.(task);
  if (acquired && !acquired.ok) return { result: 'raced', why: acquired.why ?? acquired.outcome };
  const next = { ...moved.task, owner: io.machine ?? task.owner, delayAnalysis: diagnosis };
  // Если PUT пройдёт, а комментарий нет, следующая сессия всё равно должна
  // начать этот разбор заново, а не продолжить старый postmortem из памяти.
  io.forgetSession?.(task.id, 'postmortem');
  const saved = await io.saveTask(
    next,
    delayEntry(
      next,
      `${action.reason}\nСохранённый разбор и результаты связанных карточек будут проверяться без повторной диагностики на неизменных фактах.`,
      { from: task.status, to: 'postmortem', at: io.now },
    ),
    `chore(backlog): delay analysis ${task.id}`,
  );
  if (!saved.ok) {
    if (acquired && !reviewingDelay(io.readTask(task.id))) await io.release?.(task);
    return { result: 'failed', why: saved.why ?? saved.outcome };
  }
  return { result: 'done', status: 'postmortem' };
}

export async function observeDelay(action, io) {
  const task = io.readTask(action.taskId);
  if (!task?.delayAnalysis || task.delayJournal) return { result: 'skipped' };
  if (delayKey(action.snapshot) === delayKey(task.delayAnalysis.dependencies ?? []))
    return { result: 'skipped' };
  const next = { ...task, delayAnalysis: { ...task.delayAnalysis, dependencies: action.snapshot } };
  const note =
    'Наблюдение по сохранённому разбору задержки. Статусы связанных карточек:\n' +
    action.snapshot.map((item) => `${item.id}: ${item.status}`).join('\n') +
    '\nОжидаемые результаты остаются указанными в разборе; закрытие без результата не снимает блокировку.';
  const saved = await io.saveTask(
    next,
    delayEntry(next, note, { at: io.now }),
    `chore(backlog): observe delay ${task.id}`,
  );
  return saved.ok ? { result: 'done' } : { result: 'failed', why: saved.why ?? saved.outcome };
}

export function delayReportProblem(task, report) {
  if (report.stage !== 'postmortem' || report.taskId !== task.id)
    return 'отчёт разбора задержки о другой задаче или этапе';
  const diagnosis = report.delayAnalysis;
  if (
    !diagnosis ||
    !nonempty(diagnosis.cause) ||
    !evidence(diagnosis.evidence) ||
    !nonempty(diagnosis.nextAction)
  )
    return 'разбору задержки нужны cause, evidence и nextAction';
  if (!['done', 'blocked'].includes(report.outcome))
    return 'разбор задержки ожидает done или blocked';
  if (reviewingQuestion(task)) {
    const verifying = task.delayAnalysis.phase === 'verifying';
    if (report.outcome === 'blocked' || verifying) {
      if (diagnosis.waitingFor !== 'dependencies')
        return 'техническое ожидание требует waitingFor: dependencies';
    } else if (diagnosis.waitingFor !== 'owner' || diagnosis.resolution !== 'monitor') {
      return 'непроверенный вопрос требует owner/monitor либо blocked с зависимостями';
    }
  }
  if (report.outcome === 'blocked') {
    if (!Array.isArray(report.blockers) || !report.blockers.length) return 'не названы исправления';
    for (const blocker of report.blockers)
      if (!nonempty(blocker.specificResult) || !nonempty(blocker.preventionResult))
        return 'исправлению нужны specificResult и preventionResult с проверяемыми критериями';
  } else {
    if (!['monitor', 'resolved'].includes(diagnosis.resolution))
      return 'нужен исход monitor или resolved';
    if (task.delayAnalysis?.phase === 'verifying' && diagnosis.resolution !== 'resolved')
      return 'результаты исправлений не подтверждены: укажите необходимую доработку через blocked';
    if (
      diagnosis.resolution === 'resolved' &&
      (!evidence(diagnosis.specificEvidence) || !evidence(diagnosis.preventionEvidence))
    )
      return 'нужны доказательства конкретного разблокирования и защиты от повторения';
    if (report.requests?.length) return 'необходимое исправление оформляется через blocked';
  }
  return null;
}

export function delaySummary(diagnosis) {
  return (
    `Разбор задержки\nПричина: ${diagnosis.cause}\nФакты:\n${diagnosis.evidence.join('\n')}\nСледующее действие: ${diagnosis.nextAction}` +
    (diagnosis.specificEvidence
      ? `\nПодтверждение разблокирования:\n${diagnosis.specificEvidence.join('\n')}`
      : '') +
    (diagnosis.preventionEvidence
      ? `\nЗащита от повторения:\n${diagnosis.preventionEvidence.join('\n')}`
      : '')
  );
}

export async function rejectDelayReport(task, report, problem, io) {
  const key = delayKey(report);
  if (task.delayAnalysis.invalidReportKey !== key) {
    const next = addSpent(
      {
        ...task,
        delayAnalysis: { ...task.delayAnalysis, invalidReportKey: key, validationError: problem },
      },
      report.costUsd,
    );
    const written = await io.saveTask(
      next,
      delayEntry(
        next,
        `Разбор задержки не принят: ${problem}. Предыдущий диагноз сохранён. Следующий заход должен дополнить доказательства; действуют обычные пределы попыток.`,
        { source: 'supervisor', at: io.now },
      ),
      `chore(backlog): incomplete delay analysis ${task.id}`,
    );
    if (!written.ok) return { result: 'failed', why: written.why ?? written.outcome };
  }
  io.forgetSession?.(task.id, 'postmortem');
  io.removeReport(task.id, 'postmortem');
  return { result: 'failed', why: problem };
}

export async function finishDelayAnalysis(task, report, io, { ownerAnswered = false } = {}) {
  const saved = task.delayAnalysis;
  const wasBlocked = saved.originStatus === 'blocked' && saved.phase === 'verifying';
  const resumeQuestion = reviewingQuestion(task) && saved.phase === 'verifying' && !ownerAnswered;
  const status = resumeQuestion ? saved.originReturnTo : wasBlocked ? 'new' : saved.originStatus;
  const diagnosis = ownerAnswered
    ? {
        cause: 'Во время проверки вопроса получен ответ владельца',
        evidence: ['Ответ найден после исходной даты вопроса'],
        nextAction: 'Передать ответ обычному обработчику, не заменяя его классификацией',
        waitingFor: 'owner',
        resolution: 'monitor',
      }
    : report.delayAnalysis;
  const moved =
    task.status === status
      ? { task }
      : applyTransition(task, {
          status,
          now: io.now,
          note: diagnosis.nextAction,
        });
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };
  let next = addSpent(
    {
      ...moved.task,
      statusChangedAt: wasBlocked || resumeQuestion ? io.now : saved.originSince,
      returnTo: resumeQuestion ? null : (saved.originReturnTo ?? null),
      attempts: saved.originAttempts,
      categories: report.categories ?? task.categories,
      ...(['blocked', 'new'].includes(status) ? { owner: null } : {}),
      ...(wasBlocked
        ? {
            reanalysis: true,
            decomposed: false,
            analysisGeneration: (task.analysisGeneration ?? 0) + 1,
          }
        : {}),
      delayAnalysis: {
        ...saved,
        phase: 'monitoring',
        diagnosis,
        reportKey: delayKey(report),
      },
    },
    report.costUsd,
  );
  next.delayAnalysis.facts = delayFacts(next);
  const written = await io.saveTask(
    next,
    delayEntry(next, delaySummary(diagnosis), {
      from: 'postmortem',
      source: 'agent',
      at: io.now,
    }),
    `chore(backlog): record delay diagnosis ${task.id}`,
  );
  if (!written.ok) return { result: 'failed', why: written.why ?? written.outcome };
  if (['blocked', 'new'].includes(next.status)) {
    const released = await io.release?.(task);
    if (released && !released.ok)
      return { result: 'failed', why: released.why ?? released.outcome };
  }
  io.forgetSession?.(task.id, 'postmortem');
  io.forgetSession?.(task.id, next.status);
  io.removeReport(task.id, 'postmortem');
  return { result: 'done', status: next.status };
}
