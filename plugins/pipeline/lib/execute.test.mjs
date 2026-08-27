import { describe, expect, it } from 'vitest';
import { execute } from './execute.mjs';

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
  const journals = new Map();

  const io = {
    now: NOW,
    machine: 'станция-1',
    steps,
    tasks,
    slots,
    journals,

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

    commitAndPush(paths, message) {
      steps.push(`коммит и отправка: ${message} [${paths.length} путей]`);
      return over.push ? over.push(steps) : { ok: true, outcome: 'pushed' };
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
    clearSlot(slot) {
      steps.push(`слот ${slot} освобождён`);
      slots.delete(slot);
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
  slot: 'worker-1',
  assignment: { taskId: '0001-one', stage: 'design' },
};

describe('взятие задачи в работу', () => {
  it('захват отправляется раньше заведения дерева', () => {
    const io = fakeIo();
    execute([startAction], io);

    const push = io.steps.findIndex((step) => step.startsWith('коммит и отправка'));
    const tree = io.steps.findIndex((step) => step.startsWith('заведено дерево'));
    expect(push).toBeGreaterThanOrEqual(0);
    expect(tree).toBeGreaterThan(push);
  });

  it('после захвата задача помечена машиной и переведена в этап', () => {
    const io = fakeIo();
    const [result] = execute([startAction], io);
    expect(result.result).toBe('done');
    expect(io.tasks.get('0001-one')).toMatchObject({ owner: 'станция-1', status: 'design' });
  });

  it('назначение попадает в слот последним', () => {
    const io = fakeIo();
    execute([startAction], io);
    expect(io.steps.at(-1)).toBe('назначение в слот worker-1');
  });

  it('занятая чужой машиной задача не берётся и мир не трогается', () => {
    const io = fakeIo({ tasks: [task({ owner: 'станция-2' })] });
    const [result] = execute([startAction], io);
    expect(result.result).toBe('raced');
    expect(io.steps.filter((step) => step.startsWith('заведено дерево'))).toEqual([]);
  });

  it('неудачная отправка снимает свой захват и дерева не заводит', () => {
    const io = fakeIo({ push: () => ({ ok: false, outcome: 'rejected' }) });
    const [result] = execute([startAction], io);
    expect(result.result).toBe('failed');
    expect(io.tasks.get('0001-one').owner).toBeNull();
    expect(io.steps.filter((step) => step.startsWith('заведено дерево'))).toEqual([]);
  });

  it('без слота задачу не берут вовсе', () => {
    // Беда первого живого прогона: сканер выдал восемь действий, слотов было
    // два, а исполнение прошло по всем восьми — потому что действия сканера
    // и раскладку по слотам никто не связывал. Захвачены были все восемь.
    const io = fakeIo();
    const { slot, assignment, ...withoutSlot } = startAction;
    const [result] = execute([withoutSlot], io);
    expect(result.result).toBe('skipped');
    expect(result.why).toContain('слота нет');
    expect(io.steps).toEqual([]);
    void assignment;
    void slot;
  });

  it('прогону дерево не заводится: арену считает чужое железо', () => {
    const io = fakeIo({ tasks: [task({ type: 'run', status: 'new' })] });
    execute([{ ...startAction, stage: 'benchmark' }], io);
    expect(io.steps.filter((step) => step.startsWith('заведено дерево'))).toEqual([]);
    expect(io.steps).toContain('назначение в слот worker-1');
  });

  it('неудача заведения дерева не выдаётся за успех', () => {
    const io = fakeIo({ worktree: { ok: false, why: 'каталог занят' } });
    const [result] = execute([startAction], io);
    expect(result.result).toBe('failed');
    expect(result.why).toContain('каталог занят');
  });
});

describe('перенос отчёта', () => {
  const transfer = {
    kind: 'transfer-report',
    taskId: '0001-one',
    stage: 'design',
    slot: 'worker-1',
  };

  it('успешный этап двигает задачу и освобождает слот', () => {
    const io = fakeIo({ tasks: [task({ status: 'design' })] });
    const [result] = execute([transfer], io);
    expect(result.result).toBe('done');
    expect(io.tasks.get('0001-one').status).toBe('audit');
    expect(io.steps).toContain('слот worker-1 освобождён');
  });

  it('отчёт убирается только после удавшейся отправки', () => {
    const io = fakeIo({
      tasks: [task({ status: 'design' })],
      push: () => ({ ok: false, outcome: 'rejected' }),
    });
    execute([transfer], io);
    expect(io.steps.filter((step) => step.includes('отчёт'))).toEqual([]);
    expect(io.steps.filter((step) => step.includes('освобождён'))).toEqual([]);
  });

  it('дошедший до конца этап обнуляет счётчик продолжений', () => {
    const io = fakeIo({
      tasks: [task({ status: 'design', attempts: { continuations: 2, cycleFailures: 0 } })],
    });
    execute([transfer], io);
    expect(io.tasks.get('0001-one').attempts.continuations).toBe(0);
  });

  it('вопрос владельцу продукта сохраняет состояние возврата', () => {
    const io = fakeIo({
      tasks: [task({ status: 'design' })],
      report: {
        taskId: '0001-one',
        stage: 'design',
        outcome: 'question',
        summary: 'два прочтения',
      },
    });
    execute([transfer], io);
    expect(io.tasks.get('0001-one')).toMatchObject({ status: 'awaiting-po', returnTo: 'design' });
  });

  it('номер pull request из отчёта попадает в саму задачу', () => {
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
    execute([{ kind: 'transfer-report', taskId: '0001-one', stage: 'implement' }], io);
    expect(io.tasks.get('0001-one').links).toMatchObject({ pr: 51, change: 'моё-изменение' });
  });

  it('пустые ссылки отчёта не затирают уже известные', () => {
    const io = fakeIo({
      tasks: [
        task({ status: 'design', links: { change: 'старое', pr: 7, run: null, related: [] } }),
      ],
      report: { taskId: '0001-one', stage: 'design', outcome: 'done', links: { pr: null } },
    });
    execute([{ kind: 'transfer-report', taskId: '0001-one', stage: 'design' }], io);
    expect(io.tasks.get('0001-one').links.pr).toBe(7);
  });

  it('неуспех не обнуляет счётчиков', () => {
    const io = fakeIo({
      tasks: [task({ status: 'design', attempts: { continuations: 2, cycleFailures: 0 } })],
      report: { taskId: '0001-one', stage: 'design', outcome: 'failed', summary: 'упало' },
    });
    execute([transfer], io);
    expect(io.tasks.get('0001-one').attempts.continuations).toBe(2);
  });
});

describe('продолжение за уснувшей сессией', () => {
  it('счётчик продолжений растёт, назначение уходит в слот', () => {
    const io = fakeIo({ tasks: [task({ status: 'implement' })] });
    const [result] = execute(
      [
        {
          kind: 'continue-stage',
          taskId: '0001-one',
          stage: 'implement',
          reason: 'молчит дольше отпущенного',
          slot: 'worker-1',
          assignment: {},
        },
      ],
      io,
    );
    expect(result.result).toBe('done');
    expect(io.tasks.get('0001-one').attempts.continuations).toBe(1);
    expect(io.steps).toContain('назначение в слот worker-1');
  });
});

describe('внешнее состояние', () => {
  const poll = { kind: 'poll-external', taskId: '0001-one', what: 'ci' };

  it('зелёные проверки открывают ревью', () => {
    const io = fakeIo({ tasks: [task({ status: 'pr' })], external: { state: 'success' } });
    execute([poll], io);
    expect(io.tasks.get('0001-one').status).toBe('review');
  });

  it('идущие проверки ничего не пишут', () => {
    const io = fakeIo({ tasks: [task({ status: 'pr' })], external: { state: 'pending' } });
    const [result] = execute([poll], io);
    expect(result.result).toBe('skipped');
    expect(io.steps).toEqual([]);
  });

  it('красные проверки отправляют в доработку', () => {
    const io = fakeIo({
      tasks: [task({ status: 'pr' })],
      external: { state: 'failure', failed: 'матчевые тесты' },
    });
    execute([poll], io);
    expect(io.tasks.get('0001-one').status).toBe('revise');
    expect(io.journals.get('0001-one')).toContain('матчевые тесты');
  });
});

describe('ответ владельца продукта', () => {
  it('возвращает задачу туда, откуда она ушла', () => {
    const io = fakeIo({ tasks: [task({ status: 'awaiting-po', returnTo: 'design' })] });
    const [result] = execute([{ kind: 'answer-question', taskId: '0001-one' }], io);
    expect(result.result).toBe('done');
    expect(io.tasks.get('0001-one').status).toBe('design');
    expect(io.journals.get('0001-one')).toContain('вариант А');
  });

  it('без состояния возврата задача не двигается', () => {
    const io = fakeIo({ tasks: [task({ status: 'awaiting-po', returnTo: null })] });
    const [result] = execute([{ kind: 'answer-question', taskId: '0001-one' }], io);
    expect(result.result).toBe('failed');
  });
});

describe('уборка', () => {
  const sweep = { kind: 'cleanup', taskId: '0001-one' };
  const inCleanup = () =>
    task({ status: 'cleanup', links: { change: null, pr: 50, run: null, related: [] } });

  it('влитый pull request даёт убрать и закрыть задачу', () => {
    const io = fakeIo({ tasks: [inCleanup()], pr: { state: 'merged' } });
    const [result] = execute([sweep], io);
    expect(result.result).toBe('done');
    expect(io.tasks.get('0001-one').status).toBe('closed');
    expect(io.steps).toContain('запись реестра 0001-one снята');
  });

  it('невлитый pull request останавливает задачу, ничего не удаляя', () => {
    const io = fakeIo({ tasks: [inCleanup()], pr: { state: 'open' } });
    const [result] = execute([sweep], io);
    expect(result.result).toBe('done');
    expect(io.tasks.get('0001-one').status).toBe('failed');
    expect(io.steps).not.toContain('запись реестра 0001-one снята');
  });

  it('занятый каталог оставляет задачу в уборке до следующего цикла', () => {
    const io = fakeIo({
      tasks: [inCleanup()],
      pr: { state: 'merged' },
      worktreeRemoval: { ok: false, why: 'каталог занят' },
    });
    const [result] = execute([sweep], io);
    expect(result.result).toBe('skipped');
    expect(io.tasks.get('0001-one').status).toBe('cleanup');
  });
});

describe('заявки на новые задачи', () => {
  const triage = { kind: 'transfer-report', taskId: '0001-one', stage: 'triage' };
  const note = () => task({ type: 'note', status: 'triage' });

  it('заявка превращается в задачу, связанную с породившей', () => {
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
    const [result] = execute([triage], io);
    expect(result.result).toBe('done');
    expect(result.created).toHaveLength(1);

    const born = io.tasks.get(result.created[0]);
    expect(born.type).toBe('feature');
    expect(born.status).toBe('new');
    expect(born.links.related).toContain('0001-one');
    expect(io.tasks.get('0001-one').links.related).toContain(born.id);
  });

  it('каждая порождённая задача уезжает своим коммитом', () => {
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
    execute([triage], io);
    const commits = io.steps.filter((step) => step.startsWith('коммит и отправка'));
    expect(commits).toHaveLength(3); // состояние породившей плюс две задачи
  });

  it('негодная заявка отклоняется, годная заводится', () => {
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
    const [result] = execute([triage], io);
    expect(result.created).toHaveLength(1);
    expect(io.journals.get('0001-one')).toContain('заявка отклонена');
  });

  it('без заявок ничего лишнего не заводится', () => {
    const io = fakeIo({ tasks: [note()] });
    const [result] = execute([triage], io);
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

  it('досылается из собственного дерева задачи', () => {
    const io = fakeIo();
    const [result] = execute([tail], io);
    expect(result.result).toBe('done');
    expect(io.steps).toContain('дослан хвост worktree-0001-one из .claude/worktrees/0001-one');
  });

  it('хвост главной ветки здесь не обрабатывают', () => {
    const io = fakeIo();
    const [result] = execute([{ kind: 'push-tail', scope: 'main', commits: 1 }], io);
    expect(result.result).toBe('skipped');
  });

  it('неудача досылки не выдаётся за успех', () => {
    const io = fakeIo({ branchPush: { ok: false, why: 'ветка ушла вперёд' } });
    const [result] = execute([tail], io);
    expect(result.result).toBe('failed');
    expect(result.why).toContain('ушла вперёд');
  });
});

describe('пропавшая сеть', () => {
  it('останавливает исполнение, а не перебирает остальные действия', () => {
    const io = fakeIo({
      tasks: [task({ status: 'design' }), task({ id: '0002-two', status: 'design' })],
      push: () => ({ ok: false, outcome: 'offline' }),
    });
    const results = execute(
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
