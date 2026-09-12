import { applyReport, haltOf } from './apply-report.mjs';
import {
  addSpent,
  applyTransition,
  countRejection,
  linkArtifact,
  relate,
  resetAttempts,
} from './task-file.mjs';
import { judgeDenials } from './denials.mjs';
import { pipelineCause, recoveryFrom } from './recovery.mjs';
import { planAmendments, planRequests } from './requests.mjs';

import { transferBlocked } from './blockers.mjs';
import { finishTokenReanalysis, tokenAnalysisReportKey } from './token-reanalysis.mjs';
import {
  reviewingDelay,
  reviewingQuestion,
  delayReportProblem,
  finishDelayAnalysis,
  delayKey,
  rejectDelayReport,
} from './delay-analysis.mjs';
import { categoriesProblem } from './categories.mjs';
import { closureReasonFor, closureRequestKey } from './closure.mjs';
import { journalBody } from './journal.mjs';
import { workKindProblem } from './scheduling.mjs';
/** План собирается теми же правилами, но все записи становятся данными. */
export async function prepareReportPlan(action, io, saved = null) {
  if (saved) return globalThis.structuredClone(saved);
  if (!action.reportId) throw new Error('reportId is required for a durable plan');
  const operations = [];
  const cleanup = [];
  let finalized = false;
  function record(kind, args) {
    const target = typeof args[0] === 'string' ? args[0] : args[0].id;
    operations.push({
      key: `${action.reportId}:${kind}:${operations.length}:${target}`,
      kind,
      args: globalThis.structuredClone(args),
      expected: kind === 'saveTask' ? globalThis.structuredClone(io.readTask(target)) : null,
    });
    return { ok: true, outcome: 'saved' };
  }
  const result = await transferReport(action, {
    ...io,
    saveTask: (...args) => record('saveTask', args),
    release: (...args) => record('release', args),
    createTask: (...args) => record('createTask', args),
    amendTask: (...args) => record('amendTask', args),
    askOwner: (...args) => {
      record('askOwner', args);
      return null;
    },
    recordAnswer: (...args) => {
      record('recordAnswer', args);
      return null;
    },
    forgetSession: (...args) => cleanup.push(args),
    removeReport: () => {
      finalized = true;
    },
  });
  // Отбраковка неполного разбора тоже завершает доставку: её диагностику
  // и расход сохраняем, хотя исход обработчика остаётся failed.
  if (result.result !== 'done' && !finalized)
    throw new Error(result.why ?? 'cannot prepare report plan');
  return { version: 1, reportId: action.reportId, operations, cleanup, result };
}

/**
 * Улики о деле этапа: каждый done проверяется независимо от отказов.
 *
 * Отметка начала этапа живёт у супервизора, рядом с идентификатором сессии,
 * а прочее берётся из git. Складываются они здесь, потому что сам суд над
 * отказом — чистый счёт и ни о том, ни о другом не знает.
 */
function evidenceFor(task, stage, io) {
  return {
    ...(io.stageEvidence?.(task) ?? {}),
    stageStartedAt: io.stageStartedAt?.(task.id, stage) ?? null,
  };
}

/** Перенести отчёт сессии в бэклог. */
export async function transferReport(action, io) {
  const task = io.readTask(action.taskId);
  const report = io.readReport(action.taskId, action.stage);
  if (!task || !report) return { result: 'skipped', why: 'задачи или отчёта нет' };

  if (
    task.status !== report.stage &&
    task.tokenReanalysis?.reportKey === tokenAnalysisReportKey(report)
  ) {
    io.forgetSession?.(task.id, report.stage);
    io.removeReport(task.id, report.stage);
    return { result: 'done', status: task.status };
  }

  // След и отказанные действия судят ЗДЕСЬ, а не в супервизоре, и после разбора
  // отчёта, а не до него. До разбора неизвестны ни исход, ни ссылки — то
  // есть ровно то, чем след и проверяется; суд получался бы вслепую и
  // потому не мог не быть грубым.
  const denials = report.denials ?? [];
  const trust = judgeDenials({
    denials,
    report,
    stage: action.stage,
    evidence: report.outcome === 'done' ? evidenceFor(task, action.stage, io) : {},
  });

  if (trust.verdict === 'undermining') {
    // Отчёт при этом не пропадает. Основание записано ценой: 31.08.2026
    // задача 0006 ушла в ошибку с полностью снятыми числами шестидесяти
    // матчей, и числа эти остались лежать в логе, которого не прочитал никто.
    const stopped = await halt(task, trust.why, io, {
      what: report.summary,
      decisions: report.decisions ?? [],
      links: report.links ?? {},
      denials,
    });
    // Отчёт снимается с очереди и здесь: иначе следующий цикл принёс бы его
    // снова, а задача уже стоит в разборе.
    if (stopped.result === 'done') {
      // До удавшейся записи отметка начала нужна повторной приёмке.
      io.forgetSession?.(action.taskId, action.stage);
      io.removeReport(action.taskId, action.stage);
    }
    return stopped;
  }

  // «Сверять нечем» — не отсутствие следа, а поломка прибора либо этап,
  // у которого проверяемого следа не бывает вовсе. Отчёт применяется,
  // но молчать об этом нельзя: отметка и есть та заметность, ради которой
  // заводилось прежнее правило.
  const denialsNote = trust.verdict === 'unverifiable' ? trust.why : undefined;

  if (task.delayAnalysis?.reportKey === delayKey(report) && !task.delayJournal) {
    if (['blocked', 'new'].includes(task.status)) {
      const released = await io.release?.(task);
      if (released && !released.ok)
        return { result: 'failed', why: released.why ?? released.outcome };
    }
    io.forgetSession?.(task.id, report.stage);
    if (task.delayAnalysis.phase === 'monitoring') io.forgetSession?.(task.id, task.status);
    io.removeReport(task.id, report.stage);
    return { result: 'done', status: task.status };
  }
  if (reviewingDelay(task)) {
    if (
      reviewingQuestion(task) &&
      report.taskId === task.id &&
      report.stage === task.status &&
      io.readAnswer?.(task.id)
    )
      return finishDelayAnalysis(task, report, io, { ownerAnswered: true });
    const problem = delayReportProblem(task, report) || categoriesProblem(report.categories, true);
    if (problem) return rejectDelayReport(task, report, problem, io);
    if (report.outcome !== 'blocked') return finishDelayAnalysis(task, report, io);
  }
  if (report.outcome === 'blocked') return transferBlocked(task, report, action, io);
  const categoryProblem = categoriesProblem(report.categories, report.routingVersion === 1);
  if (categoryProblem) return { result: 'failed', why: categoryProblem };
  const workProblem = workKindProblem({
    ...task,
    workKind: report.workKind ?? task.workKind,
    workReason: report.workReason ?? task.workReason,
  });
  if (workProblem) return { result: 'failed', why: workProblem };
  if (report.categories && report.requests) {
    if (!Array.isArray(report.requests)) return { result: 'failed', why: 'requests не массив' };
    for (const request of report.requests) {
      const problem = categoriesProblem(request?.categories, true);
      if (problem) return { result: 'failed', why: problem };
    }
  }

  const verdict = applyReport(task, report, { maxRejections: io.maxRejections });
  if (task.status === 'review' && report.outcome === 'done' && verdict.status === 'deploy') {
    const impact = io.deploymentImpact?.(report.links?.pr ?? task.links?.pr);
    if (impact?.needed === false) {
      verdict.status = 'cleanup';
      verdict.note = (verdict.note ?? '') + '\nВыкладка игры не нужна: ' + impact.reason;
    }
  }
  const moved = applyTransition(task, { status: verdict.status, note: verdict.note, now: io.now });
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };

  // Остановленная задача счётчиков больше не считает: их обнулил сам переход
  // в сквозное состояние, и наращивать возвраты поверх обнулённого значило бы
  // приписать разбору спор, которого он не вёл.
  const halted = verdict.status === 'postmortem' || verdict.status === 'failed';

  // Дошедший до конца этап обнуляет счётчики: прошлые заминки больше не в счёт,
  // иначе задача упрётся в предел там, где всё было хорошо.
  //
  // Возврат наращивает свой счёт — возвраты подряд, до предела спора, — а
  // продолжения гасит так же, как успех: они считают сессии на этапе, с которого
  // задача уходит. Счёт, притащенный с аудита, останавливал проработку, не дав
  // ей ни одной сессии (02.09.2026: 0022, 0080, 0088; карточка 0081).
  let next = halted
    ? moved.task
    : report.outcome === 'rejected'
      ? countRejection(moved.task)
      : resetAttempts(moved.task);

  const resumedTokenAnalysis =
    task.status === 'decompose' &&
    task.tokenReanalysis?.phase === 'analyzing' &&
    report.outcome === 'done' &&
    !halted;
  if (resumedTokenAnalysis) next = finishTokenReanalysis(task, next, report, io.now);

  // Ревью знает итог реализации; уборка работает без модели и лишь доставляет его.
  if (
    !halted &&
    report.outcome === 'done' &&
    (verdict.status === 'completed' ||
      (task.status === 'review' && ['deploy', 'cleanup'].includes(verdict.status)))
  ) {
    next.completionSummary = journalBody({
      what: report.summary,
      decisions: report.decisions,
      links: report.links,
    }).trim();
    if (!next.completionSummary) delete next.completionSummary;
  } else if (!halted && ['design', 'implement', 'revise'].includes(verdict.status)) {
    delete next.completionSummary;
  }

  // Возврат отправляет задачу на этап, где сессия уже была, и возобновлять её
  // нельзя: возобновлённая отвечает из своей памяти — «всё сделано» — и вершина
  // между кругами не меняется вовсе. Забытая сессия начинается заново и читает
  // свежее замечание журналом, как и всякий новый исполнитель.
  if (report.outcome === 'rejected' && !halted) {
    io.forgetSession?.(action.taskId, verdict.status);
  }

  // По той же причине забывается и прошлый разбор: задача, однажды
  // разобранная и упавшая снова, возобновила бы ту сессию — и услышала бы
  // от неё вывод о позапрошлом падении.
  if (verdict.status === 'postmortem') io.forgetSession?.(action.taskId, 'postmortem');

  // Расход прибавляется на ЛЮБОМ исходе отчёта, включая возврат и остановку:
  // сессия стоила денег независимо от того, чем кончилась, а вся мера затеяна
  // ровно против кругов, каждый из которых чем-то кончался.
  next = addSpent(next, report.costUsd);
  if (report.categories) next.categories = [...report.categories];
  if (report.workKind !== undefined) {
    next.workKind = report.workKind;
    next.workReason = report.workReason;
  }

  // Ссылки из отчёта переносятся В САМУ ЗАДАЧУ, а не только в журнал.
  // По ним конвейер потом опрашивает проверки и доказывает влитость: без
  // номера pull request задача висела бы в ожидании проверок вечно, потому
  // что опрашивать было бы нечего. Дыра найдена сверкой скиллов с кодом.
  for (const key of ['change', 'pr', 'run']) {
    const value = report.links?.[key];
    if (value != null && value !== '') next = linkArtifact(next, key, value);
  }

  // Заявки разбираются до записи: идентификаторы нужны, чтобы связать
  // порождённые задачи с породившей одним коммитом, а не двумя.
  const plan = planRequests(report.requests, {
    existingIds: io.allTaskIds(),
    now: io.now,
    sourceId: task.id,
    // Этап, с которого пришёл отчёт: по нему решается, слушать ли признак
    // блокирующей заявки. Право заводить работу мимо шлюза кандидатов есть
    // только у разбора ошибки.
    sourceStage: task.status,
    // Разбор, назвавший причину конвейерной, заводит конвейерные заявки.
    pipelineCause: pipelineCause(report),
    // Части, рождённые дроблением, анализ на дробность уже прошли — в лице
    // задачи, которая их и породила, — и потому идут из очереди сразу
    // в проработку.
    decomposed: report.outcome === 'split',
  });
  // Частичный план не доказывает завершение разделения: иначе потерянная
  // часть исчезнет из ожиданий всех потребителей закрытого родителя.
  if (verdict.status === 'closed' && plan.rejected.length > 0) {
    return {
      result: 'failed',
      why: `передача работы не сохранена: ${plan.rejected.flatMap((bad) => bad.problems).join('; ')}`,
    };
  }
  for (const bad of plan.rejected) {
    // Негодная заявка не отменяет остального: остальные заводятся, а эта
    // остаётся в журнале с причиной, по которой её не приняли.
    plan.notes = [...(plan.notes ?? []), `заявка отклонена: ${bad.problems.join('; ')}`];
  }

  // Вердикт удавшегося разбора едет в саму задачу: по нему сканер потом
  // решает, возвращать ли её из ошибки и когда. Идентификаторы конвейерных
  // починок известны уже здесь — до записи, — и разбору знать их не нужно.
  if (task.status === 'postmortem' && verdict.status === 'failed' && report.outcome === 'done') {
    const judged = recoveryFrom(report, {
      task: next,
      created: plan.planned.filter((born) => born.area === 'pipeline').map((born) => born.id),
      known: io.allTaskIds(),
      maxReturns: io.maxAutoReturns,
    });
    next = { ...next, recovery: judged.recovery };
    plan.notes = [...(plan.notes ?? []), ...judged.notes];
  }

  // Дополнения разбираются здесь же и по тем же правилам: одна негодная
  // запись не отменяет остальных, а причина отказа уезжает в журнал.
  const facts = planAmendments(report.amendments, {
    known: new Map(
      io
        .allTaskIds()
        .map((id) => [id, io.readTask(id)])
        .filter(([, item]) => item),
    ),
    sourceId: task.id,
  });
  for (const bad of facts.rejected) {
    plan.notes = [...(plan.notes ?? []), `дополнение отклонено: ${bad.problems.join('; ')}`];
  }

  // Задачи по заявкам заводятся ПЕРЕД сменой состояния породившей, и порядок
  // этот выстрадан. Пока было наоборот, неудача на заявках оставляла отчёт
  // непринятым при уже применённом переходе — а повторить перенос было
  // нельзя: отчёт говорил об этапе, из которого задача уже вышла, и второй
  // заход отправил бы её в ошибку. Заявки при этом пропадали насовсем.
  //
  // Теперь неудача на заявках не оставляет следов: состояние не тронуто,
  // отчёт цел, и следующий цикл начнёт заново. Каждая задача уезжает своим
  // коммитом: правило «коммит на смысловую правку» не делает исключения
  // для порождённых.
  const created = [];
  for (const [index, planned] of plan.planned.entries()) {
    const key = verdict.status === 'closed' ? closureRequestKey(task, report, index) : null;
    const matches = key
      ? io
          .allTaskIds()
          .map((id) => io.readTask(id))
          .filter((item) => item?.closureRequestKey === key)
      : [];
    if (matches.length > 1)
      return {
        result: 'failed',
        why: 'неоднозначные карточки продолжения закрываемой задачи',
        created,
      };
    if (matches.length === 1) {
      created.push(matches[0].id);
      next = relate(next, matches[0].id);
      continue;
    }
    const born = key ? { ...planned, closureRequestKey: key } : planned;
    const pushed = await io.createTask(
      born,
      `chore(backlog): ${born.id} заведена по разбору ${action.taskId}`,
    );
    if (!pushed.ok) return { result: 'failed', why: pushed.outcome, created };
    created.push(born.id);
    next = relate(next, born.id);
  }

  // Части — отдельная связь, не общий related с замечаниями и прогонами.
  // Сохраняем её вместе с закрытием, только после создания всех частей.
  if (report.outcome === 'split' && verdict.status === 'closed') {
    next = { ...next, splitInto: [...created] };
  }

  if (!halted && (report.outcome === 'moot' || verdict.status === 'closed')) {
    next = { ...next, closureReason: closureReasonFor(report, created, io.taskLink) };
  }

  // Дополнения уезжают тем же порядком и по той же причине: до смены
  // состояния, каждое своим коммитом. Неудача здесь не оставляет следов —
  // состояние не тронуто, отчёт цел, следующий цикл начнёт заново.
  const amended = [];
  for (const item of facts.planned) {
    const written = await io.amendTask(
      item.taskId,
      `**Дополнение по разбору ${task.id}**\n\n${item.facts}\n`,
      `chore(backlog): ${item.taskId} дополнена фактурой из разбора ${task.id}`,
      'agent',
    );
    if (!written.ok) return { result: 'failed', why: written.outcome, created, amended };
    amended.push(item.taskId);
    // Связь проставляется у источника. Обратной не делаем намеренно: правка
    // чужой задачи ради ссылки — это переезд карточки в ту же колонку и лишняя
    // запись в её журнале, а сам источник и так назван в тексте дополнения.
    next = relate(next, item.taskId);
  }

  // Пакет выкладки разносится ДО записи ведущей и по той же причине, что
  // заявки: неудача на середине не должна оставлять отчёт непринятым при
  // уже сдвинутой ведущей. Задачи, уже переехавшие прошлым заходом,
  // разноска узнаёт по состоянию и пропускает — перенос идемпотентен.
  if (action.stage === 'deploy' && Array.isArray(report.batch)) {
    const spread = await spreadBatch(task, report, io);
    if (!spread.ok) return { result: 'failed', why: spread.why, created, amended };
    for (const id of spread.moved) next = relate(next, id);
    plan.notes = [...(plan.notes ?? []), ...spread.notes];
  }

  // Вопрос записывается ТЕМ ЖЕ действием, что и переход в ожидание.
  // Схема задачи требует поля `question` при этом состоянии, а без записи
  // вопроса у ожидания нет выхода вовсе.
  const asks = verdict.status === 'awaiting-po';
  if (asks) {
    next = {
      ...next,
      question: { askedAt: io.now, summary: report.summary ?? verdict.note, answeredAt: null },
    };
  }

  // Ответ, собранный спрашивающей сессией, уезжает туда же. Не записав его,
  // конвейер оставил бы вопрос без ответа: следующая спрашивающая сессия
  // задала бы тот же вопрос заново, а летопись говорила бы, что владелец
  // продукта так и не ответил.
  const answering = action.stage === 'awaiting-po';
  if (answering && task.question) {
    next = { ...next, question: { ...task.question, answeredAt: io.now } };
  }

  // Куда именно ложится вопрос — дело хранилища. Файловый бэклог пишет
  // его в `manage/questions.md` и просит увезти файл тем же коммитом;
  // доска пишет комментарий к карточке, и увозить ей нечего.
  const asked = asks ? await io.askOwner(next, report) : null;
  const answered = answering ? await io.recordAnswer(next, action, report) : null;

  const push = await io.saveTask(
    next,
    {
      at: io.now,
      from: task.status,
      to: verdict.status,
      ...(verdict.status === 'completed' ? { completionSummary: next.completionSummary } : {}),
      ...(resumedTokenAnalysis ? { restorePriority: task.tokenReanalysis.originPriority } : {}),
      ...(verdict.status === 'closed' ? { closureReason: next.closureReason } : {}),
      // Обычно запись журнала говорит словами сессии — её `summary`. Исходу
      // `moot` этого мало: спецификация требует, чтобы запись назвала причину
      // ВМЕСТЕ с доказательством, а сложены они в одну фразу только в записке
      // разбора — «Предмет снят: … Проверено: …». Деться доказательству больше
      // некуда: `task.history` доска не хранит вовсе, а отчёт после переноса
      // снимается, и лог этапа в промпт следующих сессий не уезжает. Без этой
      // строки закрытая задача осталась бы в журнале заявлением без улики —
      // ровно тем, против чего написан третий предохранитель исхода.
      what:
        (report.outcome === 'moot' && !halted) ||
        (task.status === 'review' && verdict.status === 'cleanup')
          ? verdict.note
          : report.summary,
      links: verdict.status === 'completed' ? next.links : (report.links ?? {}),
      decisions: [...(report.decisions ?? []), ...(plan.notes ?? [])],
      problem: halted ? verdict.note : undefined,
      denials,
      denialsNote,
      // Здесь и только здесь запись говорит словами сессии: всё остальное,
      // что конвейер пишет на доску, — его собственная механика.
      source: 'agent',
    },
    `chore(backlog): ${task.id} ${task.status} → ${verdict.status}`,
    [asked, answered].filter(Boolean),
  );
  if (!push.ok) return { result: 'failed', why: push.outcome, created, amended };

  // Перенесённый отчёт завершает заход при любом исходе. Память о нём
  // не должна подменить чтение новой задачи при следующем возврате.
  io.forgetSession?.(action.taskId, action.stage);

  // Отчёт снимается с очереди только после удавшейся отправки: иначе
  // при неудаче этап пришлось бы проходить заново, потеряв уже сделанное.
  io.removeReport(action.taskId, action.stage);
  return {
    result: 'done',
    status: verdict.status,
    created,
    amended,
    rejected: [...plan.rejected, ...facts.rejected],
  };
}

/**
 * Разнести отчёт пакетной выкладки по задачам пакета.
 *
 * Отчёт один — ведущей, — а задач в пакете много, и о них говорят два
 * перечня: `deployed` (код выложен → `cleanup`) и `skipped` (`{ taskId, why }`,
 * из пакета исключена → `failed` с причиной). Исход `outcome` относится
 * к ведущей и разбирается общим порядком; здесь двигаются только прочие.
 *
 * Отчёт властен ровно над своим пакетом — перечнем из назначения, который
 * супервизор вернул вместе с отчётом. Идентификатор не из пакета не двигает
 * ничего: сессия не откроет доску, и назвать чужую задачу может только
 * по ошибке. Задача пакета, не названная ни в одном перечне, остаётся
 * в `deploy` и попадёт в следующий пакет — молча увести её в уборку нельзя:
 * сессия могла пропустить её по делу, а не по забывчивости. Оба случая
 * ложатся записью в журнал ведущей.
 *
 * Каждая задача уезжает своим коммитом, и неудача любой из них возвращает
 * неудачу целиком: ведущая и отчёт остаются на месте, следующий оборот
 * начинает заново, а уже переехавших узнаёт по состоянию.
 */
async function spreadBatch(lead, report, io) {
  const batch = report.batch.filter((id) => id !== lead.id);
  const deployed = new Set(Array.isArray(report.deployed) ? report.deployed : []);
  const skipped = new Map(
    (Array.isArray(report.skipped) ? report.skipped : [])
      .filter((item) => item && typeof item.taskId === 'string')
      .map((item) => [item.taskId, String(item.why ?? '').trim() || 'причина не названа']),
  );

  const notes = [];
  for (const id of [...deployed, ...skipped.keys()]) {
    if (id !== lead.id && !batch.includes(id)) {
      notes.push(`Отчёт назвал задачу ${id}, которой в пакете не было: она не тронута.`);
    }
  }

  const moved = [];
  for (const id of batch) {
    const member = io.readTask(id);
    if (!member) {
      notes.push(`Задача ${id} из пакета в бэклоге не найдена.`);
      continue;
    }
    // Уже переехала прошлым заходом переноса — либо её увёл человек.
    // И то и другое не наше дело: двигаем только стоящих в выкладке.
    if (member.status !== 'deploy') continue;

    const to = deployed.has(id) ? 'cleanup' : skipped.has(id) ? 'failed' : null;
    if (!to) {
      notes.push(`Задача ${id} из пакета отчётом не названа: остаётся в выкладке.`);
      continue;
    }

    const problem = to === 'failed' ? skipped.get(id) : undefined;
    const what =
      to === 'cleanup'
        ? `Выложена пакетом с ${lead.id}. ${report.summary ?? ''}`.trim()
        : `Исключена из пакета выкладки ${lead.id}.`;
    const shifted = applyTransition(member, { status: to, note: problem ?? what, now: io.now });
    if (!shifted.task) return { ok: false, why: `${id}: ${shifted.problems.join('; ')}` };

    // Дошедшая до уборки задача счётчиков не несёт, как и ведущая: прошлые
    // заминки этапа больше не в счёт. Исключённой их обнулил сам переход
    // в сквозное состояние.
    const settled = to === 'cleanup' ? resetAttempts(shifted.task) : shifted.task;
    const push = await io.saveTask(
      settled,
      {
        at: io.now,
        from: 'deploy',
        to,
        what,
        problem,
        links: report.links ?? {},
        source: 'agent',
      },
      `chore(backlog): ${id} deploy → ${to} (пакет ${lead.id})`,
    );
    if (!push.ok) return { ok: false, why: `${id}: ${push.outcome}`, moved, notes };
    moved.push(id);
  }

  return { ok: true, moved, notes };
}

export async function halt(task, why, io, extra = {}) {
  const status = haltOf(task);
  const moved = applyTransition(task, { status, note: why, now: io.now });
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };

  if (status === 'postmortem') io.forgetSession?.(task.id, 'postmortem');

  const push = await io.saveTask(
    moved.task,
    { at: io.now, from: task.status, to: status, problem: why, ...extra },
    `chore(backlog): ${task.id} остановлена, ${
      status === 'postmortem' ? 'нужен разбор' : 'разбор не довёл до причины'
    }`,
  );
  return push.ok ? { result: 'done', status } : { result: 'failed', why: push.outcome };
}
