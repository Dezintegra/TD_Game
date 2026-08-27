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
 * Чем кончилась попытка захвата.
 *
 * Успехом считается СОЗДАНИЕ ссылки, а не код возврата. Разница
 * принципиальная: git отвечает успехом и тогда, когда делать было нечего,
 * — и такой ответ означает, что ссылку создал кто-то другой.
 *
 * Проверено пробой. Две машины ответвляются от одного `origin/main`,
 * то есть стоят на одном коммите. Отправка ветки или простого тега у второй
 * машины отвечает «Everything up-to-date» с кодом ноль: ссылка уже
 * указывает куда надо. Обе машины сочли бы задачу своей, завели бы
 * по рабочему дереву и открыли бы по pull request.
 *
 * Спасает аннотированный тег: в него входят имя создателя и время, поэтому
 * объекты у машин разные, и второй отвергается с «already exists».
 */
export function classifyClaim({ code, stdout = '', stderr = '' }) {
  const text = `${stdout}\n${stderr}`;
  const lower = text.toLowerCase();

  if (lower.includes('already exists')) return 'taken';
  if (lower.includes('everything up-to-date')) return 'taken';

  if (code === 0 && lower.includes('[new tag]')) return 'ours';
  if (code === 0) return 'unclear';

  return classifyPushFailure(text) === 'offline' ? 'offline' : 'failed';
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

    /**
     * На сколько коммитов локальная ветка отстала от удалённой.
     *
     * Отставание — не хвост и не беда: конвейер сам вливает pull request,
     * поэтому оно возникает штатно после каждого вливания.
     */
    behind(branch = mainBranch) {
      const result = run(['rev-list', '--count', `${branch}..${remote}/${branch}`]);
      if (result.code !== 0) return null;
      return Number.parseInt(out(result), 10) || 0;
    },

    /**
     * Подтянуть отставшую главную ветку ускоряющим переводом.
     *
     * Именно ускоряющим (`--ff-only`), а не слиянием: своих коммитов в этот
     * момент нет — хвост досылается раньше, — и если ускорить не удалось,
     * значит картина не та, какой её считали, и лезть дальше нельзя.
     *
     * Без этого шага основное дерево живёт на состоянии, которое было при
     * его последнем ручном обновлении: влитая работа до него не доезжает,
     * и конвейер запускает вчерашний код. Проверено на первом же живом
     * прогоне — оркестратор не нашёл в дереве собственного плагина.
     */
    fastForward(branch = mainBranch) {
      const result = run(['merge', '--ff-only', `${remote}/${branch}`]);
      if (result.code === 0) return { ok: true };
      return { ok: false, why: `${result.stderr}${result.stdout}`.trim() };
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

    /**
     * Захватить задачу: создать удалённый аннотированный тег `claim-<id>`.
     *
     * Это единственная надёжная операция «сравни-и-запиши» в распоряжении
     * конвейера. Trello её не даёт вовсе: `PUT` перезаписывает поле
     * владельца молча, и обе машины получили бы `200 OK`.
     *
     * Тег ставится на вершину удалённой главной ветки, а не на местный
     * `HEAD`: местный мог отстать, и захват встал бы на вчерашнем коммите.
     *
     * Возвращает `{ ok, outcome }`, где исход — `ours`, `taken`, `offline`
     * или `failed`. Толкует их вызывающий: занятая задача не беда,
     * а обычный ход работы.
     */
    claim(id, { machine, now }) {
      const tag = `claim-${id}`;

      // Локальный тег мог остаться от прошлой неудачной попытки. Тогда
      // `git tag -a` откажется его пересоздать, и захват провалился бы там,
      // где на самом деле всё свободно.
      run(['tag', '-d', tag]);

      const created = run([
        'tag',
        '-a',
        tag,
        '-m',
        `задача взята машиной ${machine} ${now}`,
        `${remote}/${mainBranch}`,
      ]);
      if (created.code !== 0) {
        return { ok: false, outcome: 'failed', why: created.stderr?.trim() };
      }

      const pushed = run(['push', remote, `refs/tags/${tag}`]);
      const outcome = classifyClaim(pushed);

      // За собой прибирается и победитель, и проигравший: местный тег
      // больше не нужен ни тому, ни другому, а оставшись, он помешает
      // следующей попытке.
      run(['tag', '-d', tag]);

      return { ok: outcome === 'ours', outcome, why: pushed.stderr?.trim() };
    },

    /**
     * Отпустить захват: удалить удалённый тег.
     *
     * Нужно при уборке за закрытой задачей и при откате незавершённого
     * взятия в работу. Отсутствие тега бедой не считается: цель достигнута.
     */
    releaseClaim(id) {
      const result = run(['push', remote, '--delete', `refs/tags/claim-${id}`]);
      if (result.code === 0) return { ok: true };
      const lower = `${result.stdout}${result.stderr}`.toLowerCase();
      if (lower.includes('does not exist') || lower.includes('remote ref does not exist')) {
        return { ok: true };
      }
      return { ok: false, why: result.stderr?.trim() };
    },

    /**
     * Кем захвачена задача — по описанию удалённого тега.
     *
     * Отвечает на вопрос «чей это захват» без доверия к полю владельца
     * на карточке: карточку правит и человек, а тег создаёт только машина.
     */
    claimedIds() {
      const result = run(['ls-remote', '--tags', remote, 'refs/tags/claim-*']);
      if (result.code !== 0) return null;
      return (
        out(result)
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('refs/tags/claim-')[1])
          // `^{}` помечает объект, на который указывает аннотированный тег:
          // та же задача, вторая строка вывода.
          .map((name) => (name ?? '').replace(/\^\{\}$/, ''))
          .filter(Boolean)
          .filter((name, index, all) => all.indexOf(name) === index)
      );
    },
  };
}
