import { applyExternal, applyReport } from './apply-report.mjs';
import {
  applyTransition,
  claimTask,
  countContinuation,
  linkArtifact,
  relate,
  releaseClaim,
  resetAttempts,
} from './task-file.mjs';
import { planRequests } from './requests.mjs';
import { NEEDS_WORKTREE } from '../config/transitions.mjs';
import { cleanup, mayCleanup } from './cleanup.mjs';

/**
 * Исполнение решений сканера.
 *
 * Всё, что трогает мир, собрано здесь и делается через доводом переданный
 * набор действий: чтение и сохранение задачи, заведение дерева, запись
 * в слот. Поэтому порядок шагов проверяется без единого настоящего коммита.
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

/** Перенести отчёт сессии в бэклог. */
async function transferReport(action, io) {
  const task = io.readTask(action.taskId);
  const report = io.readReport(action.taskId, action.stage);
  if (!task || !report) return { result: 'skipped', why: 'задачи или отчёта нет' };

  const verdict = applyReport(task, report);
  const moved = applyTransition(task, { status: verdict.status, note: verdict.note, now: io.now });
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };

  // Дошедший до конца этап обнуляет счётчики: прошлые заминки больше не в счёт,
  // иначе задача упрётся в предел там, где всё было хорошо.
  let next = verdict.status === 'failed' ? moved.task : resetAttempts(moved.task);

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
  });
  for (const bad of plan.rejected) {
    // Негодная заявка не отменяет остального: остальные заводятся, а эта
    // остаётся в журнале с причиной, по которой её не приняли.
    plan.notes = [...(plan.notes ?? []), `заявка отклонена: ${bad.problems.join('; ')}`];
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
      problem: verdict.status === 'failed' ? verdict.note : undefined,
    },
    `chore(backlog): ${task.id} ${task.status} → ${verdict.status}`,
    [asked, answered].filter(Boolean),
  );
  if (!push.ok) return { result: 'failed', why: push.outcome, created };

  // Отчёт и слот освобождаются только после удавшейся отправки: иначе
  // при неудаче этап пришлось бы проходить заново, потеряв уже сделанное.
  io.removeReport(action.taskId, action.stage);
  if (action.slot) io.clearSlot(action.slot);
  return { result: 'done', status: verdict.status, created, rejected: plan.rejected };
}

/** Взять задачу в работу: захват, отправка, дерево, реестр, слот. */
async function startStage(action, io) {
  // Без слота задачу не берут. Сканер называет всё, что созрело, а раскладка
  // решает, что из этого поместится: слотов может быть меньше, чем работы.
  // Первый живой прогон захватил все восемь прогонов при двух слотах — потому
  // что исполнение шло по действиям сканера, минуя раскладку.
  if (!action.slot) {
    return { result: 'skipped', why: 'свободного слота нет, задача ждёт своей очереди' };
  }

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
  if (NEEDS_WORKTREE.includes(action.stage)) {
    const tree = io.addWorktree(action.taskId, action.branch);
    if (!tree.ok) return { result: 'failed', why: `дерево не завелось: ${tree.why}` };
    io.upsertRegistry({
      taskId: action.taskId,
      branch: action.branch,
      path: tree.path,
      stage: action.stage,
      sessionTitle: action.sessionTitle,
      lastSeenAt: io.now,
    });
  }

  if (action.slot) io.writeSlot(action.slot, action.assignment);
  return { result: 'done', status: action.stage };
}

/** Подхватить этап за уснувшей сессией. */
async function continueStage(action, io) {
  // Без слота продолжателя не порождают — ровно как и не берут задачу
  // в работу. Раскладка отказывает, когда прежнее назначение ещё не взято
  // исполнителем, и списать за это попытку было бы вдвойне несправедливо:
  // сессии не было, а счётчик вырос. Их всего две, и после второй задача
  // встаёт и ждёт человека.
  if (!action.slot) {
    return { result: 'skipped', why: 'свободного слота нет, продолжение откладывается' };
  }

  const task = io.readTask(action.taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет' };

  const counted = countContinuation(task);
  const push = await io.saveTask(
    counted,
    {
      at: io.now,
      from: task.status,
      to: task.status,
      what: `Сессия остановилась: ${action.reason}. Этап продолжает новая сессия на том же дереве.`,
    },
    `chore(backlog): ${task.id} продолжение этапа ${task.status}`,
  );
  if (!push.ok) return { result: 'failed', why: push.outcome };

  if (action.slot) io.writeSlot(action.slot, action.assignment);
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

/** Остановить задачу: продолжения исчерпаны, дальше нужен человек. */
async function failStage(action, io) {
  const task = io.readTask(action.taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет' };

  const moved = applyTransition(task, { status: 'failed', note: action.reason, now: io.now });
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };

  const push = await io.saveTask(
    moved.task,
    { at: io.now, from: task.status, to: 'failed', problem: action.reason },
    `chore(backlog): ${task.id} остановлена, нужен разбор`,
  );
  if (action.slot) io.clearSlot(action.slot);
  return push.ok ? { result: 'done', status: 'failed' } : { result: 'failed', why: push.outcome };
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

  if (verdict.verdict === 'fail') {
    const moved = applyTransition(task, { status: 'failed', note: verdict.why, now: io.now });
    if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };
    const push = await io.saveTask(
      moved.task,
      { at: io.now, from: task.status, to: 'failed', problem: verdict.why },
      `chore(backlog): ${task.id} уборка отменена, нужен разбор`,
    );
    return push.ok ? { result: 'done', status: 'failed' } : { result: 'failed', why: push.outcome };
  }

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
