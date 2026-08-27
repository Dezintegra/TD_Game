/**
 * Уборка после успешно завершённой задачи.
 *
 * Единственное место конвейера, которое удаляет. Поэтому здесь всё построено
 * вокруг одного вопроса: доказано ли, что удалять безопасно. Не «похоже, что
 * влито», не «задача же закрыта», а именно доказано.
 *
 * Доказательством служит состояние pull request, а не достижимость коммитов.
 * При вливании со сжатием и с перевыкладкой хеши не сохраняются, и сравнение
 * коммитов заперло бы уборку навсегда: ветка была бы вечно «неотправленной»
 * при том, что работа давно в главной ветке.
 */

/** Что уборка решила делать. */
export const VERDICTS = {
  proceed: 'убирать можно',
  wait: 'подождать: причина временная',
  fail: 'остановить задачу: нужен человек',
  skip: 'убирать нечего',
};

/**
 * Можно ли убирать за задачей.
 *
 * @param {object} params
 * @param {object} params.task       запись бэклога
 * @param {object|null} params.entry запись реестра, если дерево заведено
 * @param {object} params.pr         состояние pull request: `{ state }`
 * @param {number|null} params.unpushed сколько коммитов ветки нет в удалённой
 * @returns {{ verdict: string, why: string }}
 */
export function mayCleanup({ task, entry, pr, unpushed }) {
  if (!entry) {
    return { verdict: 'skip', why: 'дерева нет, убирать нечего' };
  }

  if (!task.links?.pr) {
    // Задача дошла до уборки без pull request — значит, маршрут нарушен.
    // Молча снести дерево тут нельзя: в нём может лежать несделанная работа.
    return { verdict: 'fail', why: 'задача дошла до уборки без pull request' };
  }

  if (pr?.state === 'unknown') {
    return { verdict: 'wait', why: 'состояние pull request недоступно' };
  }

  if (pr?.state !== 'merged') {
    return {
      verdict: 'fail',
      why: `pull request не влит (${pr?.state ?? 'состояние неизвестно'}), ветку не удаляем`,
    };
  }

  // Влитость доказана. Неотправленные коммиты после вливания со сжатием —
  // обычное дело: хеши не сохраняются, и в удалённой ветке их нет поимённо.
  if (unpushed && unpushed > 0) {
    return {
      verdict: 'proceed',
      why: `влито (${unpushed} коммит(ов) не совпали по хешу — обычное дело при сжатии)`,
    };
  }

  return { verdict: 'proceed', why: 'pull request влит' };
}

/**
 * Прибрать за задачей.
 *
 * Уборка идемпотентна намеренно: под Windows удаление дерева порой отказывает,
 * сняв при этом регистрацию, а каталог может удерживать чужой процесс. Поэтому
 * каждый шаг проверяет, не сделан ли он уже, а недоделанная уборка не считается
 * ошибкой — она доводится на следующем цикле.
 */
export function cleanup({ task, entry, io }) {
  const done = [];
  const left = [];

  const tree = io.removeWorktree(entry.path);
  if (tree.ok) done.push('дерево удалено');
  else left.push(`дерево осталось: ${tree.why}`);

  const local = io.deleteBranch(entry.branch);
  if (local.ok) done.push('локальная ветка удалена');
  else left.push(`локальная ветка осталась: ${local.why}`);

  const remote = io.deleteRemoteBranch(entry.branch);
  if (remote.ok) done.push('удалённая ветка удалена');
  else left.push(`удалённая ветка осталась: ${remote.why}`);

  // Запись реестра снимается только когда следов не осталось. Иначе следующий
  // цикл не найдёт, что дочищать: дерево есть, а сведений о нём нет.
  if (left.length === 0) {
    io.dropRegistry(task.id);
    done.push('запись реестра снята');
  }

  return { finished: left.length === 0, done, left };
}
