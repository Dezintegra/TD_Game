import { applyExternal, applyReport, haltOf } from './apply-report.mjs';
import {
  applyTransition,
  claimTask,
  countContinuation,
  countRejection,
  linkArtifact,
  relate,
  releaseClaim,
  resetAttempts,
} from './task-file.mjs';
import { judgeDenials } from './denials.mjs';
import { planAmendments, planRequests } from './requests.mjs';
import { NEEDS_WORKTREE } from '../config/transitions.mjs';
import { cleanup, mayCleanup } from './cleanup.mjs';

/**
 * Исполнение решений сканера.
 *
 * Всё, что трогает мир, собрано здесь и делается через доводом переданный
 * набор действий: чтение и сохранение задачи, заведение дерева, порождение
 * процесса этапа. Поэтому порядок шагов проверяется без единого настоящего
 * коммита, дерева и запуска.
 *
 * Сохранение задачи вместе с записью журнала — ОДНА операция хранилища,
 * а не пара «записать» и «отправить». Хранилищ у бэклога два, и устроены
 * они по-разному: файловое пишет две записи и коммитит их, а доска Trello
 * двигает карточку и дописывает комментарий, безо всяких коммитов.
 * Разделять здесь то, что разделяется только у одного из них, значило бы
 * заставить исполнение знать, с чем оно работает.
 *
 * Порядок и есть главное, что здесь написано. Две вещи в нём неслучайны:
 *
 * - **захват отправляется раньше заведения дерева.** Проигравшая гонку
 *   машина тогда не оставляет за собой ни дерева, ни ветки — убирать нечего;
 * - **каждая смысловая правка уезжает своим коммитом сразу.** Неотправленный
 *   коммит не отложенная работа, а хвост: деревья ответвляются от удалённой
 *   ветки, и следующий цикл заведёт их без этих правок.
 */

/** Что случилось с действием. */
export const RESULT = {
  done: 'сделано',
  skipped: 'пропущено',
  failed: 'не удалось',
  raced: 'задачу занял кто-то другой',
};

/**
 * Улики о деле этапа: их спрашивают, только когда этапу в чём-то отказали.
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
async function transferReport(action, io) {
  const task = io.readTask(action.taskId);
  const report = io.readReport(action.taskId, action.stage);
  if (!task || !report) return { result: 'skipped', why: 'задачи или отчёта нет' };

  // Отказанные действия судят ЗДЕСЬ, а не в супервизоре, и после разбора
  // отчёта, а не до него. До разбора неизвестны ни исход, ни ссылки — то
  // есть ровно то, чем след и проверяется; суд получался бы вслепую и
  // потому не мог не быть грубым.
  const denials = report.denials ?? [];
  const trust =
    denials.length > 0
      ? judgeDenials({
          denials,
          report,
          stage: action.stage,
          evidence: evidenceFor(task, action.stage, io),
        })
      : { verdict: 'passing', why: null };

  if (trust.verdict === 'undermining') {
    // Продолжение здесь бессмысленно и стоит денег: правило разрешений
    // не изменилось, продолжатель упрётся туда же. Хуже: возобновлённая
    // сессия помнит собственный отчёт и ответит из него «всё сделано».
    io.forgetSession?.(action.taskId, action.stage);

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
    if (stopped.result === 'done') io.removeReport(action.taskId, action.stage);
    return stopped;
  }

  // «Сверять нечем» — не отсутствие следа, а поломка прибора либо этап,
  // у которого проверяемого следа не бывает вовсе. Отчёт применяется,
  // но молчать об этом нельзя: отметка и есть та заметность, ради которой
  // заводилось прежнее правило.
  const denialsNote = trust.verdict === 'unverifiable' ? trust.why : undefined;

  const verdict = applyReport(task, report, { maxRejections: io.maxRejections });
  const moved = applyTransition(task, { status: verdict.status, note: verdict.note, now: io.now });
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };

  // Остановленная задача счётчиков больше не считает: их обнулил сам переход
  // в сквозное состояние, и наращивать возвраты поверх обнулённого значило бы
  // приписать разбору спор, которого он не вёл.
  const halted = verdict.status === 'postmortem' || verdict.status === 'failed';

  // Дошедший до конца этап обнуляет счётчики: прошлые заминки больше не в счёт,
  // иначе задача упрётся в предел там, где всё было хорошо.
  //
  // Возврат — случай особый: обнулить счёт здесь значило бы никогда до предела
  // и не дойти. Поэтому возврат счёт наращивает, а гасит его успех проверки.
  let next = halted
    ? moved.task
    : report.outcome === 'rejected'
      ? countRejection(moved.task)
      : resetAttempts(moved.task);

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
  });
  for (const bad of plan.rejected) {
    // Негодная заявка не отменяет остального: остальные заводятся, а эта
    // остаётся в журнале с причиной, по которой её не приняли.
    plan.notes = [...(plan.notes ?? []), `заявка отклонена: ${bad.problems.join('; ')}`];
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
  for (const born of plan.planned) {
    const pushed = await io.createTask(
      born,
      `chore(backlog): ${born.id} заведена по разбору ${action.taskId}`,
    );
    if (!pushed.ok) return { result: 'failed', why: pushed.outcome, created };
    created.push(born.id);
    next = relate(next, born.id);
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
    );
    if (!written.ok) return { result: 'failed', why: written.outcome, created, amended };
    amended.push(item.taskId);
    // Связь проставляется у источника. Обратной не делаем намеренно: правка
    // чужой задачи ради ссылки — это переезд карточки в ту же колонку и лишняя
    // запись в её журнале, а сам источник и так назван в тексте дополнения.
    next = relate(next, item.taskId);
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
      what: report.summary,
      links: report.links ?? {},
      decisions: [...(report.decisions ?? []), ...(plan.notes ?? [])],
      problem: halted ? verdict.note : undefined,
      denials,
      denialsNote,
    },
    `chore(backlog): ${task.id} ${task.status} → ${verdict.status}`,
    [asked, answered].filter(Boolean),
  );
  if (!push.ok) return { result: 'failed', why: push.outcome, created, amended };

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

/** Взять задачу в работу: захват, отправка, дерево, реестр, процесс этапа. */
async function startStage(action, io) {
  const task = io.readTask(action.taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет' };

  const claimed = claimTask(task, { machine: io.machine, status: action.stage, now: io.now });
  if (!claimed.task) return { result: 'raced', why: claimed.problems.join('; ') };

  // Захват — ПЕРВОЕ действие над миром, раньше записи и раньше дерева.
  // Проигравшая гонку машина тогда не оставляет за собой ничего: ни следа
  // на доске, ни рабочего дерева, — и убирать ей нечего.
  //
  // Хранилище захватывает по-своему. Доска назначает исполнителя карточке:
  // повторное назначение того же участника Trello отвергает, и это
  // единственная в её распоряжении операция «сравни-и-запиши». Файловому
  // бэклогу отдельный захват не нужен — его роль исполняет отправка записи
  // владельца, которая либо проходит, либо отбивается.
  const held = io.acquire ? await io.acquire(claimed.task) : { ok: true };
  if (!held.ok) {
    if (held.outcome === 'taken') return { result: 'raced', why: held.why };
    return { result: 'failed', why: held.why ?? held.outcome };
  }

  const push = await io.saveTask(
    claimed.task,
    {
      at: io.now,
      from: task.status,
      to: action.stage,
      what: `Взята в работу машиной ${io.machine}.`,
    },
    `chore(backlog): ${task.id} взята в работу (${action.stage})`,
  );

  if (!push.ok) {
    // Что делать дальше, решает не сам факт неудачи, а то, что осталось
    // в мире. Случаев три, и путать их дорого.
    //
    // Прежде здесь на любую неудачу снимался владелец задачи — и это было
    // хуже бездействия. Снятие владельца отменяло только половину захвата:
    // состояние оставалось этапным, и задача выпадала из конвейера вся
    // целиком. Очередь берёт лишь `new`; продолжателя порождают по записи
    // реестра, а её нет — дерево заводится строкой ниже; сверка довела бы
    // захват до конца, но узнаёт свои задачи как раз по владельцу, которого
    // мы только что стёрли. На доске такая задача выглядит идущим этапом,
    // которого никто не делает.
    if (push.outcome === 'conflict') {
      // Задачу занял кто-то другой. Что за собой прибрать, знает хранилище:
      // файловому надо снять неотправленный коммит и вернуть файлы — иначе
      // хвост главной ветки запрёт записи всему конвейеру.
      io.undoSave?.(push, releaseClaim(claimed.task));
      await io.release?.(claimed.task);
      return { result: 'raced', why: 'задачу занял кто-то другой' };
    }

    // Захват состоялся, а запись — нет. У доски это нужно отменить: иначе
    // карточка останется назначенной, но не начатой, и следующий цикл её
    // не возьмёт — назначение он честно сочтёт чужим захватом, и задача
    // повиснет до вмешательства человека.
    //
    // У файлового бэклога наоборот: годный коммит без отправки И ЕСТЬ
    // захват. Работа заявлена, не хватает лишь публикации, и досылка хвоста
    // сделает её ближайшим циклом — трогать его нельзя. Поэтому отпускание
    // спрашивается у хранилища, а не решается здесь.
    await io.release?.(claimed.task);
    return { result: 'failed', why: push.outcome };
  }

  // И только теперь дерево — и только тем этапам, которым оно нужно.
  // Порядок обратный сломал бы восстановление: дерево без захвата следующий
  // цикл принял бы за брошенную работу.
  //
  // Прогон дерева не требует: арену считает чужое железо, а замер мерит уже
  // выложенное. Первый живой прогон завёл три дерева под прогоны — пустые
  // копии репозитория, которые потом пришлось бы убирать.
  const branch = `worktree-${action.taskId}`;
  if (NEEDS_WORKTREE.includes(action.stage)) {
    const tree = io.addWorktree(action.taskId, branch);
    if (!tree.ok) return { result: 'failed', why: `дерево не завелось: ${tree.why}` };
    io.upsertRegistry({
      taskId: action.taskId,
      branch,
      path: tree.path,
      stage: action.stage,
      lastSeenAt: io.now,
    });
  }

  const spawned = io.spawnStage(assignmentFor(action, io, claimed.task, branch));
  if (!spawned.ok) return { result: 'failed', why: `этап не запустился: ${spawned.why}` };
  return { result: 'done', status: action.stage };
}

/**
 * Из чего складывается назначение.
 *
 * Прежде это были слот и выписка задачи рядом с ним — два файла на диске.
 * Они существовали не от хорошей жизни: решал оркестратор, а работала
 * сессия, проснувшаяся по расписанию, и передать что-либо иначе как через
 * диск они не могли. Теперь порождает тот же, кто решает.
 *
 * `sessionId` решает, начинается этап или возобновляется. Идентификатор
 * известен — значит процесс на этом этапе уже был и прервался; тогда
 * сессию возобновляют, и она помнит свой ход мысли. Прежде продолжатель
 * выяснял сделанное тремя командами `git log` и иногда понимал неверно.
 */
function assignmentFor(action, io, task, branchHint) {
  const entry = io.registryEntry(action.taskId);
  const sessionId = io.lastSession?.(action.taskId, action.stage) ?? null;
  return {
    taskId: task.id,
    stage: action.stage,
    branch: entry?.branch ?? branchHint ?? `worktree-${task.id}`,
    path: entry?.path ?? null,
    continuation: Boolean(sessionId),
    sessionId,
    reason: action.reason ?? null,
    // Задача, журнал и опись доски едут вместе с назначением: сессия
    // начинается с чистого листа, и всё, чего здесь нет, для неё
    // не существует. Бэклог открывать ей нельзя — править его она
    // не вправе, а читать устаревшую копию с диска хуже, чем не читать.
    task,
    journal: io.readJournal(action.taskId),
    board: io.boardDigest(),
  };
}

/** Дать этапу сессию: живого процесса на нём нет. */
async function continueStage(action, io) {
  const task = io.readTask(action.taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет' };

  // Этапу, работающему в своём дереве, без дерева работать негде. Прежде
  // это выяснялось внутри сборки запуска, где путь склеивался с `null`
  // и бросал TypeError, — а падение внутри исполнения уносило весь оборот
  // вместе с решениями по всем остальным задачам (31.08.2026).
  //
  // Отказ здесь ничего не теряет: дерево заводит сверка, и следующий же
  // оборот выдаст сессию как ни в чём не бывало.
  if (NEEDS_WORKTREE.includes(task.status) && !io.registryEntry(action.taskId)?.path) {
    return { result: 'failed', why: `дерева у задачи нет: этапу «${task.status}» работать негде` };
  }

  const counted = countContinuation(task);
  const push = await io.saveTask(
    counted,
    {
      at: io.now,
      from: task.status,
      to: task.status,
      what: `Этапу выдана сессия: ${action.reason}.`,
    },
    `chore(backlog): ${task.id} сессия на этап ${task.status}`,
  );
  if (!push.ok) return { result: 'failed', why: push.outcome };

  // Назначение собирается с уже посчитанной задачи: продолжателю важно
  // видеть израсходованные попытки, а не то, сколько их было до него.
  const spawned = io.spawnStage(assignmentFor(action, io, counted));
  if (!spawned.ok) return { result: 'failed', why: `этап не запустился: ${spawned.why}` };
  return { result: 'done', status: task.status };
}

/** Разобрать ответ владельца продукта и вернуть задачу в работу. */
async function answerQuestion(action, io) {
  const task = io.readTask(action.taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет' };
  if (!task.returnTo)
    return { result: 'failed', why: 'некуда возвращать: состояние возврата пусто' };

  const moved = applyTransition(task, {
    status: task.returnTo,
    note: 'получен ответ владельца продукта',
    now: io.now,
  });
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };

  // Вопрос гасится отметкой времени ответа. Без неё следующий вопрос
  // по той же задаче «отвечался» бы старым текстом сам собой: разбор
  // ищет непустой ответ, а прежний ответ никуда не девается — ни
  // из раздела файла, ни из комментариев карточки.
  const answer = action.answer ?? io.readAnswer(action.taskId);
  const next = {
    ...moved.task,
    question: task.question
      ? { ...task.question, answeredAt: io.now }
      : {
          askedAt: task.statusChangedAt,
          summary: 'вопрос задан до появления записи',
          answeredAt: io.now,
        },
  };

  const push = await io.saveTask(
    next,
    {
      at: io.now,
      from: task.status,
      to: task.returnTo,
      what: 'Ответ владельца продукта:',
      decisions: [answer],
    },
    `chore(backlog): ${task.id} получен ответ, возврат в ${task.returnTo}`,
  );
  return push.ok
    ? { result: 'done', status: task.returnTo }
    : { result: 'failed', why: push.outcome };
}

/** Применить внешнее состояние: проверки CI или прогон на чужом железе. */
async function pollExternal(action, io) {
  const task = io.readTask(action.taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет' };

  const external = io.readExternal(task, action.what);
  const verdict = applyExternal(task, external);
  if (verdict.status === task.status) return { result: 'skipped', why: verdict.note };

  const moved = applyTransition(task, { status: verdict.status, note: verdict.note, now: io.now });
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };

  const push = await io.saveTask(
    moved.task,
    { at: io.now, from: task.status, to: verdict.status, what: verdict.note },
    `chore(backlog): ${task.id} ${task.status} → ${verdict.status}`,
  );
  return push.ok
    ? { result: 'done', status: verdict.status }
    : { result: 'failed', why: push.outcome };
}

/**
 * Остановить задачу: продолжения исчерпаны, сама она дальше не двинется.
 *
 * Куда именно — решает `haltOf`: рабочая задача идёт в разбор, а задача,
 * уже стоящая в разборе, — в ошибку. Разбора разбора не бывает.
 */
async function failStage(action, io) {
  const task = io.readTask(action.taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет' };
  return halt(task, action.reason, io);
}

/**
 * Общий ход остановки: перевод, забывание прежнего разбора, запись.
 *
 * Сессия разбора забывается при каждом входе в него. Память о сессиях
 * переживает и этап, и перезапуск супервизора, поэтому задача, однажды
 * разобранная, поднятая человеком и упавшая снова, возобновила бы прошлый
 * разбор — а тот ответил бы из своей памяти «уже разобрала», не читая нового
 * лога. Это в точности та беда, ради которой заведён `forgetSession`.
 *
 * `extra` — то, что остановка обязана унести в журнал вместе с причиной:
 * содержимое отброшенного отчёта и перечень отказанных действий. Терять
 * отчёт молча нельзя, и стоит это правило дороже, чем кажется.
 */
async function halt(task, why, io, extra = {}) {
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

/**
 * Прибрать за завершённой задачей.
 *
 * Удаление — единственное необратимое, что делает конвейер, поэтому решение
 * принимается не здесь, а в отдельном разборе, и только по доказанной
 * влитости pull request.
 */
async function cleanupTask(action, io) {
  const task = io.readTask(action.taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет' };

  const entry = io.registryEntry(action.taskId);
  const verdict = mayCleanup({
    task,
    entry,
    pr: io.readPr(task.links?.pr),
    unpushed: entry ? io.unpushed(entry.branch) : 0,
  });

  if (verdict.verdict === 'wait') return { result: 'skipped', why: verdict.why };

  if (verdict.verdict === 'fail') return halt(task, verdict.why, io);

  if (verdict.verdict === 'proceed') {
    const swept = cleanup({ task, entry, io });
    if (!swept.finished) {
      // Недоделанная уборка — не беда: следующий цикл дочистит. Задача
      // остаётся в уборке, и запись реестра при этом не теряется.
      return { result: 'skipped', why: swept.left.join('; ') };
    }
  }

  const moved = applyTransition(task, { status: 'closed', note: verdict.why, now: io.now });
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };
  const push = await io.saveTask(
    moved.task,
    { at: io.now, from: task.status, to: 'closed', what: `Убрано: ${verdict.why}.` },
    `chore(backlog): ${task.id} закрыта`,
  );
  return push.ok ? { result: 'done', status: 'closed' } : { result: 'failed', why: push.outcome };
}

/**
 * Дослать хвост ветки задачи.
 *
 * Хвост главной ветки досылает цикл ещё до всякого исполнения — там это
 * условие работы. Здесь речь о ветках задач: их досылают из собственного
 * дерева и только ускоряющей отправкой. Неудача не беда: она задерживает
 * действия по одной задаче, а не по всем.
 */
async function pushTail(action, io) {
  if (action.scope !== 'branch') return { result: 'skipped', why: 'хвост главной ветки не здесь' };

  const entry = io.registryEntry(action.taskId);
  if (!entry) return { result: 'skipped', why: 'дерева задачи нет в реестре' };

  const push = io.pushBranchTail(action.branch, entry.path);
  return push.ok
    ? { result: 'done', why: `дослано ${action.commits} коммит(ов)` }
    : { result: 'failed', why: push.why };
}

const HANDLERS = {
  'push-tail': pushTail,
  cleanup: cleanupTask,
  'transfer-report': transferReport,
  'start-stage': startStage,
  'continue-stage': continueStage,
  'answer-question': answerQuestion,
  'poll-external': pollExternal,
  'fail-stage': failStage,
};

/**
 * Исполнить список действий.
 *
 * Действие, которое не удалось, останавливает только себя: остальные
 * продолжают. Исключение — неудача отправки: она означает, что записи
 * в главную ветку больше невозможны, и продолжать бессмысленно.
 */
export async function execute(actions, io) {
  const results = [];

  for (const action of actions) {
    const handler = HANDLERS[action.kind];
    if (!handler) {
      results.push({
        action,
        result: 'skipped',
        why: `действие «${action.kind}» здесь не исполняется`,
      });
      continue;
    }

    const outcome = await handler(action, io);
    results.push({ action, ...outcome });

    if (outcome.result === 'failed' && String(outcome.why ?? '').includes('offline')) {
      results.push({ action: null, result: 'skipped', why: 'записи невозможны: сети нет' });
      break;
    }
  }

  return results;
}
