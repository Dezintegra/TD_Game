/**
 * Обёртка над git для конвейера.
 *
 * Сюда собраны ровно те команды, которыми работает оркестратор, и ни одной
 * лишней. Исполнитель команд приходит доводом: в бою это запуск процесса,
 * в проверках — подставной. Так вся дисциплина отправки проверяется, ни разу
 * не тронув настоящий репозиторий.
 *
 * Ни одна команда здесь не переписывает общую историю: принудительной
 * отправки в главную ветку нет и быть не может. Ни одна не трогает чужих
 * правок: прятания, отката и сброса тоже нет.
 */

/** Отказ отправки, разобранный по смыслу: лечатся они по-разному. */
export function classifyPushFailure(text = '') {
  const lower = text.toLowerCase();

  // Кто-то успел раньше. Лечится перевыкладкой поверх свежего состояния.
  if (
    lower.includes('non-fast-forward') ||
    lower.includes('fetch first') ||
    (lower.includes('[rejected]') && lower.includes('behind'))
  ) {
    return 'rejected';
  }

  // Сети нет. Отказ временный: коммитов в этом цикле не делаем вовсе,
  // чтобы хвост не рос, и пробуем на следующем.
  if (
    lower.includes('could not resolve host') ||
    lower.includes('unable to access') ||
    lower.includes('connection timed out') ||
    lower.includes('connection refused') ||
    lower.includes('network is unreachable') ||
    lower.includes('operation timed out')
  ) {
    return 'offline';
  }

  return 'other';
}

/** Остановилась ли перевыкладка на конфликте. */
export function isRebaseConflict(text = '') {
  const lower = text.toLowerCase();
  return lower.includes('conflict') || lower.includes('could not apply');
}

/**
 * Собрать набор команд поверх исполнителя.
 *
 * @param {(args: string[]) => {code:number, stdout:string, stderr:string}} run
 * @param {{remote: string, mainBranch: string}} config
 */
export function createGit(run, { remote, mainBranch }) {
  const out = (result) => (result.stdout ?? '').trim();

  return {
    /** Подтянуть свежее состояние удалённой ветки, ничего не меняя в дереве. */
    fetch(branch = mainBranch) {
      const result = run(['fetch', remote, branch]);
      return { ok: result.code === 0, failure: classifyPushFailure(result.stderr) };
    },

    /**
     * Сколько коммитов есть локально и нет в удалённой ветке.
     *
     * Это и есть определение хвоста. Отставание считается отдельно и хвостом
     * не является: конвейер сам вливает pull request, поэтому отставание
     * возникает штатно.
     */
    tail(branch = mainBranch) {
      const result = run(['rev-list', '--count', `${remote}/${branch}..${branch}`]);
      if (result.code !== 0) return null;
      return Number.parseInt(out(result), 10) || 0;
    },

    /** Посторонние изменения в дереве. Пустой перечень — дерево чистое. */
    dirtyPaths() {
      const result = run(['status', '--porcelain']);
      if (result.code !== 0) return null;
      // Обрезать пробелы у всего вывода нельзя: первые три позиции строки
      // значащие, и путь потерял бы первую букву. Режем построчно и только
      // с конца.
      return (result.stdout ?? '')
        .split('\n')
        .map((line) => line.replace(/\s+$/, ''))
        .filter((line) => line.length > 3)
        .map((line) => line.slice(3));
    },

    /**
     * Идёт ли незавершённая операция: слияние, перевыкладка, чужой замок.
     *
     * Начинать перевыкладку поверх такого нельзя, а бросать её на полпути —
     * тем более: основное дерево общее для всех сессий.
     */
    operationInProgress() {
      // Обе ссылки существуют только посреди незавершённой операции:
      // `--verify --quiet` отвечает отказом, когда ссылки нет.
      const merge = run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
      const rebase = run(['rev-parse', '--verify', '--quiet', 'REBASE_HEAD']);
      return merge.code === 0 || rebase.code === 0;
    },

    /**
     * Закоммитить свои пути явным перечнем.
     *
     * Захват всего изменённого разом запрещён: он опубликовал бы чужую
     * незавершённую работу немедленно, без окна на замечание.
     */
    commit(paths, messageFile) {
      const added = run(['add', '--', ...paths]);
      if (added.code !== 0) return { ok: false, why: added.stderr };
      const committed = run(['commit', '-F', messageFile]);
      return { ok: committed.code === 0, why: committed.stderr };
    },

    /** Отправить ветку. Принудительной отправки здесь нет намеренно. */
    push(branch = mainBranch) {
      const result = run(['push', remote, branch]);
      if (result.code === 0) return { ok: true, failure: null };
      return { ok: false, failure: classifyPushFailure(`${result.stderr}\n${result.stdout}`) };
    },

    /** Перевыложить свои коммиты поверх свежего состояния удалённой ветки. */
    rebaseOntoRemote(branch = mainBranch) {
      const result = run(['rebase', `${remote}/${branch}`]);
      if (result.code === 0) return { ok: true, conflict: false };
      return {
        ok: false,
        conflict: isRebaseConflict(`${result.stdout}\n${result.stderr}`),
      };
    },

    /** Отменить перевыкладку целиком, вернув дерево к прежнему состоянию. */
    rebaseAbort() {
      return run(['rebase', '--abort']).code === 0;
    },

    /** Кто написал последние коммиты хвоста: свои или чужие. */
    tailAuthors(branch = mainBranch) {
      const result = run(['log', '--format=%an', `${remote}/${branch}..${branch}`]);
      if (result.code !== 0) return [];
      return out(result).split('\n').filter(Boolean);
    },

    /** Снять свой последний коммит, не трогая рабочее дерево. */
    dropLastCommit() {
      return run(['reset', '--soft', 'HEAD~1']).code === 0;
    },
  };
}
