import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pushMain } from './push-discipline.mjs';

/**
 * Переходник к настоящему миру: файлы, git, слоты.
 *
 * Всё, что здесь есть, — это исполнение уже принятых решений. Ни одного
 * решения тут не принимается, и это не педантизм: решающая часть покрыта
 * тестами без диска и сети, а здесь проверять было бы нечего, кроме склейки
 * путей.
 *
 * Все пути ведут внутрь рабочего каталога проекта. Запись за его пределы
 * требует подтверждения человека и запирает автономную сессию насмерть —
 * проверено пробой, вставшей на записи во временный каталог.
 */

/** Красиво и одинаково: две пробела, перевод строки в конце. */
const asJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** Метка порядка байтов, записанная кодом: в исходнике она невидима. */
const BOM = String.fromCharCode(0xfeff);

const readJson = (path) => {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw.startsWith(BOM) ? raw.slice(1) : raw);
};

/**
 * Собрать переходник.
 *
 * @param {object} params
 * @param {string} params.root    корень репозитория
 * @param {object} params.config  настройка
 * @param {object} params.git     набор команд git
 * @param {string} params.now     отметка времени цикла
 * @param {string} params.machine имя рабочей станции
 * @param {(args:string[])=>object} params.run исполнитель внешних команд
 * @param {() => number} params.elapsed сколько секунд идёт цикл
 */
export function createIo({ root, config, git, now, machine, run, elapsed }) {
  const local = (...parts) => join(root, config.paths.local, ...parts);
  const ensure = (dir) => mkdirSync(dir, { recursive: true });

  const taskPath = (id) => `${config.paths.tasks}/${id}.json`;
  const journalPath = (id) => `${config.paths.journal}/${id}.md`;
  const registryPath = () => local('registry.json');

  return {
    now,
    machine,
    taskPath,
    journalPath,

    readTask: (id) => readJson(join(root, taskPath(id))),

    /**
     * Все занятые идентификаторы, включая закрытые задачи.
     *
     * Нужны, чтобы выдать новый: номер после закрытия не переиспользуется,
     * иначе имя ветки однажды совпадёт с именем давно убранной.
     */
    allTaskIds() {
      const dir = join(root, config.paths.tasks);
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.replace(/\.json$/, ''));
    },

    writeTask(task) {
      ensure(join(root, config.paths.tasks));
      writeFileSync(join(root, taskPath(task.id)), asJson(task));
    },

    readJournal(id) {
      const path = join(root, journalPath(id));
      return existsSync(path) ? readFileSync(path, 'utf8') : '';
    },

    appendJournal(id, text) {
      const dir = join(root, config.paths.journal);
      ensure(dir);
      const path = join(root, journalPath(id));
      writeFileSync(path, (existsSync(path) ? readFileSync(path, 'utf8') : '') + text);
    },

    /**
     * Закоммитить свои пути и отправить немедленно.
     *
     * Пути перечисляются явно. Захват всего изменённого разом запрещён: он
     * опубликовал бы чужую незавершённую работу без окна на замечание.
     */
    commitAndPush(paths, message) {
      const added = run(['add', '--', ...paths]);
      if (added.code !== 0) return { ok: false, outcome: 'add-failed', why: added.stderr };

      // Коммит подписывается именем конвейера, а не хозяина машины.
      // Досылка хвоста отправляет только свои коммиты и наотрез отказывается
      // публиковать чужой черновик, а узнаёт их по имени автора. Пока
      // конвейер подписывался хозяином, он объявлял чужим собственный хвост
      // и переставал писать вовсе — до вмешательства человека. Проверено
      // 27.08.2026 по журналу цикла: «в хвосте 1 коммит(ов), из них чужих».
      //
      // Ключи `-c` вместо настройки репозитория намеренно: основное дерево
      // общее, и менять в нём подпись для всех было бы наглостью.
      const committed = run([
        '-c',
        `user.name=${config.author.name}`,
        '-c',
        `user.email=${config.author.email}`,
        'commit',
        '-m',
        message,
        // Пути перечисляются и здесь, а не только в `add`. Без них `commit`
        // забирает ВЕСЬ индекс — вместе с тем, что успела выложить туда
        // соседняя сессия или человек. Правило «стейджить только свои пути»
        // тогда не защищает ни от чего: чужое уедет в главную ветку под
        // нашим сообщением и без окна на замечание. С путями `commit`
        // берёт только их и чужой индекс не трогает.
        '--',
        ...paths,
      ]);
      if (committed.code !== 0)
        return { ok: false, outcome: 'commit-failed', why: committed.stderr };

      const push = pushMain({
        git,
        branch: config.mainBranch,
        elapsed,
        budgetSeconds: config.pushBudgetSeconds,
      });
      return { ok: push.outcome === 'pushed', outcome: push.outcome, notes: push.notes };
    },

    /**
     * Файл вопросов владельцу продукта.
     *
     * Единственный файл бэклога, в который пишет не только конвейер:
     * ответы туда вписывает человек. Поэтому читается он всегда целиком
     * и перезаписывается тоже целиком — дозапись вслепую однажды легла бы
     * поверх ответа, набранного в ту же минуту.
     */
    questionsPath: () => config.paths.questions,

    readQuestions() {
      const path = join(root, config.paths.questions);
      return existsSync(path) ? readFileSync(path, 'utf8').replace(/^\uFEFF/, '') : '';
    },

    writeQuestions(text) {
      const path = join(root, config.paths.questions);
      ensure(dirname(path));
      writeFileSync(path, text, 'utf8');
    },

    /** Вернуть названные пути к состоянию главной ветки. */
    restorePaths: (paths) => git.restorePaths(paths),

    /** Снять свой последний коммит, оставив правки в индексе. */
    dropCommit: () => git.dropLastCommit(),

    /**
     * Завести рабочее дерево от удалённой главной ветки.
     *
     * Именно от удалённой, а не от локальной: расхождение здесь уже стоило
     * проекту потерянных коммитов, и правило записано в CLAUDE.md кровью.
     */
    addWorktree(taskId, branch) {
      const path = join(config.worktreeDir, taskId);
      const base = `${config.remote}/${config.mainBranch}`;
      const result = run(['worktree', 'add', path, '-b', branch, base]);
      if (result.code !== 0) return { ok: false, why: result.stderr.trim() };
      return { ok: true, path };
    },

    upsertRegistry(entry) {
      ensure(local());
      const registry = readJson(registryPath()) ?? { entries: [] };
      const entries = registry.entries.filter((item) => item.taskId !== entry.taskId);
      writeFileSync(registryPath(), asJson({ entries: [...entries, entry] }));
    },

    registryEntry: (taskId) =>
      (readJson(registryPath())?.entries ?? []).find((item) => item.taskId === taskId) ?? null,

    dropRegistry(taskId) {
      const registry = readJson(registryPath());
      if (!registry) return;
      const entries = registry.entries.filter((item) => item.taskId !== taskId);
      writeFileSync(registryPath(), asJson({ entries }));
    },

    writeSlot(slot, assignment) {
      ensure(local('slots'));
      writeFileSync(local('slots', `${slot}.json`), asJson(assignment));
    },

    clearSlot(slot) {
      const path = local('slots', `${slot}.json`);
      if (existsSync(path)) rmSync(path);
    },

    readReport: (id, stage) => readJson(local('reports', `${id}-${stage}.json`)),

    removeReport(id, stage) {
      const path = local('reports', `${id}-${stage}.json`);
      if (existsSync(path)) rmSync(path);
    },

    /**
     * Внешнее состояние: проверки на pull request либо прогон на чужом железе.
     *
     * Идущие проверки и отсутствие ответа — разные вещи. Первое означает
     * «подожди», второе — «спроси позже»; ни то, ни другое не повод двигать
     * задачу.
     */
    readExternal(task, what) {
      if (what === 'ci') {
        if (!task.links?.pr) return { state: 'pending', why: 'pull request ещё не открыт' };
        const result = run(
          ['pr', 'view', String(task.links.pr), '--json', 'statusCheckRollup'],
          'gh',
        );
        if (result.code !== 0) return { state: 'pending', why: 'состояние проверок недоступно' };
        return summariseChecks(result.stdout);
      }

      if (!task.links?.run) return { state: 'pending', why: 'прогон ещё не запущен' };
      const result = run(
        ['run', 'view', String(task.links.run), '--json', 'status,conclusion'],
        'gh',
      );
      if (result.code !== 0) return { state: 'pending', why: 'состояние прогона недоступно' };
      const parsed = JSON.parse(result.stdout || '{}');
      if (parsed.status !== 'completed') return { state: 'pending' };
      return { state: parsed.conclusion === 'success' ? 'success' : 'failure' };
    },

    /** Состояние pull request. Им доказывается влитость — не хешами коммитов. */
    readPr(number) {
      if (!number) return { state: 'unknown' };
      const result = run(['pr', 'view', String(number), '--json', 'state'], 'gh');
      if (result.code !== 0) return { state: 'unknown' };
      try {
        const state = JSON.parse(result.stdout || '{}').state ?? '';
        return { state: state.toLowerCase() };
      } catch {
        return { state: 'unknown' };
      }
    },

    /**
     * Дослать хвост ветки задачи.
     *
     * Только ускоряющей отправкой и только из её собственного дерева
     * (`git -C`). Перевыкладывать чужую ветку из основного дерева нельзя:
     * git этого и не даст, а попытка оставила бы дерево в незавершённой
     * операции — то самое общее дерево, где работают все сессии.
     */
    pushBranchTail(branch, path) {
      const result = run(['-C', path, 'push', config.remote, branch]);
      if (result.code === 0) return { ok: true };
      return { ok: false, why: result.stderr.trim() };
    },

    /** Сколько коммитов ветки нет в её удалённом двойнике. */
    unpushed(branch) {
      const result = run(['rev-list', '--count', `${config.remote}/${branch}..${branch}`]);
      if (result.code !== 0) return null;
      return Number.parseInt(result.stdout.trim(), 10) || 0;
    },

    removeWorktree(path) {
      const result = run(['worktree', 'remove', path, '--force']);
      if (result.code === 0) return { ok: true };
      // Каталога может уже не быть — тогда убирать нечего, и это не беда.
      if (/not a working tree|no such file|is not a valid/i.test(result.stderr))
        return { ok: true };
      return { ok: false, why: result.stderr.trim() };
    },

    deleteBranch(branch) {
      const result = run(['branch', '-D', branch]);
      if (result.code === 0) return { ok: true };
      if (/not found/i.test(result.stderr)) return { ok: true };
      return { ok: false, why: result.stderr.trim() };
    },

    deleteRemoteBranch(branch) {
      const result = run(['push', config.remote, '--delete', branch]);
      if (result.code === 0) return { ok: true };
      if (/remote ref does not exist/i.test(result.stderr)) return { ok: true };
      return { ok: false, why: result.stderr.trim() };
    },

    /** Ответ владельца продукта из файла вопросов. */
    readAnswer(id) {
      const path = join(root, config.paths.questions);
      if (!existsSync(path)) return null;
      const sections = readFileSync(path, 'utf8').split(/^### /m).slice(1);
      for (const section of sections) {
        if (section.slice(0, section.indexOf('\n')).trim() !== id) continue;
        const marker = section.indexOf('**Ответ:**');
        if (marker === -1) return null;
        const answer = section.slice(marker + '**Ответ:**'.length).trim();
        return answer.length > 0 ? answer : null;
      }
      return null;
    },
  };
}

/**
 * Свести проверки к одному ответу.
 *
 * Пока хоть одна не завершилась — состояние «идут». Ревью на незавершённых
 * проверках не начинают: замечания к коду, который ещё собирается,
 * бесполезны.
 */
export function summariseChecks(json) {
  let checks;
  try {
    checks = JSON.parse(json || '{}').statusCheckRollup ?? [];
  } catch {
    return { state: 'pending', why: 'ответ не разобрался' };
  }
  if (checks.length === 0) return { state: 'pending', why: 'проверок ещё нет' };

  const unfinished = checks.filter((check) => check.status !== 'COMPLETED');
  if (unfinished.length > 0) {
    return { state: 'pending', why: `идут: ${unfinished.map((c) => c.name).join(', ')}` };
  }

  const failed = checks.filter((check) => check.conclusion !== 'SUCCESS');
  if (failed.length > 0) {
    return { state: 'failure', failed: failed.map((check) => check.name).join(', ') };
  }
  return { state: 'success' };
}
