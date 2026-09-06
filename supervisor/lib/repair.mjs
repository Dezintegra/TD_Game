/**
 * Исполнение починок, найденных сверкой.
 *
 * Сверка сравнивает три картины мира — бэклог, реестр деревьев и деревья
 * на диске — и называет расхождения. Считала она их с самого начала, а вот
 * исполнял их до сих пор никто: цикл складывал `repairs` в вывод, считал
 * их работой и на этом успокаивался. Найдено сплошным разбором 27.08.2026,
 * подтверждено чтением: во всём сценарии `repair.repairs` встречается
 * только в счётчике работы, в журнале и в печати.
 *
 * Дороже всего обходилась непроведённая `finish-claim`. Захват задачи —
 * это две вещи подряд: отправленный коммит с владельцем и заведённое
 * дерево. Обрыв между ними оставляет задачу занятой, но безместной, и
 * достать её оттуда умеет только эта починка.
 *
 * Удаление здесь не исполняется никогда. Дерево — это чья-то работа, и
 * сверка про него говорит `report-orphan`, то есть «назови человеку».
 * Снести дерево вправе только этап уборки и только по доказанному
 * вливанию pull request.
 */

/** Что случилось с починкой. */
export const REPAIR_RESULT = {
  done: 'сделано',
  reported: 'названо человеку',
  skipped: 'нечего делать',
  failed: 'не удалось',
};

/** Завести запись реестра по задаче и её дереву. */
function register(io, { taskId, branch, path }) {
  const task = io.readTask(taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет в бэклоге' };

  // Путь берётся в форме реестра, а не той, в какой его принесла сверка:
  // из `git worktree list` он приходит абсолютным, а запуск этапа склеивает
  // путь с корнем. Хранилище без такого метода (подделки в тестах) оставляет
  // путь как есть.
  const stored = io.worktreePathFor?.(taskId) ?? path;

  io.upsertRegistry({
    taskId,
    branch,
    path: stored,
    stage: task.status,
    sessionTitle: `pipeline:${taskId}:${task.status}`,
    lastSeenAt: io.now,
  });
  return { result: 'done', why: 'дерево занесено в реестр' };
}

/**
 * Довести захват до конца: завести дерево и занести его в реестр.
 *
 * Слот здесь намеренно не пишется. Назначение выдаёт раскладка, и выдаст
 * она его сама — задача стоит в этапе, которому нужна сессия, а сессии
 * у неё нет, значит ближайшая сверка живости назначит продолжателя.
 * Написать назначение отсюда значило бы выдать работу мимо квоты.
 */
function finishClaim(io, item) {
  const tree = io.addWorktree(item.taskId, item.branch);
  if (!tree.ok) return { result: 'failed', why: `дерево не завелось: ${tree.why}` };
  return register(io, { ...item, path: tree.path });
}

const HANDLERS = {
  'report-orphan': () => ({ result: 'reported', why: 'находка названа, решает человек' }),
  'adopt-worktree': (io, item) => register(io, item),
  'drop-entry': (io, item) => {
    io.dropRegistry(item.taskId);
    return { result: 'done', why: 'запись снята: дерева нет на диске' };
  },
  'finish-claim': (io, item) => finishClaim(io, item),
};

/**
 * Исполнить перечень починок.
 *
 * Неудача одной не останавливает остальные: расхождения независимы, и
 * общего у них только то, что все они найдены одной сверкой.
 */
export function repairWorld(repairs, io) {
  return (repairs ?? []).map((item) => {
    const handler = HANDLERS[item.kind];
    if (!handler) {
      return { ...item, result: 'skipped', why: `починка «${item.kind}» здесь не исполняется` };
    }
    return { ...item, ...handler(io, item) };
  });
}
