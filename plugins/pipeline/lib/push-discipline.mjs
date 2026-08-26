/**
 * Дисциплина отправки: хвостов не остаётся.
 *
 * Каждый коммит уезжает сразу после создания. Неотправленный коммит — это
 * не отложенная работа, а хвост: рабочие деревья ответвляются от удалённой
 * ветки, проверки CI запускаются на отправку, влитость сверяется с удалённой
 * веткой. Всё, что лежит локально, для остальной машинерии не существует.
 *
 * Три отказа лечатся по-разному, и смешивать их нельзя:
 *
 * - сети нет — отказ временный, цикл прекращает записи вовсе, чтобы хвост
 *   не рос на ровном месте, и пробует на следующем пробуждении;
 * - кто-то успел раньше — перевыкладка поверх свежего состояния и повтор;
 * - перевыкладка упёрлась в конфликт — отмена целиком и остановка цикла:
 *   разрешать конфликт в общей истории самостоятельно нельзя.
 *
 * Принудительной отправки нет ни при каком числе неудач: история главной
 * ветки общая, и переписывание её уносит чужую работу молча.
 */

/** Исходы попытки отправить. */
export const OUTCOMES = {
  pushed: 'отправлено',
  offline: 'удалённый репозиторий недоступен',
  conflict: 'перевыкладка упёрлась в конфликт',
  dirty: 'в дереве посторонние изменения',
  busy: 'идёт незавершённая операция слияния или перевыкладки',
  foreign: 'в хвосте чужие коммиты',
  exhausted: 'повторы исчерпаны',
  failed: 'отправка не удалась',
};

/**
 * Отправить главную ветку, разбираясь с отказами.
 *
 * @param {object} params
 * @param {object} params.git      набор команд из createGit
 * @param {number} params.maxRetries сколько раз перевыкладывать и пробовать снова
 * @param {number} params.budgetSeconds сколько всего отпущено на отправку
 * @param {() => number} params.elapsed сколько секунд уже потрачено
 * @param {string} params.branch   какую ветку отправляем
 * @returns {{ outcome: string, attempts: number, notes: string[] }}
 */
export function pushMain({ git, maxRetries = 3, budgetSeconds = 120, elapsed, branch }) {
  const notes = [];
  let attempts = 0;

  for (;;) {
    if (elapsed() > budgetSeconds) {
      notes.push(`бюджет отправки ${budgetSeconds} с исчерпан`);
      return { outcome: 'exhausted', attempts, notes };
    }

    attempts += 1;
    const result = git.push(branch);
    if (result.ok) return { outcome: 'pushed', attempts, notes };

    if (result.failure === 'offline') {
      notes.push('сети нет: записи откладываются до следующего пробуждения');
      return { outcome: 'offline', attempts, notes };
    }

    if (result.failure !== 'rejected') {
      notes.push('отправка не удалась по неизвестной причине');
      return { outcome: 'failed', attempts, notes };
    }

    if (attempts > maxRetries) {
      notes.push(`повторы исчерпаны: ${attempts - 1} перевыкладок подряд не помогли`);
      return { outcome: 'exhausted', attempts, notes };
    }

    // Кто-то успел раньше. Перевыкладка возможна только в чистом дереве:
    // основное дерево общее для всех сессий и бывает грязным законно.
    if (git.operationInProgress()) {
      notes.push('в дереве идёт незавершённая операция — не вмешиваемся');
      return { outcome: 'busy', attempts, notes };
    }

    const dirty = git.dirtyPaths();
    if (dirty === null || dirty.length > 0) {
      notes.push(`посторонние изменения мешают перевыкладке: ${(dirty ?? []).join(', ')}`);
      return { outcome: 'dirty', attempts, notes };
    }

    const fetched = git.fetch(branch);
    if (!fetched.ok) {
      notes.push('не удалось подтянуть свежее состояние');
      return { outcome: fetched.failure === 'offline' ? 'offline' : 'failed', attempts, notes };
    }

    const rebase = git.rebaseOntoRemote(branch);
    if (!rebase.ok) {
      if (rebase.conflict) {
        git.rebaseAbort();
        notes.push('перевыкладка отменена целиком, конфликт разрешает человек');
        return { outcome: 'conflict', attempts, notes };
      }
      notes.push('перевыкладка не удалась');
      return { outcome: 'failed', attempts, notes };
    }

    notes.push('перевыложились поверх свежего состояния, пробуем снова');
  }
}

/**
 * Разобраться с хвостом главной ветки, найденным при сверке.
 *
 * Чужой хвост конвейер не отправляет: опубликовать чужой черновик он
 * не вправе. Но и заводить деревья поверх него нельзя — они ответвляются
 * от удалённой ветки и вышли бы без этих коммитов. Поэтому чужой хвост
 * останавливает записи и называется вслух.
 */
export function handleTail({ git, branch, ourAuthors, ...pushParams }) {
  const tail = git.tail(branch);
  if (tail === null) return { outcome: 'failed', notes: ['не удалось посчитать хвост'] };
  if (tail === 0) return { outcome: 'clean', notes: [] };

  const authors = git.tailAuthors(branch);
  const foreign = authors.filter((author) => !ourAuthors.includes(author));
  if (foreign.length > 0) {
    return {
      outcome: 'foreign',
      notes: [
        `в хвосте ${tail} коммит(ов), из них чужих от: ${[...new Set(foreign)].join(', ')}. ` +
          'Не отправляем и не заводим деревьев, пока не разберётся человек',
      ],
    };
  }

  return pushMain({ git, branch, ...pushParams });
}

/**
 * Сторож завершения цикла: в главной ветке не должно остаться коммитов,
 * которых нет в удалённой.
 *
 * Условие одностороннее намеренно. Отставание хвостом не является: конвейер
 * сам вливает pull request, поэтому отставание возникает штатно и лечится
 * подтягиванием на следующем пробуждении.
 */
export function cycleMayFinish(git, branch) {
  const fetched = git.fetch(branch);
  if (!fetched.ok) {
    return { ok: false, why: 'не удалось свериться с удалённой веткой' };
  }
  const tail = git.tail(branch);
  if (tail === null) return { ok: false, why: 'не удалось посчитать хвост' };
  if (tail > 0)
    return { ok: false, why: `в главной ветке осталось ${tail} неотправленных коммитов` };
  return { ok: true, why: 'хвостов нет' };
}
