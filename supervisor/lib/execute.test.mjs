import { describe, expect, it } from 'vitest';
import { execute } from './execute.mjs';
import { journalAppendix } from './journal.mjs';
import { appendQuestion, recordAnswer as recordAnswerIn, renderQuestion } from './questions.mjs';

/**
 * Проверки исполнения решений.
 *
 * Мир здесь подставной, и поэтому проверяется главное, ради чего порядок
 * шагов вообще расписан: захват отправляется раньше заведения дерева, каждая
 * правка уезжает своим коммитом сразу, а при неудачной отправке за собой
 * ничего не остаётся.
 */

const NOW = '2026-08-26T12:00:00+03:00';

const task = (over = {}) => ({
  id: '0001-one',
  type: 'feature',
  title: 'Образец',
  status: 'new',
  returnTo: null,
  priority: 50,
  createdAt: '2026-08-26T10:00:00+03:00',
  statusChangedAt: '2026-08-26T10:00:00+03:00',
  owner: null,
  history: [],
  links: { change: null, pr: null, run: null, related: [] },
  attempts: { continuations: 0, cycleFailures: 0 },
  ...over,
});

/**
 * Подставной мир: помнит порядок шагов и хранит записанные задачи.
 */
function fakeIo(over = {}) {
  const steps = [];
  const tasks = new Map((over.tasks ?? [task()]).map((item) => [item.id, item]));
  const spawned = [];
  const journals = new Map();
  const restored = [];
  const dropped = [];
  const questions = { text: over.questions ?? '# Вопросы\n\n## Открытые вопросы\n' };

  const io = {
    now: NOW,
    machine: 'станция-1',
    steps,
    tasks,
    spawned,
    journals,
    restored,
    dropped,
    questions,

    readTask: (id) => tasks.get(id) ?? null,
    writeTask(next) {
      steps.push(`записана задача ${next.id} (${next.status}, владелец ${next.owner ?? '—'})`);
      tasks.set(next.id, next);
    },
    readJournal: (id) => journals.get(id) ?? '',
    appendJournal(id, text) {
      steps.push(`дописан журнал ${id}`);
      journals.set(id, (journals.get(id) ?? '') + text);
    },
    taskPath: (id) => `manage/tasks/${id}.json`,
    journalPath: (id) => `manage/journal/${id}.md`,

    questionsPath: () => 'manage/questions.md',
    readQuestions: () => questions.text,
    writeQuestions(text) {
      steps.push('файл вопросов переписан');
      questions.text = text;
    },

    commitAndPush(paths, message) {
      steps.push(`коммит и отправка: ${message} [${paths.length} путей]`);
      return over.push ? over.push(steps) : { ok: true, outcome: 'pushed' };
    },

    // Хранилище бэклога за интерфейсом: файловое пишет задачу, журнал
    // и коммитит их, доска Trello двигает карточку и дописывает
    // комментарий. Подставное имитирует файловое — так проверки порядка
    // шагов остаются про то же, про что и были.
    saveTask(next, entry, message, extraPaths = []) {
      // Запись журнала собирается настоящей сборкой, а не заглушкой:
      // часть проверок читает журнал и ждёт там решений и причин отказа.
      const appendix = journalAppendix(next, this.readJournal(next.id), entry);
      const paths = [this.taskPath(next.id), this.journalPath(next.id), ...extraPaths];
      this.writeTask(next);
      this.appendJournal(next.id, appendix);
      const push = this.commitAndPush(paths, message);
      if (['add-failed', 'commit-failed'].includes(push.outcome)) this.restorePaths(paths);
      return { ...push, paths };
    },
    createTask(next, message) {
      const paths = [this.taskPath(next.id)];
      this.writeTask(next);
      return { ...this.commitAndPush(paths, message), paths };
    },
    // Дополнение трогает ТОЛЬКО журнал: ни состояния, ни положения
    // в очереди у дополняемой задачи оно не меняет.
    amendTask(taskId, text, message) {
      const paths = [this.journalPath(taskId)];
      this.appendJournal(taskId, text);
      return over.amend ?? { ...this.commitAndPush(paths, message), paths };
    },
    releaseTask(next) {
      this.writeTask(next);
    },

    // Вопрос владельцу продукта тоже дело хранилища: файловое пишет его
    // в `manage/questions.md` и просит увезти файл тем же коммитом, доска
    // пишет комментарий к карточке и увозить ничего не просит.
    askOwner(next, report) {
      const block = renderQuestion({
        taskId: next.id,
        askedAt: this.now,
        returnTo: next.returnTo,
        summary: report.summary,
        decisions: report.decisions ?? [],
      });
      this.writeQuestions(appendQuestion(this.readQuestions(), block));
      return this.questionsPath();
    },
    recordAnswer(next, action, report) {
      const answer = report?.decisions?.[0];
      if (!answer) return null;
      const filled = recordAnswerIn(this.readQuestions(), action.taskId, answer);
      if (!filled) return null;
      this.writeQuestions(filled);
      return this.questionsPath();
    },

    undoSave(save) {
      this.dropCommit();
      this.restorePaths(save.paths ?? []);
    },

    restorePaths(paths) {
      steps.push(`пути возвращены к главной ветке: ${paths.length}`);
      restored.push(...paths);
      return true;
    },

    dropCommit() {
      steps.push('свой коммит снят');
      dropped.push(true);
      return true;
    },

    addWorktree(taskId, branch) {
      steps.push(`заведено дерево ${branch}`);
      return over.worktree ?? { ok: true, path: `.claude/worktrees/${taskId}` };
    },
    upsertRegistry(entry) {
      steps.push(`запись в реестре ${entry.taskId}`);
    },
    spawnStage(assignment) {
      steps.push(`запущен этап ${assignment.taskId}:${assignment.stage}`);
      spawned.push(assignment);
      return over.spawn ?? { ok: true, sessionId: 'сессия-1', pid: 4242 };
    },
    lastSession: () => over.lastSession ?? null,
    forgetSession(taskId, stage) {
      steps.push(`забыта сессия ${taskId}:${stage}`);
      return true;
    },

    // Улики о деле этапа. Их обязаны спрашивать ТОЛЬКО при непустом перечне
    // отказов, поэтому обращение сюда попадает в перечень шагов.
    stageEvidence(next) {
      steps.push(`спрошены улики ${next.id}`);
      return (
        over.evidence ?? {
          branchOnRemote: true,
          unpushed: 0,
          lastCommitAt: '2026-08-26T11:30:00+03:00',
          previousRun: null,
        }
      );
    },
    stageStartedAt: () => over.stageStartedAt ?? '2026-08-26T11:00:00+03:00',
    maxRejections: over.maxRejections,
    maxAutoReturns: over.maxAutoReturns ?? 2,
    boardDigest: () => [...tasks.values()].map((item) => ({ id: item.id, status: item.status })),

    // Записи может не быть вовсе, и `null` здесь — не «умолчание сойдёт»,
    // а проверяемый случай: задача захвачена, дерева ещё нет.
    registryEntry: () =>
      'entry' in over
        ? over.entry
        : {
            taskId: '0001-one',
            branch: 'worktree-0001-one',
            path: '.claude/worktrees/0001-one',
          },
    dropRegistry(id) {
      steps.push(`запись реестра ${id} снята`);
    },
    pushBranchTail(branch, path) {
      steps.push(`дослан хвост ${branch} из ${path}`);
      return over.branchPush ?? { ok: true };
    },
    readPr: () => over.pr ?? { state: 'merged' },
    unpushed: () => over.unpushed ?? 0,
    removeWorktree: () => over.worktreeRemoval ?? { ok: true },
    deleteBranch: () => ({ ok: true }),
    deleteRemoteBranch: () => ({ ok: true }),

    // Исход этапа, осиротевшего при смене супервизора. Он живёт очередью
    // в супервизоре, а не на диске: писать на доску вправе только исполнение.
    readOrphan: (taskId, stage) =>
      'orphan' in over
        ? over.orphan
        : {
            taskId,
            stage,
            pid: 29704,
            startedAt: '2026-08-26T11:00:00+03:00',
            outcome: 'gone',
            why: 'процесс кончился сам',
          },
    forgetOrphan(taskId, stage) {
      steps.push(`исход сироты ${taskId}:${stage} забыт`);
      return true;
    },

    allTaskIds: () => [...tasks.keys()],
    readReport: (id, stage) => over.report ?? { taskId: id, stage, outcome: 'done' },
    removeReport(id, stage) {
      steps.push(`отчёт ${id}:${stage} убран`);
    },
    readExternal: () => over.external ?? { state: 'success' },
    readAnswer: () => over.answer ?? 'берём вариант А',
  };

  return io;
}

const startAction = { kind: 'start-stage', taskId: '0001-one', stage: 'design' };

describe('исход осиротевшего этапа', () => {
  const noteAction = { kind: 'note-orphan', taskId: '0001-one', stage: 'implement' };

  it('дописывается в журнал, не трогая саму задачу', async () => {
    // Задача 0070: два изменения одной задачи в один оборот делаются
    // по одному снимку доски, и второе затирает первое. А запись об исходе
    // и выдача сессии попадают в один оборот по построению.
    const io = fakeIo({ tasks: [task({ status: 'implement' })] });
    const [result] = await execute([noteAction], io);

    expect(result.result).toBe('done');
    expect(io.steps).toContain('дописан журнал 0001-one');
    expect(io.steps.filter((step) => step.startsWith('записана задача'))).toEqual([]);
    expect(io.tasks.get('0001-one')).toMatchObject({ status: 'implement', history: [] });
  });

  it('запись называет процесс, потерянный отчёт и ветку', async () => {
    const io = fakeIo({ tasks: [task({ status: 'implement' })] });
    await execute([noteAction], io);

    const journal = io.journals.get('0001-one');
    expect(journal).toContain('29704');
    expect(journal).toContain('осиротел');
    expect(journal).toContain('Отчёт этого захода потерян');
    expect(journal).toContain('в ветке задачи');
  });

  it('исход забывается только после удавшейся записи', async () => {
    const io = fakeIo({ tasks: [task({ status: 'implement' })] });
    await execute([noteAction], io);

    const written = io.steps.indexOf('дописан журнал 0001-one');
    const forgotten = io.steps.indexOf('исход сироты 0001-one:implement забыт');
    expect(written).toBeGreaterThanOrEqual(0);
    expect(forgotten).toBeGreaterThan(written);
  });

  it('неудачная запись исход из очереди не убирает', async () => {
    // Дескриптор при этом остаётся на диске, и следующий оборот пробует
    // снова: повторная запись стоит одного лишнего комментария, потерянная —
    // необъяснимого провала в журнале задачи.
    const io = fakeIo({
      tasks: [task({ status: 'implement' })],
      amend: { ok: false, outcome: 'offline' },
    });
    const [result] = await execute([noteAction], io);

    expect(result.result).toBe('failed');
    expect(io.steps).not.toContain('исход сироты 0001-one:implement забыт');
  });

  it('исхода уже нет — действие пропускается без записи', async () => {
    const io = fakeIo({ tasks: [task({ status: 'implement' })], orphan: null });
    const [result] = await execute([noteAction], io);

    expect(result.result).toBe('skipped');
    expect(io.steps).toEqual([]);
  });
});

describe('взятие задачи в работу', () => {
  it('захват отправляется раньше заведения дерева', async () => {
    const io = fakeIo();
    await execute([startAction], io);

    const push = io.steps.findIndex((step) => step.startsWith('коммит и отправка'));
    const tree = io.steps.findIndex((step) => step.startsWith('заведено дерево'));
    expect(push).toBeGreaterThanOrEqual(0);
    expect(tree).toBeGreaterThan(push);
  });

  it('после захвата задача помечена машиной и переведена в этап', async () => {
    const io = fakeIo();
    const [result] = await execute([startAction], io);
    expect(result.result).toBe('done');
    expect(io.tasks.get('0001-one')).toMatchObject({ owner: 'станция-1', status: 'design' });
  });

  it('этап запускается последним, когда мир уже готов', async () => {
    // Порядок тот же, что был у слота, и по той же причине: сессия
    // начинает работать сразу, а не по расписанию, поэтому и захват,
    // и дерево обязаны существовать раньше неё.
    const io = fakeIo();
    await execute([startAction], io);
    expect(io.steps.at(-1)).toBe('запущен этап 0001-one:design');
  });

  it('назначение несёт задачу, её журнал и опись доски', async () => {
    // Ради этого всё и затевалось: исполнителю больше незачем открывать
    // бэклог, а значит нечему и разойтись с ним.
    const io = fakeIo({
      tasks: [task(), task({ id: '0002-two', status: 'review', title: 'вторая' })],
    });
    io.appendJournal('0001-one', '## что решили прежде');
    await execute([startAction], io);

    const [assignment] = io.spawned;
    expect(assignment.task).toMatchObject({ id: '0001-one', status: 'design' });
    expect(assignment.journal).toContain('## что решили прежде');
    expect(assignment.board).toContainEqual(
      expect.objectContaining({ id: '0002-two', status: 'review' }),
    );
    expect(assignment.branch).toBe('worktree-0001-one');
  });

  it('первый заход на этап начинает сессию, а не возобновляет', async () => {
    const io = fakeIo();
    await execute([startAction], io);
    expect(io.spawned[0].continuation).toBe(false);
    expect(io.spawned[0].sessionId).toBe(null);
  });

  it('занятая чужой машиной задача не берётся и мир не трогается', async () => {
    const io = fakeIo({ tasks: [task({ owner: 'станция-2' })] });
    const [result] = await execute([startAction], io);
    expect(result.result).toBe('raced');
    expect(io.steps.filter((step) => step.startsWith('заведено дерево'))).toEqual([]);
  });

  it('неудача ДО коммита возвращает файлы и не оставляет следа', async () => {
    // Написанное никуда не поедет и остаётся голым изменением в общем
    // дереве. Убрать за собой некому, а грязное дерево запрещает и
    // подтягивание главной ветки, и перевыкладку: одна неудача
    // останавливала бы конвейер целиком.
    const io = fakeIo({ push: () => ({ ok: false, outcome: 'add-failed' }) });
    const [result] = await execute([startAction], io);
    expect(result.result).toBe('failed');
    expect(io.restored).toContain('manage/tasks/0001-one.json');
    expect(io.restored).toContain('manage/journal/0001-one.md');
    expect(io.steps.filter((step) => step.startsWith('заведено дерево'))).toEqual([]);
  });

  it('годный коммит без отправки захват НЕ снимает', async () => {
    // Захват состоялся: работа заявлена коммитом, не хватает лишь публикации,
    // и досылка хвоста сделает её ближайшим циклом. Прежде здесь переписывался
    // файл со снятым владельцем — и это отменяло лишь половину захвата,
    // оставляя задачу в этапе, из которого её не доставал уже никто.
    const io = fakeIo({ push: () => ({ ok: false, outcome: 'offline' }) });
    const [result] = await execute([startAction], io);
    expect(result.result).toBe('failed');
    expect(io.tasks.get('0001-one')).toMatchObject({ owner: 'станция-1', status: 'design' });
    expect(io.dropped).toEqual([]);
    expect(io.restored).toEqual([]);
    expect(io.steps.filter((step) => step.startsWith('заведено дерево'))).toEqual([]);
  });

  it('конфликт снимает свой коммит и возвращает файлы', async () => {
    // Задачу занял кто-то другой. Наш коммит поверх чужого не ложится
    // и остался бы хвостом, который не сольётся уже никогда, — а хвост
    // главной ветки запирает записи всему конвейеру.
    const io = fakeIo({ push: () => ({ ok: false, outcome: 'conflict' }) });
    const [result] = await execute([startAction], io);
    expect(result.result).toBe('raced');
    expect(io.dropped).toEqual([true]);
    expect(io.restored).toContain('manage/tasks/0001-one.json');
    expect(io.steps.filter((step) => step.startsWith('заведено дерево'))).toEqual([]);
  });

  it('этап, который не завёлся, за успех не выдаётся', async () => {
    // Несостоявшееся порождение — это отказ настройки, а не работа сессии.
    // Выдав его за успех, конвейер оставил бы задачу в этапе, которого
    // никто не делает.
    const io = fakeIo({ spawn: { ok: false, reason: 'not-born', why: 'spawn claude ENOENT' } });
    const [result] = await execute([startAction], io);
    expect(result.result).toBe('failed');
    expect(result.why).toContain('ENOENT');
    expect(io.tasks.get('0001-one').attempts.spawnFailures).toBe(1);
    expect(io.journals.get('0001-one')).toContain('ENOENT');
  });

  it('при тесноте захват остаётся, а второго дерева не появляется', async () => {
    // Задача действительно взята и действительно стоит в этапе — отменять
    // тут нечего. Не хватает лишь сессии, и её выдаст ближайший оборот.
    const io = fakeIo({ spawn: { ok: false, reason: 'busy', why: 'все места заняты' } });
    const [result] = await execute([startAction], io);

    expect(result.result).toBe('skipped');
    expect(io.tasks.get('0001-one')).toMatchObject({ owner: 'станция-1', status: 'design' });
    expect(io.steps.filter((step) => step.startsWith('заведено дерево'))).toHaveLength(1);
    // Записей о задаче ровно одна — та, что говорит о взятии в работу.
    expect(io.journals.get('0001-one')).toContain('Взята в работу');
    expect(io.journals.get('0001-one')).not.toContain('не запустился');
    expect(io.tasks.get('0001-one').attempts.spawnFailures).toBeUndefined();
  });

  it('прогону дерево не заводится: арену считает чужое железо', async () => {
    const io = fakeIo({ tasks: [task({ type: 'run', status: 'new' })] });
    await execute([{ ...startAction, stage: 'benchmark' }], io);
    expect(io.steps.filter((step) => step.startsWith('заведено дерево'))).toEqual([]);
    expect(io.steps).toContain('запущен этап 0001-one:benchmark');
  });

  it('неудача заведения дерева не выдаётся за успех', async () => {
    const io = fakeIo({ worktree: { ok: false, why: 'каталог занят' } });
    const [result] = await execute([startAction], io);
    expect(result.result).toBe('failed');
    expect(result.why).toContain('каталог занят');
  });
});

describe('перенос отчёта', () => {
  const transfer = { kind: 'transfer-report', taskId: '0001-one', stage: 'design' };

  it('успешный этап двигает задачу и снимает отчёт с очереди', async () => {
    const io = fakeIo({ tasks: [task({ status: 'design' })] });
    const [result] = await execute([transfer], io);
    expect(result.result).toBe('done');
    expect(io.tasks.get('0001-one').status).toBe('audit');
    expect(io.steps).toContain('отчёт 0001-one:design убран');
  });

  it('отчёт убирается только после удавшейся отправки', async () => {
    const io = fakeIo({
      tasks: [task({ status: 'design' })],
      push: () => ({ ok: false, outcome: 'rejected' }),
    });
    await execute([transfer], io);
    expect(io.steps.filter((step) => step.includes('отчёт'))).toEqual([]);
  });

  it('дошедший до конца этап обнуляет счётчик продолжений', async () => {
    const io = fakeIo({
      tasks: [task({ status: 'design', attempts: { continuations: 2, cycleFailures: 0 } })],
    });
    await execute([transfer], io);
    expect(io.tasks.get('0001-one').attempts.continuations).toBe(0);
  });

  it('вопрос владельцу продукта сохраняет состояние возврата', async () => {
    const io = fakeIo({
      tasks: [task({ status: 'design' })],
      report: {
        taskId: '0001-one',
        stage: 'design',
        outcome: 'question',
        summary: 'два прочтения',
      },
    });
    await execute([transfer], io);
    expect(io.tasks.get('0001-one')).toMatchObject({ status: 'awaiting-po', returnTo: 'design' });
  });

  it('возврат забывает сессию того этапа, куда задача едет', async () => {
    // Возобновлённая сессия отвечает из своей памяти — «всё сделано» — и
    // вершина между кругами не меняется вовсе. 31.08.2026 так вышло четыре
    // круга подряд по десять минут каждый.
    const io = fakeIo({
      tasks: [task({ status: 'audit' })],
      report: { taskId: '0001-one', stage: 'audit', outcome: 'rejected', summary: 'не то меряет' },
    });
    await execute([{ kind: 'transfer-report', taskId: '0001-one', stage: 'audit' }], io);
    expect(io.tasks.get('0001-one').status).toBe('design');
    expect(io.steps).toContain('забыта сессия 0001-one:design');
  });

  it('успешный этап сессию не забывает', async () => {
    const io = fakeIo({ tasks: [task({ status: 'design' })] });
    await execute([transfer], io);
    expect(io.steps.filter((step) => step.startsWith('забыта сессия'))).toEqual([]);
  });

  it('возврат наращивает счёт, а не обнуляет его', async () => {
    const io = fakeIo({
      tasks: [task({ status: 'audit', attempts: { continuations: 0, cycleFailures: 0 } })],
      report: { taskId: '0001-one', stage: 'audit', outcome: 'rejected', summary: 'мимо' },
    });
    await execute([{ kind: 'transfer-report', taskId: '0001-one', stage: 'audit' }], io);
    expect(io.tasks.get('0001-one').attempts.rejections).toBe(1);
  });

  it('возврат обнуляет продолжения: проработка начинает со своим счётом', async () => {
    // Задача 0088 пришла в проработку с двумя продолжениями, съеденными
    // аудитом, и была остановлена следующим же оборотом, не получив сессии.
    const io = fakeIo({
      tasks: [task({ status: 'audit', attempts: { continuations: 2, cycleFailures: 0 } })],
      report: { taskId: '0001-one', stage: 'audit', outcome: 'rejected', summary: 'мимо' },
    });
    await execute([{ kind: 'transfer-report', taskId: '0001-one', stage: 'audit' }], io);
    expect(io.tasks.get('0001-one').status).toBe('design');
    expect(io.tasks.get('0001-one').attempts.continuations).toBe(0);
    expect(io.tasks.get('0001-one').attempts.rejections).toBe(1);
  });

  it('возврат за пределом отдаёт задачу в разбор, забыв его прошлую сессию', async () => {
    const io = fakeIo({
      maxRejections: 3,
      tasks: [
        task({ status: 'audit', attempts: { continuations: 0, cycleFailures: 0, rejections: 2 } }),
      ],
      report: { taskId: '0001-one', stage: 'audit', outcome: 'rejected', summary: 'мимо' },
    });
    await execute([{ kind: 'transfer-report', taskId: '0001-one', stage: 'audit' }], io);
    expect(io.tasks.get('0001-one').status).toBe('postmortem');

    // Сессия спорившего этапа не трогается: спор кончен, разбирать его будет
    // не он. А вот сессия разбора забывается — иначе задача, разобранная
    // однажды, услышала бы от неё вывод о позапрошлом падении.
    expect(io.steps).toContain('забыта сессия 0001-one:postmortem');
    expect(io.steps).not.toContain('забыта сессия 0001-one:audit');
  });

  it('номер pull request из отчёта попадает в саму задачу', async () => {
    // Дыра, найденная сверкой скиллов: ссылки уезжали только в журнал,
    // а опрос проверок читает их из задачи — и она висела бы в ожидании
    // вечно, потому что опрашивать было бы нечего.
    const io = fakeIo({
      tasks: [task({ status: 'implement' })],
      report: {
        taskId: '0001-one',
        stage: 'implement',
        outcome: 'done',
        links: { pr: 51, change: 'моё-изменение' },
      },
    });
    await execute([{ kind: 'transfer-report', taskId: '0001-one', stage: 'implement' }], io);
    expect(io.tasks.get('0001-one').links).toMatchObject({ pr: 51, change: 'моё-изменение' });
  });

  it('пустые ссылки отчёта не затирают уже известные', async () => {
    const io = fakeIo({
      tasks: [
        task({ status: 'design', links: { change: 'старое', pr: 7, run: null, related: [] } }),
      ],
      report: { taskId: '0001-one', stage: 'design', outcome: 'done', links: { pr: null } },
    });
    await execute([{ kind: 'transfer-report', taskId: '0001-one', stage: 'design' }], io);
    expect(io.tasks.get('0001-one').links.pr).toBe(7);
  });

  it('неуспех отправляет задачу в разбор с чистым счётом попыток', async () => {
    // Прежде счёт здесь сохранялся: задача вставала в ошибке, и число
    // сожжённых заходов было уликой для человека. Теперь между ней и ошибкой
    // стоит разбор — этап, которому нужны собственные попытки. Не обнули их,
    // и разбор был бы объявлен провалившимся прежде первой своей сессии.
    //
    // Улика не теряется: причина остановки уезжает в журнал задачи, а число
    // заходов — в её историю.
    const io = fakeIo({
      tasks: [task({ status: 'design', attempts: { continuations: 2, cycleFailures: 0 } })],
      report: { taskId: '0001-one', stage: 'design', outcome: 'failed', summary: 'упало' },
    });
    await execute([transfer], io);
    expect(io.tasks.get('0001-one').attempts.continuations).toBe(0);
  });
});

describe('отказанные действия при переносе отчёта', () => {
  // Прежде отчёт отбрасывался при любом непустом перечне отказов, и мерка
  // оказалась слишком грубой: шесть отброшенных отчётов подряд за вечер
  // 31.08.2026, и ни один не потерян из-за настоящей беды.
  const transfer = { kind: 'transfer-report', taskId: '0001-one', stage: 'design' };

  const denials = [{ tool_name: 'PowerShell', tool_input: { command: 'node --version' } }];

  const withDenials = (over = {}) =>
    fakeIo({
      tasks: [task({ status: 'design' })],
      report: {
        taskId: '0001-one',
        stage: 'design',
        outcome: 'done',
        summary: 'изменение заведено целиком',
        decisions: ['перечень средств отвергнут: он неполон по устройству'],
        links: { change: 'judge-denials-by-deeds' },
        denials,
      },
      ...over,
    });

  it('попутный отказ двигает задачу дальше по маршруту', async () => {
    const io = withDenials();
    const [result] = await execute([transfer], io);

    expect(result.result).toBe('done');
    expect(io.tasks.get('0001-one').status).toBe('audit');
    expect(io.steps).toContain('отчёт 0001-one:design убран');
  });

  it('попутный отказ виден в журнале задачи', async () => {
    // Журнал цикла не уезжает никуда, а журнал задачи едет в промпт
    // следующей сессии: заметность отказа живёт только здесь.
    const io = withDenials();
    await execute([transfer], io);

    const journal = io.journals.get('0001-one');
    expect(journal).toContain('**Отказано в действиях:**');
    expect(journal).toContain('PowerShell: node --version');
  });

  it('подрывающий отказ отправляет задачу в разбор сразу', async () => {
    // Ветки задачи у origin нет — значит этап отчитался об успехе, которого
    // не случилось. Продолжение бессмысленно: правило разрешений не менялось.
    const io = withDenials({ evidence: { branchOnRemote: false, unpushed: 0 } });
    await execute([transfer], io);

    expect(io.tasks.get('0001-one').status).toBe('postmortem');
    expect(io.steps).toContain('забыта сессия 0001-one:design');
    expect(io.steps).toContain('отчёт 0001-one:design убран');
  });

  it('отброшенный отчёт целиком уезжает в журнал', async () => {
    // Основание записано ценой: 0006 ушла в ошибку с полностью снятыми
    // числами шестидесяти матчей, которых не прочитал никто.
    const io = withDenials({ evidence: { branchOnRemote: false, unpushed: 0 } });
    await execute([transfer], io);

    const journal = io.journals.get('0001-one');
    expect(journal).toContain('изменение заведено целиком');
    expect(journal).toContain('перечень средств отвергнут');
    expect(journal).toContain('change: judge-denials-by-deeds');
    expect(journal).toContain('**Отказано в действиях:**');
    expect(journal).toContain('**Не удалось:**');
  });

  it('«сверять нечем» пропускает отчёт, но говорит об этом', async () => {
    const io = fakeIo({
      tasks: [task({ status: 'design' })],
      report: { taskId: '0001-one', stage: 'design', outcome: 'done', denials },
      // Молчаливая поломка прибора не должна стоить работы этапа.
      evidence: { branchOnRemote: null, unpushed: null },
    });
    await execute([transfer], io);

    expect(io.tasks.get('0001-one').status).toBe('audit');
    expect(io.journals.get('0001-one')).toContain('сопоставить отказ с делом нечем');
  });

  it('без отказов улики не спрашиваются ни разу', async () => {
    // Холостой ход не должен стоить ни одного лишнего вызова git.
    const io = fakeIo({ tasks: [task({ status: 'design' })] });
    await execute([transfer], io);
    expect(io.steps).not.toContain('спрошены улики 0001-one');
  });
});

describe('вопрос владельцу продукта', () => {
  const asking = { kind: 'transfer-report', taskId: '0001-one', stage: 'design' };

  const askingIo = (over = {}) =>
    fakeIo({
      tasks: [task({ status: 'design' })],
      report: {
        taskId: '0001-one',
        stage: 'design',
        outcome: 'question',
        summary: 'Цена Теслы влияет и на покупку, и на прокачку.',
        decisions: ['**Вариант А.** Удешевить покупку.', '**Вариант Б.** Удешевить и прокачку.'],
      },
      ...over,
    });

  it('вопрос попадает в файл, а не только в состояние задачи', async () => {
    // Прежде этого шага не было вовсе: задача уходила ждать ответа
    // в разделе файла, который никто не создавал, и застревала навсегда.
    const io = askingIo();
    await execute([asking], io);
    expect(io.questions.text).toContain('### 0001-one');
    expect(io.questions.text).toContain('**Вариант Б.** Удешевить и прокачку.');
  });

  it('файл вопросов уезжает ТЕМ ЖЕ коммитом, что и задача', async () => {
    // Разъехавшись, они дали бы либо задачу в ожидании без вопроса,
    // либо вопрос без задачи.
    const io = askingIo();
    await execute([asking], io);
    expect(io.steps).toContain(
      'коммит и отправка: chore(backlog): 0001-one design → awaiting-po [3 путей]',
    );
  });

  it('в задаче появляется поле вопроса, которого требует схема', async () => {
    const io = askingIo();
    await execute([asking], io);
    const saved = io.tasks.get('0001-one');
    expect(saved.status).toBe('awaiting-po');
    expect(saved.question).toMatchObject({ askedAt: NOW, answeredAt: null });
    expect(saved.returnTo).toBe('design');
  });

  it('ответ сессии возвращает задачу туда, откуда она ушла', async () => {
    const io = fakeIo({
      tasks: [
        task({
          status: 'awaiting-po',
          returnTo: 'design',
          question: {
            askedAt: '2026-08-25T10:00:00+03:00',
            summary: 'что делаем',
            answeredAt: null,
          },
        }),
      ],
      questions: '## Открытые вопросы\n\n### 0001-one\n\nсуть\n\n**Ответ:**\n',
      report: {
        taskId: '0001-one',
        stage: 'awaiting-po',
        outcome: 'done',
        summary: 'владелец продукта ответил',
        decisions: ['Вариант А: удешевить только покупку.'],
      },
    });
    const [result] = await execute(
      [{ kind: 'transfer-report', taskId: '0001-one', stage: 'awaiting-po' }],
      io,
    );
    expect(result.result).toBe('done');
    expect(io.tasks.get('0001-one').status).toBe('design');
  });

  it('ответ дописывается в файл вопросов и гасит вопрос', async () => {
    // Не записав ответ, конвейер оставил бы раздел пустым: следующая
    // спрашивающая сессия задала бы тот же вопрос заново, а летопись
    // говорила бы, что владелец продукта так и не ответил.
    const io = fakeIo({
      tasks: [
        task({
          status: 'awaiting-po',
          returnTo: 'design',
          question: {
            askedAt: '2026-08-25T10:00:00+03:00',
            summary: 'что делаем',
            answeredAt: null,
          },
        }),
      ],
      questions: '## Открытые вопросы\n\n### 0001-one\n\nсуть\n\n**Ответ:**\n',
      report: {
        taskId: '0001-one',
        stage: 'awaiting-po',
        outcome: 'done',
        decisions: ['Вариант А: удешевить только покупку.'],
      },
    });
    await execute([{ kind: 'transfer-report', taskId: '0001-one', stage: 'awaiting-po' }], io);
    expect(io.questions.text).toContain('**Ответ:** Вариант А: удешевить только покупку.');
    expect(io.tasks.get('0001-one').question.answeredAt).toBe(NOW);
  });
});

describe('сессия на идущий этап', () => {
  const carryOn = {
    kind: 'continue-stage',
    taskId: '0001-one',
    stage: 'implement',
    reason: 'этапу нужна сессия, живого процесса нет',
  };

  it('счётчик продолжений растёт, этап запускается', async () => {
    const io = fakeIo({ tasks: [task({ status: 'implement' })] });
    const [result] = await execute([carryOn], io);
    expect(result.result).toBe('done');
    expect(io.tasks.get('0001-one').attempts.continuations).toBe(1);
    expect(io.steps).toContain('запущен этап 0001-one:implement');
  });

  it('назначение видит израсходованные попытки, а не прежнее их число', async () => {
    const io = fakeIo({ tasks: [task({ status: 'implement' })] });
    await execute([carryOn], io);
    expect(io.spawned[0].task.attempts.continuations).toBe(1);
  });

  it('известная сессия возобновляется, а не начинается заново', async () => {
    // Ради этого и держится память о сессиях: возобновлённая помнит свой ход
    // мысли. Прежде продолжатель выяснял сделанное тремя командами `git log`
    // и иногда понимал неверно.
    const io = fakeIo({ tasks: [task({ status: 'implement' })], lastSession: 'сессия-прежняя' });
    await execute([carryOn], io);
    expect(io.spawned[0]).toMatchObject({ continuation: true, sessionId: 'сессия-прежняя' });
  });

  it('удавшееся порождение пишет в журнал задачи выданную сессию', async () => {
    const io = fakeIo({ tasks: [task({ status: 'implement' })] });
    await execute([carryOn], io);
    expect(io.journals.get('0001-one')).toContain('Этапу выдана сессия');
  });

  it('удавшееся порождение гасит счёт несостоявшихся запусков', async () => {
    // Оно доказывает, что машинерия запуска работает, и прежние отказы
    // к делу больше не относятся.
    const io = fakeIo({
      tasks: [task({ status: 'implement', attempts: { continuations: 0, spawnFailures: 2 } })],
    });
    await execute([carryOn], io);
    expect(io.tasks.get('0001-one').attempts.spawnFailures).toBe(0);
  });

  it('несостоявшийся запуск продолжения не тратит', async () => {
    // Признак сделанности из карточки задачи 0067, дословно: порождение,
    // вернувшее ok: false, оставляет attempts.continuations неизменным.
    const io = fakeIo({
      tasks: [task({ status: 'implement' })],
      spawn: { ok: false, reason: 'not-born', why: 'spawn claude ENOENT' },
    });
    const [result] = await execute([carryOn], io);

    expect(result.result).toBe('failed');
    expect(io.tasks.get('0001-one').attempts.continuations).toBe(0);
  });

  it('причина несостоявшегося запуска уезжает в журнал задачи', async () => {
    // Прежде она оставалась в одном лишь cycle.log, а карточка утверждала
    // обратное — «Этапу выдана сессия», — и разбор шёл по ложному следу.
    const io = fakeIo({
      tasks: [task({ status: 'implement' })],
      spawn: { ok: false, reason: 'not-born', why: 'spawn claude ENOENT' },
    });
    await execute([carryOn], io);

    expect(io.journals.get('0001-one')).toContain('ENOENT');
    expect(io.journals.get('0001-one')).not.toContain('Этапу выдана сессия');
    expect(io.tasks.get('0001-one').attempts.spawnFailures).toBe(1);
  });

  it('теснота не тратит ничего и журнала не трогает вовсе', async () => {
    // Оборот идёт раз в пять минут, прогон арены держит место десятками
    // минут: запись о тесноте дала бы карточке дюжину строк в час.
    const io = fakeIo({
      tasks: [task({ status: 'implement' })],
      spawn: { ok: false, reason: 'busy', why: 'все места заняты' },
    });
    const [result] = await execute([carryOn], io);

    expect(result.result).toBe('skipped');
    expect(result.why).toContain('все места заняты');
    expect(io.journals.get('0001-one')).toBeUndefined();
    expect(io.tasks.get('0001-one').attempts.continuations).toBe(0);
  });

  it('безместной задаче сессия не выдаётся, и оборот не падает', async () => {
    // Прежде отсутствие дерева доходило до склейки пути и бросало
    // TypeError: падало не одно действие, а весь оборот цикла вместе
    // с решениями по всем прочим задачам (31.08.2026).
    const io = fakeIo({ tasks: [task({ status: 'implement' })], entry: null });
    const [result] = await execute([carryOn], io);
    expect(result.result).toBe('failed');
    expect(result.why).toContain('дерева у задачи нет');
    expect(io.steps).not.toContain('запущен этап 0001-one:implement');
  });

  it('этапу без дерева отсутствие записи не мешает', async () => {
    // Прогону дерево не нужно вовсе: арену считает чужое железо.
    const io = fakeIo({ tasks: [task({ status: 'benchmark' })], entry: null });
    const [result] = await execute([{ ...carryOn, stage: 'benchmark' }], io);
    expect(result.result).toBe('done');
  });
});

describe('внешнее состояние', () => {
  const poll = { kind: 'poll-external', taskId: '0001-one', what: 'ci' };

  it('зелёные проверки открывают ревью', async () => {
    const io = fakeIo({ tasks: [task({ status: 'pr' })], external: { state: 'success' } });
    await execute([poll], io);
    expect(io.tasks.get('0001-one').status).toBe('review');
  });

  it('идущие проверки ничего не пишут', async () => {
    const io = fakeIo({ tasks: [task({ status: 'pr' })], external: { state: 'pending' } });
    const [result] = await execute([poll], io);
    expect(result.result).toBe('skipped');
    expect(io.steps).toEqual([]);
  });

  it('красные проверки отправляют в доработку', async () => {
    const io = fakeIo({
      tasks: [task({ status: 'pr' })],
      external: { state: 'failure', failed: 'матчевые тесты' },
    });
    await execute([poll], io);
    expect(io.tasks.get('0001-one').status).toBe('revise');
    expect(io.journals.get('0001-one')).toContain('матчевые тесты');
  });
});

describe('ответ владельца продукта', () => {
  it('возвращает задачу туда, откуда она ушла', async () => {
    const io = fakeIo({ tasks: [task({ status: 'awaiting-po', returnTo: 'design' })] });
    const [result] = await execute([{ kind: 'answer-question', taskId: '0001-one' }], io);
    expect(result.result).toBe('done');
    expect(io.tasks.get('0001-one').status).toBe('design');
    expect(io.journals.get('0001-one')).toContain('вариант А');
  });

  it('без состояния возврата задача не двигается', async () => {
    const io = fakeIo({ tasks: [task({ status: 'awaiting-po', returnTo: null })] });
    const [result] = await execute([{ kind: 'answer-question', taskId: '0001-one' }], io);
    expect(result.result).toBe('failed');
  });
});

describe('возврат из ошибки по вине конвейера', () => {
  const fallen = (over = {}) =>
    task({
      status: 'failed',
      returnTo: 'implement',
      attempts: { continuations: 2, cycleFailures: 1, rejections: 0, spawnFailures: 0 },
      recovery: { causedBy: 'pipeline', fixedBy: ['0091-fix'], returns: 0 },
      ...over,
    });
  const back = {
    kind: 'return-task',
    taskId: '0001-one',
    returnTo: 'implement',
    fixedBy: ['0091-fix'],
  };

  it('возвращает в состояние возврата, обнуляет попытки и наращивает счёт', async () => {
    const io = fakeIo({ tasks: [fallen()] });
    const [result] = await execute([back], io);

    expect(result).toMatchObject({ result: 'done', status: 'implement' });
    const moved = io.tasks.get('0001-one');
    expect(moved.status).toBe('implement');
    expect(moved.returnTo).toBeNull();
    expect(moved.attempts).toEqual({
      continuations: 0,
      cycleFailures: 0,
      rejections: 0,
      spawnFailures: 0,
    });
    // Вердикт снят, счёт вырос: судить о задаче будет следующий разбор.
    expect(moved.recovery).toEqual({ causedBy: null, fixedBy: [], returns: 1 });
  });

  it('журнал называет причину возврата и закрытые починки поимённо', async () => {
    const io = fakeIo({ tasks: [fallen()] });
    await execute([back], io);
    const journal = io.journals.get('0001-one');
    expect(journal).toContain('failed → implement');
    expect(journal).toContain('причина падения была в конвейере');
    expect(journal).toContain('починки закрыты: 0091-fix');
    expect(journal).toContain('Возврат 1 из 2');
  });

  it('сессия упавшего этапа забывается: новая читает свежие правила', async () => {
    const io = fakeIo({ tasks: [fallen()] });
    await execute([back], io);
    expect(io.steps).toContain('забыта сессия 0001-one:implement');
  });

  it('когда чинить было нечего, так и пишет', async () => {
    const io = fakeIo({
      tasks: [fallen({ recovery: { causedBy: 'pipeline', fixedBy: [], returns: 1 } })],
    });
    await execute([{ ...back, fixedBy: [] }], io);
    expect(io.journals.get('0001-one')).toContain('чинить было нечего');
    expect(io.tasks.get('0001-one').recovery.returns).toBe(2);
  });

  it('задачу, которую человек уже поднял, второй раз не трогает', async () => {
    const io = fakeIo({ tasks: [fallen({ status: 'implement', returnTo: null })] });
    const [result] = await execute([back], io);
    expect(result.result).toBe('skipped');
    expect(io.steps).toEqual([]);
  });

  it('без конвейерного вердикта не возвращает', async () => {
    const io = fakeIo({
      tasks: [fallen({ recovery: { causedBy: 'task', fixedBy: [], returns: 0 } })],
    });
    const [result] = await execute([back], io);
    expect(result.result).toBe('skipped');
  });
});

describe('остановка задачи', () => {
  const stop = (taskId = '0001-one') => ({
    kind: 'fail-stage',
    taskId,
    stage: 'implement',
    reason: 'этап не доводится до конца, продолжения исчерпаны',
  });

  it('рабочая задача останавливается разбором, а не ошибкой', async () => {
    const io = fakeIo({ tasks: [task({ status: 'implement' })] });
    const [result] = await execute([stop()], io);
    expect(result.result).toBe('done');

    const moved = io.tasks.get('0001-one');
    expect(moved.status).toBe('postmortem');
    expect(moved.returnTo).toBe('implement');
    // Счёт обнуляется переходом: иначе сканер объявил бы разбор
    // провалившимся прежде первой его сессии.
    expect(moved.attempts.continuations).toBe(0);
    expect(io.steps).toContain('забыта сессия 0001-one:postmortem');
    expect(io.journals.get('0001-one')).toContain('продолжения исчерпаны');
  });

  it('разбор, не доведённый до конца, останавливает задачу окончательно', async () => {
    // Разбора разбора не бывает: петля крутилась бы, пока её не заметит
    // человек, и каждый круг стоил бы сессии.
    const io = fakeIo({ tasks: [task({ status: 'postmortem', returnTo: 'implement' })] });
    const [result] = await execute([stop()], io);
    expect(result.result).toBe('done');

    const moved = io.tasks.get('0001-one');
    expect(moved.status).toBe('failed');
    // Состояние возврата уцелело: человек поднимет задачу в имплементацию,
    // а не в разбор.
    expect(moved.returnTo).toBe('implement');
  });
});

describe('уборка', () => {
  const sweep = { kind: 'cleanup', taskId: '0001-one' };
  const inCleanup = () =>
    task({ status: 'cleanup', links: { change: null, pr: 50, run: null, related: [] } });

  it('влитый pull request даёт убрать и закрыть задачу', async () => {
    const io = fakeIo({ tasks: [inCleanup()], pr: { state: 'merged' } });
    const [result] = await execute([sweep], io);
    expect(result.result).toBe('done');
    expect(io.tasks.get('0001-one').status).toBe('closed');
    expect(io.steps).toContain('запись реестра 0001-one снята');
  });

  it('невлитый pull request отправляет задачу в разбор, ничего не удаляя', async () => {
    const io = fakeIo({ tasks: [inCleanup()], pr: { state: 'open' } });
    const [result] = await execute([sweep], io);
    expect(result.result).toBe('done');
    expect(io.tasks.get('0001-one').status).toBe('postmortem');
    expect(io.tasks.get('0001-one').returnTo).toBe('cleanup');
    expect(io.steps).not.toContain('запись реестра 0001-one снята');
  });

  it('занятый каталог оставляет задачу в уборке до следующего цикла', async () => {
    const io = fakeIo({
      tasks: [inCleanup()],
      pr: { state: 'merged' },
      worktreeRemoval: { ok: false, why: 'каталог занят' },
    });
    const [result] = await execute([sweep], io);
    expect(result.result).toBe('skipped');
    expect(io.tasks.get('0001-one').status).toBe('cleanup');
  });
});

describe('заявки на новые задачи', () => {
  const triage = { kind: 'transfer-report', taskId: '0001-one', stage: 'triage' };
  const note = () => task({ type: 'note', status: 'triage' });

  it('заявка превращается в задачу, связанную с породившей', async () => {
    // Дыра, найденная сверкой: скиллы обещали, что оркестратор заведёт
    // задачи по заявкам, а в коде этого не было — этап разбора работал
    // вхолостую.
    const io = fakeIo({
      tasks: [note()],
      report: {
        taskId: '0001-one',
        stage: 'triage',
        outcome: 'done',
        requests: [
          { type: 'feature', title: 'Починить цену Теслы', description: 'Цена мешает ремонту.' },
        ],
      },
    });
    const [result] = await execute([triage], io);
    expect(result.result).toBe('done');
    expect(result.created).toHaveLength(1);

    const born = io.tasks.get(result.created[0]);
    expect(born.type).toBe('feature');
    // Заведена кандидатом: заявка агента — предложение, а не решение.
    expect(born.status).toBe('candidate');
    expect(born.links.related).toContain('0001-one');
    expect(io.tasks.get('0001-one').links.related).toContain(born.id);
  });

  it('заявка на прогон заводится сразу в работу, минуя шлюз', async () => {
    const io = fakeIo({
      tasks: [note()],
      report: {
        taskId: '0001-one',
        stage: 'triage',
        outcome: 'done',
        requests: [
          {
            type: 'run',
            title: 'Проверить длину матча после правки',
            description: 'Замер заказан по изменению.',
            run: { kind: 'arena', expectation: 'медиана в вилке 10–15 минут' },
          },
        ],
      },
    });
    const [result] = await execute([triage], io);
    expect(io.tasks.get(result.created[0]).status).toBe('new');
  });

  it('каждая порождённая задача уезжает своим коммитом', async () => {
    const io = fakeIo({
      tasks: [note()],
      report: {
        taskId: '0001-one',
        stage: 'triage',
        outcome: 'done',
        requests: [
          { type: 'feature', title: 'Первая', description: 'Раз.' },
          { type: 'feature', title: 'Вторая', description: 'Два.' },
        ],
      },
    });
    await execute([triage], io);
    const commits = io.steps.filter((step) => step.startsWith('коммит и отправка'));
    expect(commits).toHaveLength(3); // состояние породившей плюс две задачи
  });

  it('негодная заявка отклоняется, годная заводится', async () => {
    const io = fakeIo({
      tasks: [note()],
      report: {
        taskId: '0001-one',
        stage: 'triage',
        outcome: 'done',
        requests: [
          { type: 'feature', title: 'Годная', description: 'Есть описание.' },
          { type: 'run', title: 'Прогон без ожидания', description: 'Есть.' },
        ],
      },
    });
    const [result] = await execute([triage], io);
    expect(result.created).toHaveLength(1);
    expect(io.journals.get('0001-one')).toContain('заявка отклонена');
  });

  it('задачи по заявкам заводятся РАНЬШЕ смены состояния породившей', async () => {
    // Порядок выстрадан. Пока было наоборот, неудача на заявках оставляла
    // отчёт непринятым при уже применённом переходе, и повторить перенос
    // было нельзя: отчёт говорил об этапе, из которого задача уже вышла.
    // Заявки при этом пропадали насовсем — так и потерялись две находки
    // первого живого прогона.
    const io = fakeIo({
      tasks: [note()],
      report: {
        taskId: '0001-one',
        stage: 'triage',
        outcome: 'done',
        requests: [{ type: 'feature', title: 'Порождённая', description: 'Есть описание.' }],
      },
    });
    await execute([triage], io);

    const born = io.steps.findIndex((step) => step.includes('заведена по разбору'));
    const moved = io.steps.findIndex((step) => step.includes('triage → closed'));
    expect(born).toBeGreaterThanOrEqual(0);
    expect(moved).toBeGreaterThan(born);
  });

  it('неудача на заявках не трогает состояния породившей', async () => {
    const io = fakeIo({
      tasks: [note()],
      report: {
        taskId: '0001-one',
        stage: 'triage',
        outcome: 'done',
        requests: [{ type: 'feature', title: 'Порождённая', description: 'Есть описание.' }],
      },
      push: () => ({ ok: false, outcome: 'dirty' }),
    });
    const [result] = await execute([triage], io);
    expect(result.result).toBe('failed');
    // Состояние не тронуто: следующий цикл начнёт заново, и отчёт цел.
    expect(io.tasks.get('0001-one').status).toBe('triage');
    expect(io.steps.filter((step) => step.includes('отчёт'))).toEqual([]);
  });

  it('без заявок ничего лишнего не заводится', async () => {
    const io = fakeIo({ tasks: [note()] });
    const [result] = await execute([triage], io);
    expect(result.created).toEqual([]);
    expect(io.tasks.size).toBe(1);
  });
});

describe('дополнение существующей задачи', () => {
  const analysis = { kind: 'transfer-report', taskId: '0001-one', stage: 'postmortem' };
  const halted = () => task({ status: 'postmortem', returnTo: 'implement' });
  const older = (over = {}) =>
    task({ id: '0002-two', status: 'candidate', title: 'Запретить перечисление', ...over });

  const withAmendments = (amendments, over = {}) =>
    fakeIo({
      tasks: [halted(), older(over.older)],
      report: { taskId: '0001-one', stage: 'postmortem', outcome: 'done', amendments },
      ...over,
    });

  it('фактура уезжает в журнал названной задачи, ничего в ней не двигая', async () => {
    // Пять кандидатов об одной причине — это не пять находок, а один сигнал,
    // размазанный так, что его перестают читать.
    const io = withAmendments([{ taskId: '0002-two', facts: 'Та же причина уронила 0001.' }]);
    const [result] = await execute([analysis], io);

    expect(result.result).toBe('done');
    expect(result.amended).toEqual(['0002-two']);
    expect(io.journals.get('0002-two')).toContain('Та же причина уронила 0001');
    // Названа и задача-источник: по одной фактуре без неё не понять, откуда она.
    expect(io.journals.get('0002-two')).toContain('Дополнение по разбору 0001-one');
    // Состояние дополненной не тронуто, новой задачи не завелось.
    expect(io.tasks.get('0002-two').status).toBe('candidate');
    expect(result.created).toEqual([]);
    expect(io.tasks.size).toBe(2);
  });

  it('источник связывается с дополненной задачей', async () => {
    const io = withAmendments([{ taskId: '0002-two', facts: 'ещё случай' }]);
    await execute([analysis], io);
    expect(io.tasks.get('0001-one').links.related).toContain('0002-two');
  });

  it('дополнение уезжает своим коммитом и раньше смены состояния', async () => {
    const io = withAmendments([{ taskId: '0002-two', facts: 'ещё случай' }]);
    await execute([analysis], io);

    const amended = io.steps.findIndex((step) => step.includes('дополнена фактурой'));
    const moved = io.steps.findIndex((step) => step.includes('postmortem → failed'));
    expect(amended).toBeGreaterThanOrEqual(0);
    expect(moved).toBeGreaterThan(amended);
  });

  it('негодное дополнение отклоняется с причиной, годное применяется', async () => {
    const io = withAmendments([
      { taskId: '0099-none', facts: 'мимо' },
      { taskId: '0002-two', facts: 'по делу' },
    ]);
    const [result] = await execute([analysis], io);
    expect(result.amended).toEqual(['0002-two']);
    expect(io.journals.get('0001-one')).toContain('дополнение отклонено');
  });

  it('закрытая задача дополнений не принимает', async () => {
    const io = withAmendments([{ taskId: '0002-two', facts: 'ещё случай' }], {
      older: { status: 'closed' },
    });
    const [result] = await execute([analysis], io);
    expect(result.amended).toEqual([]);
    expect(io.journals.get('0001-one')).toContain('дополнений не принимает');
  });

  it('неудача на дополнении не трогает состояния разбираемой задачи', async () => {
    const io = withAmendments([{ taskId: '0002-two', facts: 'ещё случай' }], {
      amend: { ok: false, outcome: 'offline' },
    });
    const [result] = await execute([analysis], io);
    expect(result.result).toBe('failed');
    // Состояние цело, отчёт цел: следующий цикл начнёт заново.
    expect(io.tasks.get('0001-one').status).toBe('postmortem');
  });

  it('блокирующая заявка разбора встаёт в очередь, минуя кандидатов', async () => {
    const io = fakeIo({
      tasks: [halted()],
      report: {
        taskId: '0001-one',
        stage: 'postmortem',
        outcome: 'done',
        requests: [
          {
            type: 'feature',
            title: 'Запретить перечисление каталогов в скиллах',
            description: 'Молчаливый отказ роняет каждую задачу подряд.',
            blocking: true,
          },
        ],
      },
    });
    const [result] = await execute([analysis], io);
    expect(io.tasks.get(result.created[0]).status).toBe('new');
  });

  it('та же метка с разбора замечаний не слушается', async () => {
    const io = fakeIo({
      tasks: [task({ type: 'note', status: 'triage' })],
      report: {
        taskId: '0001-one',
        stage: 'triage',
        outcome: 'done',
        requests: [
          {
            type: 'feature',
            title: 'Очень нужное',
            description: 'Сессия считает это срочным.',
            blocking: true,
          },
        ],
      },
    });
    const [result] = await execute([{ ...analysis, stage: 'triage' }], io);
    expect(io.tasks.get(result.created[0]).status).toBe('candidate');
  });
});

describe('вердикт разбора', () => {
  const analysis = { kind: 'transfer-report', taskId: '0001-one', stage: 'postmortem' };
  const halted = (over = {}) => task({ status: 'postmortem', returnTo: 'implement', ...over });
  const fix = (over = {}) => ({
    type: 'feature',
    title: 'Разрешить pnpm в правилах разрешений',
    description: 'Отказ молчаливый и повторится на каждой задаче.',
    ...over,
  });
  const judged = (report, over = {}) =>
    fakeIo({
      tasks: [halted(over.halted), task({ id: '0084-pnpm', status: 'candidate' })],
      report: { taskId: '0001-one', stage: 'postmortem', outcome: 'done', ...report },
      ...over,
    });

  it('причина в конвейере: вердикт и номер заведённой починки едут в задачу', async () => {
    // Идентификатор своей заявки разбор знать не может — его выдаёт перенос.
    // Заявка при этом конвейерна и без `area`: причина в конвейере делает
    // конвейерными все заявки отчёта, иначе задача вернулась бы сразу,
    // а починка ждала бы человека в кандидатах.
    const io = judged({ causedBy: 'pipeline', requests: [fix()] });
    const [result] = await execute([analysis], io);

    const born = io.tasks.get(result.created[0]);
    expect(born).toMatchObject({ status: 'new', blocking: true, area: 'pipeline' });
    expect(io.tasks.get('0001-one')).toMatchObject({
      status: 'failed',
      recovery: { causedBy: 'pipeline', fixedBy: [born.id], returns: 0 },
    });
  });

  it('названный разбором кандидат с описи попадает в fixedBy', async () => {
    const io = judged({ causedBy: 'pipeline', fixedBy: ['0084-pnpm'] });
    await execute([analysis], io);
    expect(io.tasks.get('0001-one').recovery.fixedBy).toEqual(['0084-pnpm']);
  });

  it('несуществующая задача в fixedBy отброшена, причина в журнале', async () => {
    const io = judged({ causedBy: 'pipeline', fixedBy: ['0999-nowhere', '0084-pnpm'] });
    await execute([analysis], io);
    expect(io.tasks.get('0001-one').recovery.fixedBy).toEqual(['0084-pnpm']);
    expect(io.journals.get('0001-one')).toContain('0999-nowhere');
  });

  it('причина в задаче: вердикт записан, починок нет', async () => {
    const io = judged({ causedBy: 'task', requests: [fix()] });
    const [result] = await execute([analysis], io);
    expect(io.tasks.get('0001-one').recovery).toEqual({
      causedBy: 'task',
      fixedBy: [],
      returns: 0,
    });
    // Заявка при причине в задаче идёт обычным путём — кандидатом.
    expect(io.tasks.get(result.created[0]).status).toBe('candidate');
  });

  it('разбор без причины применяется, но не возвращает, и журнал это говорит', async () => {
    const io = judged({});
    await execute([analysis], io);
    expect(io.tasks.get('0001-one')).toMatchObject({
      status: 'failed',
      recovery: { causedBy: null, fixedBy: [], returns: 0 },
    });
    expect(io.journals.get('0001-one')).toContain('не назвал причину');
  });

  it('на пределе возвратов вердикт не записывается, журнал зовёт человека', async () => {
    const io = judged(
      { causedBy: 'pipeline' },
      { halted: { recovery: { causedBy: null, fixedBy: [], returns: 2 } } },
    );
    await execute([analysis], io);
    expect(io.tasks.get('0001-one').recovery).toEqual({ causedBy: null, fixedBy: [], returns: 2 });
    expect(io.journals.get('0001-one')).toContain('возвращалась дважды, дальше человек');
  });

  it('неудавшийся разбор вердикта не оставляет', async () => {
    const io = judged({ outcome: 'failed', causedBy: 'pipeline', summary: 'лога нет' });
    await execute([analysis], io);
    expect(io.tasks.get('0001-one').status).toBe('failed');
    expect(io.tasks.get('0001-one')).not.toHaveProperty('recovery');
  });
});

describe('карантин негодной карточки', () => {
  const quarantine = {
    kind: 'quarantine-card',
    taskId: '0009-bad',
    problems: ['нет метки вида прогона'],
    returnTo: 'new',
  };

  /** Переходник с доской: у файлового этих методов нет вовсе. */
  const withBoard = (over = {}) => {
    const io = fakeIo();
    const calls = [];
    io.quarantineCard = (taskId, params) => {
      calls.push({ taskId, ...params });
      return over.quarantine ?? { ok: true, outcome: 'saved' };
    };
    io.clearCard = (taskId) => {
      calls.push({ cleared: taskId });
      return over.clear ?? { ok: true, outcome: 'saved' };
    };
    return { io, calls };
  };

  it('карточка уносится вместе с претензиями и состоянием возврата', async () => {
    const { io, calls } = withBoard();
    const [result] = await execute([quarantine], io);

    expect(result.result).toBe('done');
    expect(calls[0]).toMatchObject({
      taskId: '0009-bad',
      problems: ['нет метки вида прогона'],
      returnTo: 'new',
    });
  });

  it('задачи в бэклоге при этом не ищут: её там и нет', async () => {
    // Карточка негодна как раз потому, что задачей не читается. Требуй
    // это действие задачу — оно не сработало бы никогда.
    const { io } = withBoard();
    const [result] = await execute([quarantine], io);
    expect(result.result).toBe('done');
    expect(io.tasks.has('0009-bad')).toBe(false);
  });

  it('неудача доски названа, а не проглочена', async () => {
    const { io } = withBoard({ quarantine: { ok: false, outcome: 'offline', why: 'нет сети' } });
    const [result] = await execute([quarantine], io);
    expect(result).toMatchObject({ result: 'failed', why: 'нет сети' });
  });

  it('файловый бэклог отвечает пропуском с причиной, а не падением', async () => {
    // Там негодную запись отбивает JSON Schema, и «перенести» её значило бы
    // переписать файл, который схему не прошёл.
    const [result] = await execute([quarantine], fakeIo());
    expect(result).toMatchObject({ result: 'skipped' });
    expect(result.why).toContain('только доска');
  });

  it('исправленная карточка лишается метки', async () => {
    const { io, calls } = withBoard();
    const [result] = await execute([{ kind: 'clear-card', taskId: '0010-fixed' }], io);

    expect(result.result).toBe('done');
    expect(calls[0]).toEqual({ cleared: '0010-fixed' });
  });
});

describe('досылка хвоста ветки задачи', () => {
  const tail = {
    kind: 'push-tail',
    scope: 'branch',
    branch: 'worktree-0001-one',
    taskId: '0001-one',
    commits: 2,
  };

  it('досылается из собственного дерева задачи', async () => {
    const io = fakeIo();
    const [result] = await execute([tail], io);
    expect(result.result).toBe('done');
    expect(io.steps).toContain('дослан хвост worktree-0001-one из .claude/worktrees/0001-one');
  });

  it('хвост главной ветки здесь не обрабатывают', async () => {
    const io = fakeIo();
    const [result] = await execute([{ kind: 'push-tail', scope: 'main', commits: 1 }], io);
    expect(result.result).toBe('skipped');
  });

  it('неудача досылки не выдаётся за успех', async () => {
    const io = fakeIo({ branchPush: { ok: false, why: 'ветка ушла вперёд' } });
    const [result] = await execute([tail], io);
    expect(result.result).toBe('failed');
    expect(result.why).toContain('ушла вперёд');
  });
});

describe('пропавшая сеть', () => {
  it('останавливает исполнение, а не перебирает остальные действия', async () => {
    const io = fakeIo({
      tasks: [task({ status: 'design' }), task({ id: '0002-two', status: 'design' })],
      push: () => ({ ok: false, outcome: 'offline' }),
    });
    const results = await execute(
      [
        { kind: 'transfer-report', taskId: '0001-one', stage: 'design' },
        { kind: 'transfer-report', taskId: '0002-two', stage: 'design' },
      ],
      io,
    );
    expect(results.at(-1).why).toContain('сети нет');
    expect(results.filter((item) => item.result === 'done')).toEqual([]);
  });
});
