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
  const slots = new Map();
  const briefs = new Map();
  const journals = new Map();
  const restored = [];
  const dropped = [];
  const questions = { text: over.questions ?? '# Вопросы\n\n## Открытые вопросы\n' };

  const io = {
    now: NOW,
    machine: 'станция-1',
    steps,
    tasks,
    slots,
    briefs,
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
    writeSlot(slot) {
      steps.push(`назначение в слот ${slot}`);
      slots.set(slot, true);
    },
    writeBrief(slot, brief) {
      steps.push(`выписка в слот ${slot}: ${brief.task?.id} ${brief.task?.status}`);
      briefs.set(slot, brief);
    },
    clearSlot(slot) {
      steps.push(`слот ${slot} освобождён`);
      slots.delete(slot);
      briefs.delete(slot);
    },

    registryEntry: () =>
      over.entry ?? {
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

const startAction = {
  kind: 'start-stage',
  taskId: '0001-one',
  stage: 'design',
  branch: 'worktree-0001-one',
  sessionTitle: 'pipeline:0001-one:design',
  slot: 'worker',
  assignment: { taskId: '0001-one', stage: 'design' },
};

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

  it('назначение попадает в слот последним, выписка — прямо перед ним', async () => {
    // Слот и есть сигнал к работе: исполнитель просыпается по нему. Поэтому
    // он пишется, когда мир уже готов — захват отправлен, дерево заведено, —
    // а выписка, на которую он указывает, ложится ещё раньше.
    const io = fakeIo();
    await execute([startAction], io);
    expect(io.steps.slice(-2)).toEqual([
      'выписка в слот worker: 0001-one design',
      'назначение в слот worker',
    ]);
  });

  it('выписка несёт задачу, её журнал и опись доски', async () => {
    // Ради этого всё и затевалось: исполнителю больше незачем открывать
    // бэклог, а значит нечему и разойтись с ним.
    const io = fakeIo({
      tasks: [task(), task({ id: '0002-two', status: 'review', title: 'вторая' })],
    });
    io.appendJournal('0001-one', '## что решили прежде');
    await execute([startAction], io);

    const brief = io.briefs.get('worker');
    expect(brief.task).toMatchObject({ id: '0001-one', status: 'design' });
    expect(brief.journal).toContain('## что решили прежде');
    expect(brief.board).toContainEqual(
      expect.objectContaining({ id: '0002-two', status: 'review' }),
    );
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

  it('без слота задачу не берут вовсе', async () => {
    // Беда первого живого прогона: сканер выдал восемь действий, слотов было
    // два, а исполнение прошло по всем восьми — потому что действия сканера
    // и раскладку по слотам никто не связывал. Захвачены были все восемь.
    const io = fakeIo();
    const { slot, assignment, ...withoutSlot } = startAction;
    const [result] = await execute([withoutSlot], io);
    expect(result.result).toBe('skipped');
    expect(result.why).toContain('слота нет');
    expect(io.steps).toEqual([]);
    void assignment;
    void slot;
  });

  it('прогону дерево не заводится: арену считает чужое железо', async () => {
    const io = fakeIo({ tasks: [task({ type: 'run', status: 'new' })] });
    await execute([{ ...startAction, stage: 'benchmark' }], io);
    expect(io.steps.filter((step) => step.startsWith('заведено дерево'))).toEqual([]);
    expect(io.steps).toContain('назначение в слот worker');
  });

  it('неудача заведения дерева не выдаётся за успех', async () => {
    const io = fakeIo({ worktree: { ok: false, why: 'каталог занят' } });
    const [result] = await execute([startAction], io);
    expect(result.result).toBe('failed');
    expect(result.why).toContain('каталог занят');
  });
});

describe('перенос отчёта', () => {
  const transfer = {
    kind: 'transfer-report',
    taskId: '0001-one',
    stage: 'design',
    slot: 'worker',
  };

  it('успешный этап двигает задачу и освобождает слот', async () => {
    const io = fakeIo({ tasks: [task({ status: 'design' })] });
    const [result] = await execute([transfer], io);
    expect(result.result).toBe('done');
    expect(io.tasks.get('0001-one').status).toBe('audit');
    expect(io.steps).toContain('слот worker освобождён');
  });

  it('отчёт убирается только после удавшейся отправки', async () => {
    const io = fakeIo({
      tasks: [task({ status: 'design' })],
      push: () => ({ ok: false, outcome: 'rejected' }),
    });
    await execute([transfer], io);
    expect(io.steps.filter((step) => step.includes('отчёт'))).toEqual([]);
    expect(io.steps.filter((step) => step.includes('освобождён'))).toEqual([]);
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

  it('неуспех не обнуляет счётчиков', async () => {
    const io = fakeIo({
      tasks: [task({ status: 'design', attempts: { continuations: 2, cycleFailures: 0 } })],
      report: { taskId: '0001-one', stage: 'design', outcome: 'failed', summary: 'упало' },
    });
    await execute([transfer], io);
    expect(io.tasks.get('0001-one').attempts.continuations).toBe(2);
  });
});

describe('вопрос владельцу продукта', () => {
  const asking = { kind: 'transfer-report', taskId: '0001-one', stage: 'design', slot: 'worker' };

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

describe('продолжение за уснувшей сессией', () => {
  it('счётчик продолжений растёт, назначение уходит в слот', async () => {
    const io = fakeIo({ tasks: [task({ status: 'implement' })] });
    const [result] = await execute(
      [
        {
          kind: 'continue-stage',
          taskId: '0001-one',
          stage: 'implement',
          reason: 'молчит дольше отпущенного',
          slot: 'worker',
          assignment: {},
        },
      ],
      io,
    );
    expect(result.result).toBe('done');
    expect(io.tasks.get('0001-one').attempts.continuations).toBe(1);
    expect(io.steps).toContain('назначение в слот worker');
  });

  it('без слота попытка не тратится и мир не трогается', async () => {
    // Раскладка отказывает, когда прежнее назначение ещё не взято
    // исполнителем. Списать за это попытку было бы вдвойне несправедливо:
    // сессии не было, а счётчик вырос. Их всего две, и после второй задача
    // встаёт и ждёт человека — так и сгорели 0005 и 0006.
    const io = fakeIo({ tasks: [task({ status: 'implement' })] });
    const [result] = await execute(
      [{ kind: 'continue-stage', taskId: '0001-one', stage: 'implement', reason: 'молчит' }],
      io,
    );
    expect(result.result).toBe('skipped');
    expect(io.tasks.get('0001-one').attempts.continuations).toBe(0);
    expect(io.steps).toEqual([]);
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

  it('невлитый pull request останавливает задачу, ничего не удаляя', async () => {
    const io = fakeIo({ tasks: [inCleanup()], pr: { state: 'open' } });
    const [result] = await execute([sweep], io);
    expect(result.result).toBe('done');
    expect(io.tasks.get('0001-one').status).toBe('failed');
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
    expect(born.status).toBe('new');
    expect(born.links.related).toContain('0001-one');
    expect(io.tasks.get('0001-one').links.related).toContain(born.id);
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
