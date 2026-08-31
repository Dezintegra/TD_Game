import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pushMain } from './push-discipline.mjs';
import { journalAppendix } from './journal.mjs';
import { appendQuestion, recordAnswer as recordAnswerIn, renderQuestion } from './questions.mjs';

/**
 * Переходник к настоящему миру: файлы, git, деревья.
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

/**
 * Исходы, при которых коммита не случилось вовсе.
 *
 * Отличать их от прочих обязательно. Всё, что дальше по пути, — отбитая
 * отправка, конфликт, отсутствие сети — происходит уже ПОСЛЕ удавшегося
 * коммита, и написанное там не потеряно: оно лежит в ветке хвостом.
 * А вот когда не удались `add` или `commit`, написанное осталось голым
 * изменением в общем дереве, и убрать его некому.
 */
const NOTHING_COMMITTED = ['add-failed', 'commit-failed'];

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
 * @param {object[]} [params.reports] отчёты, ожидающие переноса
 */
export function createIo({ root, config, git, now, machine, run, elapsed, reports = [] }) {
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
     * Сохранить изменённую задачу вместе с записью журнала.
     *
     * Здесь эта пара действий становится одной операцией не для красоты.
     * Хранилищ у бэклога два — файлы и доска Trello, — и устроены они
     * по-разному: файловое пишет две записи и коммитит их, а доска двигает
     * карточку и дописывает комментарий, безо всяких коммитов. Разделение
     * на «записать» и «отправить» имеет смысл только у первого, и вынести
     * его наружу значило бы заставить исполнение знать, с чем оно работает.
     *
     * @param {object} task  задача в новом состоянии
     * @param {object} entry запись журнала об этом переходе
     * @param {string} message сообщение коммита — доске оно не нужно
     */
    saveTask(task, entry, message, extraPaths = []) {
      const appendix = journalAppendix(task, this.readJournal(task.id), entry);
      // Попутные пути — файл вопросов, например. Они обязаны уехать ТЕМ ЖЕ
      // коммитом: разъехавшись, задача в ожидании осталась бы без вопроса
      // либо вопрос без задачи.
      const paths = [taskPath(task.id), journalPath(task.id), ...extraPaths];

      this.writeTask(task);
      this.appendJournal(task.id, appendix);

      const push = this.commitAndPush(paths, message);
      // Неудача ДО коммита прибирается сразу: иначе один сорвавшийся `add`
      // оставил бы основное дерево грязным навсегда, а грязное дерево
      // запрещает и подтягивание главной ветки, и перевыкладку — то есть
      // одна неудача останавливала бы конвейер целиком.
      if (NOTHING_COMMITTED.includes(push.outcome)) this.restorePaths(paths);

      return { ...push, paths };
    },

    /** Завести новую задачу: запись плюс отправка своим коммитом. */
    createTask(task, message) {
      const paths = [taskPath(task.id)];
      this.writeTask(task);
      const push = this.commitAndPush(paths, message);
      if (NOTHING_COMMITTED.includes(push.outcome)) this.restorePaths(paths);
      return { ...push, paths };
    },

    /**
     * Снять свой захват, не коммитя.
     *
     * Зовётся, когда отправка захвата не удалась: помеченной собой чужую
     * задачу оставлять нельзя. Коммита тут нет намеренно — коммитить нечего,
     * запись и так не уехала.
     */
    releaseTask(task) {
      this.writeTask(task);
    },

    /**
     * Записать вопрос владельцу продукта в файл вопросов.
     *
     * Возвращает путь файла, чтобы он уехал ТЕМ ЖЕ коммитом, что и сама
     * задача: разъехавшись, они дали бы задачу в ожидании без вопроса
     * либо вопрос без задачи.
     *
     * Раньше этого шага не было вовсе, и `awaiting-po` был тупиком: задача
     * уходила туда ждать ответа в разделе, который никто не создавал.
     * Выход из ожидания ровно один — непустой ответ, — так что задача
     * застревала навсегда, а владелец продукта видел пустой файл и не знал,
     * что его ждут.
     */
    askOwner(task, report) {
      const block = renderQuestion({
        taskId: task.id,
        askedAt: now,
        returnTo: task.returnTo,
        summary: report.summary,
        decisions: report.decisions ?? [],
      });
      this.writeQuestions(appendQuestion(this.readQuestions(), block));
      return this.questionsPath();
    },

    /**
     * Записать ответ, собранный спрашивающей сессией у человека.
     *
     * Сама сессия файла вопросов не трогает: писатель у бэклога один. Она
     * кладёт ответ в отчёт, а сюда он попадает уже рукой оркестратора.
     */
    recordAnswer(task, action, report) {
      const answer = report?.decisions?.[0];
      if (!answer) return null;

      const filled = recordAnswerIn(this.readQuestions(), action.taskId, answer);
      if (!filled) return null;

      this.writeQuestions(filled);
      return this.questionsPath();
    },

    /**
     * Прибрать за сохранением, проигравшим гонку.
     *
     * Наш коммит поверх чужого не ложится и остался бы хвостом, который
     * не сольётся уже никогда, — а хвост главной ветки запирает записи
     * всему конвейеру. Поэтому снимаем его и возвращаем файлы: за
     * проигравшим гонку не должно остаться ни следа.
     *
     * У доски этой заботы нет вовсе: там ничего не коммитится, а гонку
     * решает назначение исполнителя, а не запись состояния.
     */
    undoSave(save) {
      this.dropCommit();
      this.restorePaths(save.paths ?? []);
    },

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
     *
     * Но ветка задачи живёт дольше своего дерева. Дерево сносят — руками,
     * уборкой, переустановкой машины, — а ветку оставляют: в ней работа,
     * ещё не влитая в главную. Тогда `-b` падает «branch already exists»,
     * и задача застревает навсегда: починка `finish-claim` зовёт это место
     * каждый оборот и каждый оборот получает тот же отказ. Замечено
     * 31.08.2026 на задаче 0017 — конвейер простоял так двое суток.
     *
     * Поэтому уже существующая ветка — не беда, а продолжение работы:
     * дерево заводится НА неё, без нового ответвления. Удалённую ветку
     * без локальной git заведёт сам, с отслеживанием, — и это ровно то,
     * что нужно после потери дерева вместе с локальной веткой.
     */
    addWorktree(taskId, branch) {
      const path = join(config.worktreeDir, taskId);
      const base = `${config.remote}/${config.mainBranch}`;
      const known = (ref) => run(['rev-parse', '--verify', '--quiet', ref]).code === 0;
      const existing =
        known(`refs/heads/${branch}`) || known(`refs/remotes/${config.remote}/${branch}`);
      const result = existing
        ? run(['worktree', 'add', path, branch])
        : run(['worktree', 'add', path, '-b', branch, base]);
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

    /**
     * Опись доски: по строке на задачу, только то, чем сверяются.
     *
     * Целиком бэклог исполнителю не нужен и вреден — чем больше он о нём
     * знает, тем сильнее соблазн его править. Но две сверки без общей
     * картины не работают: аудит ищет конфликты с задачами в работе,
     * разбор — дубликаты. Им хватает пяти полей.
     *
     * Сеть здесь не тревожится: снимок доски прочитан один раз в начале
     * цикла, и `readTask` берёт из него.
     */
    boardDigest() {
      const digest = [];
      for (const id of this.allTaskIds()) {
        const task = this.readTask(id);
        if (!task) continue;
        digest.push({
          id: task.id,
          title: task.title,
          type: task.type,
          status: task.status,
          // Ссылки на артефакты нужны аудиту: он сопоставляет изменения
          // OpenSpec чужих задач со своим и так ловит пересечения. Без них
          // проверка выродилась бы в угадывание по именам веток.
          links: task.links ?? {},
        });
      }
      return digest;
    },

    /**
     * Отчёты, ожидающие переноса в бэклог.
     *
     * Лежат в памяти супервизора, а не файлами на диске. Каталог отчётов
     * ушёл вместе со слотами: отчёт приходит выводом того самого процесса,
     * который супервизор и породил, — то есть туда же, откуда пришёл вопрос.
     *
     * Прежде отчёт был файлом, и это тянуло за собой обход всех рабочих
     * деревьев из реестра: сессия с деревом физически не могла положить
     * файл в основное. Искать больше негде, и двойников не бывает.
     */
    readReport: (id, stage) =>
      reports.find((report) => report.taskId === id && report.stage === stage) ?? null,

    removeReport(id, stage) {
      const at = reports.findIndex((report) => report.taskId === id && report.stage === stage);
      if (at !== -1) reports.splice(at, 1);
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
