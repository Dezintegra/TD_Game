import { unblockTask } from './blockers.mjs';
import { changeTokenHold } from './token-hold.mjs';
import { analyzeTokenBudget } from './token-reanalysis.mjs';
import { beginDelayAnalysis, observeDelay, reviewingDelay } from './delay-analysis.mjs';
import { applyExternal } from './apply-report.mjs';
import {
  applyTransition,
  claimTask,
  countApiError,
  countContinuation,
  countSpawnFailure,
  refundContinuation,
  releaseClaim,
  resetAttempts,
} from './task-file.mjs';
import { halt } from './report-plan.mjs';
import { transferReport } from './report-delivery.mjs';
import { NEEDS_WORKTREE } from '../config/transitions.mjs';
import { cleanup, mayCleanup } from './cleanup.mjs';
import { recoverClosureReason } from './closure.mjs';

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

/** Взять задачу в работу: захват, отправка, дерево, реестр, процесс этапа. */
async function startStage(action, io) {
  const task = io.readTask(action.taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет' };

  const claimed = claimTask(task, { machine: io.machine, status: action.stage, now: io.now });
  if (!claimed.task) return { result: 'raced', why: claimed.problems.join('; ') };
  if (task.reanalysis) claimed.task.reanalysis = false;

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

  // Захват и запись «Взята в работу» остаются на месте при любом отказе:
  // задача действительно взята и действительно стоит в этапе. Отменять
  // тут нечего — не хватает лишь сессии, и её выдаст ближайший оборот
  // действием `continue-stage`.
  if (!spawned.ok && spawned.reason === 'busy') {
    return { result: 'skipped', why: `этап не запустился: ${spawned.why}` };
  }

  if (!spawned.ok) {
    // Отдельной записью, а не поверх «Взята в работу»: первая говорит
    // о состоявшемся захвате и остаётся правдой, вторая — о несостоявшемся
    // запуске. Слив их в одну, мы получили бы ту же ложь, ради которой
    // всё и правится.
    await io.saveTask(
      countSpawnFailure(claimed.task),
      {
        at: io.now,
        from: action.stage,
        to: action.stage,
        problem: `Этап не запустился: ${spawned.why}.`,
      },
      `chore(backlog): ${task.id} этап ${action.stage} не запустился`,
    );
    return { result: 'failed', why: `этап не запустился: ${spawned.why}` };
  }

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
 * известен — значит заход ещё не завершён переносом отчёта; тогда
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
    delayDependencies: reviewingDelay(task)
      ? (task.dependsOn ?? []).map((id) => ({
          task: io.readTask(id) ??
            io.dependencyRecords?.().find((item) => item.id === id) ?? { id, missing: true },
          journal: io.readJournal(id),
        }))
      : [],
    // Пакет выкладки: выписки задач, которые сессия выкладывает вместе
    // с ведущей. Перечень фиксируется здесь, в момент выдачи сессии, и это
    // единственный источник правды о составе пакета — доску сессия не откроет,
    // а задача, пришедшая в `deploy` позже, останется ждать следующего.
    batch: action.batch ? action.batch.map((id) => batchDigest(io.readTask(id), id)) : null,
  };
}

/**
 * Что о задаче пакета нужно сессии выкладки: номер pull request, чтобы
 * проверить вливание, имя изменения — чтобы назвать его в журнале.
 * Задачи, которой бэклог уже не знает, выписка не скрывает: сессия обязана
 * назвать её в отчёте исключённой, а не промолчать.
 */
function batchDigest(task, id) {
  if (!task) return { id, title: null, pr: null, change: null, missing: true };
  return {
    id: task.id,
    title: task.title ?? null,
    pr: task.links?.pr ?? null,
    change: task.links?.change ?? null,
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

  // Сперва порождение, и только потом счёт с записью. Порядок обратный —
  // посчитать, записать, а потом порождать — стоил задач 0043, 0062, 0022
  // и 0088: несостоявшийся запуск съедал продолжение наравне с уснувшей
  // сессией, а в журнал задачи уезжала запись «Этапу выдана сессия»,
  // которой не было. Разбор шёл искать причину в сессии, которой не было.
  //
  // Назначение при этом собирается с УЖЕ посчитанной задачи: продолжателю
  // важно видеть израсходованные попытки, а не то, сколько их было до него.
  // В мир это значение уезжает только вместе с родившимся процессом;
  // при отказе оно просто выбрасывается.
  const counted = countContinuation(task);
  const spawned = io.spawnStage(assignmentFor(action, io, counted));

  // Теснота — очередь, а не поломка: ничего не тратит и в журнал задачи
  // не пишется вовсе. При обороте в пять минут и прогоне арены, держащем
  // место десятками минут, такая запись дала бы карточке дюжину одинаковых
  // строк в час, и настоящая беда утонула бы в них. В журнал цикла причина
  // попадает всегда — её называет сам исход действия.
  if (!spawned.ok && spawned.reason === 'busy') {
    return { result: 'skipped', why: `этап не запустился: ${spawned.why}` };
  }

  // А вот несостоявшееся порождение — беда уровня настройки, и молчать
  // о ней нельзя: в журнале цикла она утонет за сутки, а карточка останется
  // единственным местом, где видно, почему задача встала.
  if (!spawned.ok) {
    const failed = countSpawnFailure(task);
    await io.saveTask(
      failed,
      {
        at: io.now,
        from: task.status,
        to: task.status,
        problem: `Этап не запустился: ${spawned.why}.`,
      },
      `chore(backlog): ${task.id} этап ${task.status} не запустился`,
    );
    return { result: 'failed', why: `этап не запустился: ${spawned.why}` };
  }

  // Процесс родился. Удавшееся порождение гасит счёт несостоявшихся
  // запусков: оно доказывает, что машинерия запуска работает, и прежние
  // отказы к делу больше не относятся.
  const started = { ...counted, attempts: { ...counted.attempts, spawnFailures: 0 } };
  const push = await io.saveTask(
    started,
    {
      at: io.now,
      from: task.status,
      to: task.status,
      what: `Этапу выдана сессия: ${action.reason}.`,
    },
    `chore(backlog): ${task.id} сессия на этап ${task.status}`,
  );
  // Процесс при неудаче записи НЕ снимается: он делает работу, ради которой
  // и порождён. Платим одной пропущенной записью журнала и одной несписанной
  // попыткой — то есть задача получит на заход больше положенного. Второго
  // процесса по ней не появится: сканер видит живой прямо.
  if (!push.ok) return { result: 'failed', why: push.outcome };
  return { result: 'done', status: task.status };
}

/**
 * Записать в журнал задачи исход этапа, осиротевшего при смене супервизора.
 *
 * Пишется ЖУРНАЛ, и только он: ни состояния, ни счётчиков, ни положения
 * в очереди запись не меняет. Причина не в осторожности, а в задаче 0070 —
 * два изменения одной задачи в один оборот делаются по одному и тому же
 * снимку доски, и второе затирает первое. А `note-orphan` и `continue-stage`
 * попадают в один оборот по построению: сирота кончился, значит этапу тут же
 * нужна сессия. `amendTask` полей задачи не трогает, и затирать ему нечего.
 */
async function noteOrphan(action, io) {
  const outcome = io.readOrphan?.(action.taskId, action.stage);
  if (!outcome) return { result: 'skipped', why: 'исход осиротевшего этапа уже записан' };

  const written = await io.amendTask(
    action.taskId,
    orphanRecord(outcome),
    `chore(backlog): ${action.taskId} исход осиротевшего этапа ${action.stage}`,
    'supervisor',
  );
  // Исход снимается с очереди — а с ним и дескриптор с диска — только после
  // удавшейся записи. Обрыв оставляет и то и другое на месте, и следующий
  // оборот пробует снова.
  if (!written.ok) return { result: 'failed', why: written.outcome };
  io.forgetOrphan?.(action.taskId, action.stage);
  return { result: 'done' };
}

/** Чем кончился осиротевший процесс — теми словами, какими это видел наблюдатель. */
const ORPHAN_END = {
  gone: 'процесс кончился сам',
  stale: 'номер процесса занял посторонний: снимать его было нельзя',
  killed: 'процесс снят поддеревом по истечении своего срока',
  left: 'опознать процесс не удалось, и он оставлен работать',
};

/**
 * Запись об осиротевшем этапе.
 *
 * Она обязана отвечать на вопрос следующей сессии и разбора: почему заход
 * не дал ничего. Поэтому в ней и номер процесса, и отметка начала — по ним
 * ищут журнал этапа, — и прямо сказанное «отчёт потерян, сделанное ищите
 * в ветке»: коммит в отправленной ветке потерю отчёта переживает.
 */
function orphanRecord(outcome) {
  return (
    `**Этап «${outcome.stage}» осиротел при смене супервизора**\n\n` +
    `Процесс ${outcome.pid}, начатый ${outcome.startedAt}, порождён прежним ` +
    `супервизором и пережил его. ${ORPHAN_END[outcome.outcome] ?? outcome.why}.\n\n` +
    'Отчёт этого захода потерян: он приходит стандартным выводом, а тот был ' +
    'трубой в умерший процесс. Сделанное, если оно было, лежит в ветке задачи — ' +
    'ищите его коммитами, а не по этой записи.\n'
  );
}

/**
 * Записать отказ сервера модели и вернуть задаче потраченное продолжение.
 *
 * В отличие от записи о сироте, здесь правятся и поля задачи: счёт
 * продолжений уменьшается, счёт отказов сервера растёт. Затирания чужой
 * правки это не грозит — сканер не выдаёт такой задаче сессию тем же
 * оборотом именно затем, чтобы двух правок по одному снимку не было.
 *
 * Состояние задачи не меняется и разбор не зовётся: разбирать нечего,
 * работы не было ни на один ход.
 */
async function noteApiError(action, io) {
  const failure = io.readApiFailure?.(action.taskId, action.stage);
  if (!failure) return { result: 'skipped', why: 'отказ сервера уже записан' };

  const task = io.readTask(action.taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет' };

  const counted = countApiError(refundContinuation(task));
  const push = await io.saveTask(
    counted,
    {
      at: io.now,
      from: task.status,
      to: task.status,
      problem: apiErrorRecord(action.stage, failure.why),
    },
    `chore(backlog): ${action.taskId} отказ сервера на этапе ${action.stage}`,
  );
  // Отказ снимается с очереди только после удавшейся записи: обрыв оставляет
  // его на месте, и следующий оборот пробует снова.
  if (!push.ok) return { result: 'failed', why: push.outcome };
  io.forgetApiFailure?.(action.taskId, action.stage);
  return { result: 'done', status: task.status };
}

/**
 * Запись об отказе сервера модели.
 *
 * Она отвечает на вопрос следующей сессии: почему заход не дал ничего
 * и почему счёт попыток не вырос. Без этого разбор пошёл бы искать причину
 * в работе, которой не было.
 */
function apiErrorRecord(stage, why) {
  return (
    `**Этап «${stage}» лёг на отказе сервера модели**\n\n` +
    `${why}. Ходов сессия не сделала, поэтому продолжение, списанное при ` +
    'рождении процесса, задаче возвращено: платить за чужую перегрузку ей ' +
    'нечем и незачем.\n\n' +
    'Состояние задачи не изменилось. Как только сервер ответит, этап пойдёт ' +
    'заново с прежним счётом попыток.\n'
  );
}

/**
 * Отправить разросшуюся задачу на повторный анализ дробности.
 *
 * Не в разбор ошибки: задача не сломана. Разбор читает лог упавшего этапа
 * и ищет поломку, а тут поломки нет — работа выросла, и лог последнего этапа
 * про это не скажет ничего. 04.09.2026 задача 0216 прошла двенадцать этапов
 * за $76,01, расширившись по дороге с проработки на имплементацию.
 *
 * Признак дробления снимается, и без этого весь ход бессмыслен: анализ
 * пропустился бы ровно в том случае, ради которого затеян.
 */
async function decomposeAgain(action, io) {
  const task = io.readTask(action.taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет' };

  const moved = applyTransition(task, {
    status: 'decompose',
    note: action.reason,
    now: io.now,
  });
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };

  const push = await io.saveTask(
    { ...moved.task, decomposed: false },
    {
      at: io.now,
      from: task.status,
      to: 'decompose',
      problem: `${action.reason}. Метка о проведённом дроблении снята: анализ идёт заново.`,
    },
    `chore(backlog): ${task.id} ${task.status} → decompose (предел ресурсов)`,
  );
  return push.ok
    ? { result: 'done', status: 'decompose' }
    : { result: 'failed', why: push.outcome };
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

/**
 * Вернуть из ошибки задачу, упавшую по вине конвейера.
 *
 * Переход тот же, что делает человек мышью, — из `failed` в сохранённое
 * состояние, — и объявлен он был для него. Разница в том, что здесь
 * известно, почему: вердикт разбора и закрытые починки называются
 * в журнале поимённо, чтобы через месяц было видно, чем задачу поднимали.
 *
 * Сессия упавшего этапа забывается. Причина была в конвейере — в правиле,
 * разрешении, коде, — и возобновлённая сессия отвечала бы из памяти
 * о прежних правилах. Новая читает журнал, как всякий новый исполнитель.
 */
async function returnTask(action, io) {
  const task = io.readTask(action.taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет' };
  // Картина могла смениться между решением и исполнением: человек поднял
  // задачу сам либо разбор переписал вердикт. Тогда возвращать нечего.
  if (task.status !== 'failed') return { result: 'skipped', why: 'задача уже не в ошибке' };
  if (task.recovery?.causedBy !== 'pipeline') {
    return { result: 'skipped', why: 'вердикт разбора уже не конвейерный' };
  }
  if (!task.returnTo) {
    return { result: 'failed', why: 'некуда возвращать: состояние возврата пусто' };
  }

  const moved = applyTransition(task, {
    status: task.returnTo,
    note: 'возвращена конвейером: причина была в конвейере и снята',
    now: io.now,
  });
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };

  // Счётчики попыток обнуляются, как при ручном подъёме, а счёт возвратов
  // растёт: он и есть предохранитель, и вердикт снимается — задача снова
  // в работе, и судить о ней будет следующий разбор, если он понадобится.
  const returns = (task.recovery.returns ?? 0) + 1;
  const next = {
    ...resetAttempts(moved.task),
    recovery: { causedBy: null, fixedBy: [], returns },
  };
  io.forgetSession?.(task.id, task.returnTo);

  const fixed = action.fixedBy ?? task.recovery.fixedBy ?? [];
  const limit = io.maxAutoReturns != null ? ` из ${io.maxAutoReturns}` : '';
  const push = await io.saveTask(
    next,
    {
      at: io.now,
      from: task.status,
      to: task.returnTo,
      what:
        'Возвращена в работу конвейером: по разбору причина падения была ' +
        `в конвейере, а не в задаче, ${
          fixed.length > 0 ? `и починки закрыты: ${fixed.join(', ')}` : 'и чинить было нечего'
        }. Возврат ${returns}${limit}; счётчики попыток обнулены, ` +
        `сессия этапа «${task.returnTo}» начнётся заново.`,
    },
    `chore(backlog): ${task.id} возвращена в ${task.returnTo} после починки конвейера`,
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

/**
 * Прибрать за завершённой задачей.
 *
 * Удаление — единственное необратимое, что делает конвейер, поэтому решение
 * принимается не здесь, а в отдельном разборе: по доказанной влитости pull
 * request, а там, где он не заводился вовсе, — по содержимому ветки.
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
    // Содержимое ветки спрашивается только там, где решать по pull request
    // нечем: у обычной задачи это был бы лишний вызов git на каждой уборке.
    ownCommits: entry && !task.links?.pr ? io.ownCommits(entry.branch) : null,
  });

  if (verdict.verdict === 'wait') return { result: 'skipped', why: verdict.why };

  if (verdict.verdict === 'fail') return halt(task, verdict.why, io);

  const closureReason = task.links?.pr
    ? null
    : recoverClosureReason(task, io.readJournal?.(task.id));
  if (!task.links?.pr && !closureReason)
    return {
      result: 'failed',
      why: 'причина закрытия отсутствует: восстановите решение о снятии предмета до уборки',
    };

  if (verdict.verdict === 'proceed') {
    const swept = cleanup({ task, entry, io });
    if (!swept.finished) {
      // Недоделанная уборка — не беда: следующий цикл дочистит. Задача
      // остаётся в уборке, и запись реестра при этом не теряется.
      return { result: 'skipped', why: swept.left.join('; ') };
    }
  }

  const status = task.links?.pr ? 'completed' : 'closed';
  const moved = applyTransition(task, { status, note: verdict.why, now: io.now });
  if (!moved.task) return { result: 'failed', why: moved.problems.join('; ') };
  const push = await io.saveTask(
    closureReason ? { ...moved.task, closureReason } : moved.task,
    {
      at: io.now,
      from: task.status,
      to: status,
      ...(status === 'completed'
        ? { completionSummary: task.completionSummary, links: task.links }
        : {}),
      what: closureReason ? 'Уборка ресурсов задачи завершена.' : `Убрано: ${verdict.why}.`,
      ...(closureReason ? { closureReason } : {}),
    },
    `chore(backlog): ${task.id} ${status}`,
  );
  return push.ok ? { result: 'done', status } : { result: 'failed', why: push.outcome };
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

/**
 * Унести негодную карточку в карантин.
 *
 * Задачи в бэклоге у неё нет — она и негодна как раз потому, что задачей
 * не читается. Поэтому здесь нет ни `readTask`, ни перехода состояния:
 * действие целиком на стороне хранилища, и адресуется карточка тем именем,
 * под которым её увидело чтение.
 *
 * Карантина у файлового бэклога нет и не будет: там негодную запись
 * отбивает JSON Schema, а «перенести» её значило бы переписать файл,
 * который схему не прошёл. Отсутствие метода — пропуск с причиной,
 * а не падение.
 */
async function quarantineCard(action, io) {
  if (!io.quarantineCard) {
    return { result: 'skipped', why: 'карантин негодных карточек умеет только доска' };
  }

  const done = await io.quarantineCard(action.taskId, {
    problems: action.problems ?? [],
    returnTo: action.returnTo ?? 'new',
  });
  return done.ok ? { result: 'done', status: 'failed' } : { result: 'failed', why: done.why };
}

/** Снять метку с исправленной карточки. */
async function clearCard(action, io) {
  if (!io.clearCard) {
    return { result: 'skipped', why: 'метки живут только на доске' };
  }

  const done = await io.clearCard(action.taskId);
  return done.ok ? { result: 'done' } : { result: 'failed', why: done.why };
}

const HANDLERS = {
  'hold-token-budget': changeTokenHold,
  'refresh-token-budget': changeTokenHold,
  'resume-token-budget': changeTokenHold,
  'analyze-delay': beginDelayAnalysis,
  'observe-delay': observeDelay,
  'flush-delay-journal': async (action, io) => {
    const task = io.readTask(action.taskId);
    if (!task?.delayJournal || !io.flushDelayJournal) return { result: 'skipped' };
    const saved = await io.flushDelayJournal(task);
    return saved.ok ? { result: 'done' } : { result: 'failed', why: saved.why ?? saved.outcome };
  },
  'unblock-task': unblockTask,
  'push-tail': pushTail,
  'quarantine-card': quarantineCard,
  'clear-card': clearCard,
  cleanup: cleanupTask,
  'transfer-report': transferReport,
  'start-stage': startStage,
  'note-orphan': noteOrphan,
  'note-api-error': noteApiError,
  'decompose-again': decomposeAgain,
  'analyze-token-budget': analyzeTokenBudget,
  'continue-stage': continueStage,
  'answer-question': answerQuestion,
  'return-task': returnTask,
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
    if (io.reportStorageBlocked?.()) {
      results.push({ action, result: 'failed', why: 'report storage blocks scheduling' });
      break;
    }
    if (
      action.kind !== 'transfer-report' &&
      // Хвост завершённого этапа должен уйти до переноса его отчёта.
      action.kind !== 'push-tail' &&
      io.reportStore
        ?.entries()
        .some(
          (entry) => entry.taskId === action.taskId || entry.report.batch?.includes(action.taskId),
        )
    ) {
      results.push({ action, result: 'skipped', why: 'pending report owns this task' });
      continue;
    }
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
