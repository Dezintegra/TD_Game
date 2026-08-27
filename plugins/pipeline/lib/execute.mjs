import { applyExternal, applyReport } from './apply-report.mjs';
import {
  applyTransition,
  claimTask,
  countContinuation,
  releaseClaim,
  resetAttempts,
} from './task-file.mjs';
import { cleanup, mayCleanup } from './cleanup.mjs';
import { journalAppendix } from './journal.mjs';

/**
 * Исполнение решений сканера.
 *
 * Всё, что трогает мир, собрано здесь и делается через доводом переданный
 * набор действий: чтение и запись задачи, дозапись журнала, коммит с
 * немедленной отправкой, заведение дерева, запись в слот. Поэтому порядок
 * шагов проверяется без единого настоящего коммита.
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

/** Записать задачу и журнал одним коммитом и сразу отправить. */
function commitTaskChange(io, task, entry, message) {
  const appendix = journalAppendix(task, io.readJournal(task.id), entry);
  io.writeTask(task);
  io.appendJournal(task.id, appendix);
  return io.commitAndPush([io.taskPath(task.id), io.journalPath(task.id)], message);
}

/** Перенести отчёт сессии в бэклог. */
function transferReport(action, io) {
  const task = io.readTask(action.taskId);
  const report = io.readReport(action.taskId, action.stage);
  if (!task || !report) return { result: 'skipped', why: 'задачи или отчёта нет' };

  const verdict = applyReport(task, report);
  const moved = applyTransition(task, { status: verdict.status, note: verdict.note, now: io.now });
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };

  // Дошедший до конца этап обнуляет счётчики: прошлые заминки больше не в счёт,
  // иначе задача упрётся в предел там, где всё было хорошо.
  const next = verdict.status === 'failed' ? moved.task : resetAttempts(moved.task);

  const push = commitTaskChange(
    io,
    next,
    {
      at: io.now,
      from: task.status,
      to: verdict.status,
      what: report.summary,
      decisions: report.decisions ?? [],
      links: report.links ?? {},
      problem: verdict.status === 'failed' ? verdict.note : undefined,
    },
    `chore(backlog): ${task.id} ${task.status} → ${verdict.status}`,
  );
  if (!push.ok) return { result: 'failed', why: push.outcome };

  // Отчёт и слот освобождаются только после удавшейся отправки: иначе
  // при неудаче этап пришлось бы проходить заново, потеряв уже сделанное.
  io.removeReport(action.taskId, action.stage);
  if (action.slot) io.clearSlot(action.slot);
  return { result: 'done', status: verdict.status };
}

/** Взять задачу в работу: захват, отправка, дерево, реестр, слот. */
function startStage(action, io) {
  const task = io.readTask(action.taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет' };

  const claimed = claimTask(task, { machine: io.machine, status: action.stage, now: io.now });
  if (!claimed.task) return { result: 'raced', why: claimed.problems.join('; ') };

  const push = commitTaskChange(
    io,
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
    // Отказ мог случиться и из-за гонки за задачу. Кто занял её — видно
    // только после перечитывания, и делает это вызывающий: здесь мы лишь
    // снимаем свой захват, чтобы не оставить чужую задачу помеченной собой.
    io.writeTask(releaseClaim(claimed.task));
    return { result: push.outcome === 'raced' ? 'raced' : 'failed', why: push.outcome };
  }

  // И только теперь дерево. Порядок обратный сломал бы восстановление:
  // дерево без захвата следующий цикл принял бы за брошенную работу.
  if (action.needsWorktree !== false) {
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
function continueStage(action, io) {
  const task = io.readTask(action.taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет' };

  const counted = countContinuation(task);
  const push = commitTaskChange(
    io,
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
function answerQuestion(action, io) {
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

  const push = commitTaskChange(
    io,
    moved.task,
    {
      at: io.now,
      from: task.status,
      to: task.returnTo,
      what: 'Ответ владельца продукта:',
      decisions: [action.answer ?? io.readAnswer(action.taskId)],
    },
    `chore(backlog): ${task.id} получен ответ, возврат в ${task.returnTo}`,
  );
  return push.ok
    ? { result: 'done', status: task.returnTo }
    : { result: 'failed', why: push.outcome };
}

/** Применить внешнее состояние: проверки CI или прогон на чужом железе. */
function pollExternal(action, io) {
  const task = io.readTask(action.taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет' };

  const external = io.readExternal(task, action.what);
  const verdict = applyExternal(task, external);
  if (verdict.status === task.status) return { result: 'skipped', why: verdict.note };

  const moved = applyTransition(task, { status: verdict.status, note: verdict.note, now: io.now });
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };

  const push = commitTaskChange(
    io,
    moved.task,
    { at: io.now, from: task.status, to: verdict.status, what: verdict.note },
    `chore(backlog): ${task.id} ${task.status} → ${verdict.status}`,
  );
  return push.ok
    ? { result: 'done', status: verdict.status }
    : { result: 'failed', why: push.outcome };
}

/** Остановить задачу: продолжения исчерпаны, дальше нужен человек. */
function failStage(action, io) {
  const task = io.readTask(action.taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет' };

  const moved = applyTransition(task, { status: 'failed', note: action.reason, now: io.now });
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };

  const push = commitTaskChange(
    io,
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
function cleanupTask(action, io) {
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
    const push = commitTaskChange(
      io,
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
  const push = commitTaskChange(
    io,
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
function pushTail(action, io) {
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
export function execute(actions, io) {
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

    const outcome = handler(action, io);
    results.push({ action, ...outcome });

    if (outcome.result === 'failed' && String(outcome.why ?? '').includes('offline')) {
      results.push({ action: null, result: 'skipped', why: 'записи невозможны: сети нет' });
      break;
    }
  }

  return results;
}
