import { describe, expect, it } from 'vitest';
import {
  addSpent,
  applyTransition,
  claimTask,
  countContinuation,
  countRejection,
  countApiError,
  countSpawnFailure,
  linkArtifact,
  refundContinuation,
  relate,
  releaseClaim,
  resetApiErrors,
  resetAttempts,
} from './task-file.mjs';
import { journalAppendix, journalEntry } from './journal.mjs';

/**
 * Проверки правки задачи и журнала.
 *
 * Превращение задачи из одного состояния в другое — самое важное, что делает
 * конвейер, и здесь оно проверяется без файлов, git и сессий. Особое внимание
 * тому, что легко потерять молча: чужие поля записи, состояние возврата
 * и счётчики продолжений.
 */

const NOW = '2026-08-26T12:00:00+03:00';

const task = (over = {}) => ({
  id: '0001-one',
  type: 'feature',
  title: 'Образец',
  status: 'design',
  returnTo: null,
  priority: 50,
  createdAt: '2026-08-26T10:00:00+03:00',
  statusChangedAt: '2026-08-26T11:00:00+03:00',
  owner: null,
  history: [],
  links: { change: null, pr: null, run: null, related: [] },
  attempts: { continuations: 0, cycleFailures: 0 },
  ...over,
});

describe('переход состояния', () => {
  it('допустимый переход применяется и попадает в историю', () => {
    const { task: moved, problems } = applyTransition(task(), {
      status: 'audit',
      note: 'проработка закончена',
      now: NOW,
    });
    expect(problems).toEqual([]);
    expect(moved.status).toBe('audit');
    expect(moved.statusChangedAt).toBe(NOW);
    expect(moved.history).toEqual([
      { at: NOW, from: 'design', to: 'audit', note: 'проработка закончена' },
    ]);
  });

  it('недопустимый переход не применяется', () => {
    const { task: moved, problems } = applyTransition(task(), { status: 'deploy', now: NOW });
    expect(moved).toBeNull();
    expect(problems.join()).toContain('«audit»');
  });

  it('чужие поля записи не теряются', () => {
    const source = task({
      links: { change: 'моё-изменение', pr: 50, run: null, related: ['0002'] },
    });
    const { task: moved } = applyTransition(source, { status: 'audit', now: NOW });
    expect(moved.links).toEqual(source.links);
    expect(moved.priority).toBe(50);
    expect(moved.createdAt).toBe(source.createdAt);
  });

  it('сквозное состояние запоминает, откуда задача ушла', () => {
    const { task: moved } = applyTransition(task({ status: 'implement' }), {
      status: 'awaiting-po',
      now: NOW,
    });
    expect(moved.returnTo).toBe('implement');
  });

  it('состояние возврата переживает цепочку сквозных состояний', () => {
    // `implement → postmortem → failed`. Запиши переход покидаемое состояние,
    // и человек, поднимая задачу из ошибки, вернул бы её в разбор.
    const { task: analysed } = applyTransition(task({ status: 'implement' }), {
      status: 'postmortem',
      now: NOW,
    });
    expect(analysed.returnTo).toBe('implement');

    const { task: halted } = applyTransition(analysed, { status: 'failed', now: NOW });
    expect(halted.returnTo).toBe('implement');
  });

  it('вопрос без ответа, упавший в ошибку, помнит рабочее состояние', () => {
    const waiting = task({ status: 'awaiting-po', returnTo: 'design' });
    const { task: halted } = applyTransition(waiting, { status: 'failed', now: NOW });
    expect(halted.returnTo).toBe('design');
  });

  it('вход в сквозное состояние обнуляет счёт попыток', () => {
    // Иначе разбор не начался бы вовсе: задача приходит в него с исчерпанными
    // продолжениями, и сканер объявил бы его провалившимся прежде первой
    // сессии.
    const tired = task({
      status: 'implement',
      attempts: { continuations: 2, cycleFailures: 1, rejections: 3 },
    });
    const { task: analysed } = applyTransition(tired, { status: 'postmortem', now: NOW });
    expect(analysed.attempts).toEqual({
      continuations: 0,
      cycleFailures: 0,
      rejections: 0,
      spawnFailures: 0,
      apiErrors: 0,
    });
  });

  it('вход в разбор стирает вердикт прошлого разбора, но хранит счёт возвратов', () => {
    // Вердикт относится к прошлому падению: задача, упавшая снова и не
    // дождавшаяся нового вердикта, вернулась бы по старому. Счёт же —
    // предохранитель на всю жизнь задачи.
    const judged = task({
      status: 'implement',
      recovery: { causedBy: 'pipeline', fixedBy: ['0091-fix'], returns: 1 },
    });
    const { task: analysed } = applyTransition(judged, { status: 'postmortem', now: NOW });
    expect(analysed.recovery).toEqual({ causedBy: null, fixedBy: [], returns: 1 });
  });

  it('прочие переходы вердикт не трогают, а неразобранной задаче его не заводят', () => {
    const judged = task({
      status: 'failed',
      returnTo: 'implement',
      recovery: { causedBy: 'pipeline', fixedBy: [], returns: 0 },
    });
    const { task: back } = applyTransition(judged, { status: 'implement', now: NOW });
    expect(back.recovery).toEqual(judged.recovery);

    const { task: fresh } = applyTransition(task({ status: 'implement' }), {
      status: 'postmortem',
      now: NOW,
    });
    expect(fresh).not.toHaveProperty('recovery');
  });

  it('сброс попыток счёт возвратов не трогает', () => {
    const judged = task({ recovery: { causedBy: null, fixedBy: [], returns: 2 } });
    expect(resetAttempts(judged).recovery).toEqual(judged.recovery);
  });

  it('переход по маршруту счёт попыток не трогает', () => {
    // Обнуляет его успешный этап отдельным действием, и правило это здесь
    // не дублируется: два места, гасящие один счётчик, однажды разойдутся.
    const tired = task({ status: 'design', attempts: { continuations: 1, cycleFailures: 0 } });
    const { task: moved } = applyTransition(tired, { status: 'audit', now: NOW });
    expect(moved.attempts.continuations).toBe(1);
  });

  it('рабочее состояние состояния возврата не хранит', () => {
    const waiting = task({ status: 'awaiting-po', returnTo: 'design' });
    const { task: moved } = applyTransition(waiting, { status: 'design', now: NOW });
    expect(moved.returnTo).toBeNull();
  });

  it('история не растёт без предела', () => {
    const long = task({
      history: Array.from({ length: 100 }, (_, index) => ({
        at: NOW,
        from: 'a',
        to: `шаг-${index}`,
      })),
    });
    const { task: moved } = applyTransition(long, { status: 'audit', now: NOW });
    expect(moved.history).toHaveLength(100);
    expect(moved.history.at(-1).to).toBe('audit');
  });
});

describe('захват задачи', () => {
  it('свободная задача захватывается', () => {
    const { task: claimed } = claimTask(task({ status: 'new' }), {
      machine: 'станция-1',
      status: 'design',
      now: NOW,
    });
    expect(claimed.owner).toBe('станция-1');
    expect(claimed.status).toBe('design');
  });

  it('занятая чужой машиной не захватывается', () => {
    const { task: claimed, problems } = claimTask(task({ status: 'new', owner: 'станция-2' }), {
      machine: 'станция-1',
      status: 'design',
      now: NOW,
    });
    expect(claimed).toBeNull();
    expect(problems.join()).toContain('станция-2');
  });

  it('снятие захвата освобождает задачу', () => {
    expect(releaseClaim(task({ owner: 'станция-1' })).owner).toBeNull();
  });
});

describe('счётчики', () => {
  it('продолжение считается', () => {
    expect(countContinuation(task()).attempts.continuations).toBe(1);
  });

  it('дошедший до конца этап сбрасывает счётчики', () => {
    const tired = task({
      attempts: { continuations: 2, cycleFailures: 1, rejections: 2, spawnFailures: 2 },
    });
    expect(resetAttempts(tired).attempts).toEqual({
      continuations: 0,
      cycleFailures: 0,
      rejections: 0,
      spawnFailures: 0,
      apiErrors: 0,
    });
  });

  it('несостоявшийся запуск считается', () => {
    expect(countSpawnFailure(task()).attempts.spawnFailures).toBe(1);
    expect(countSpawnFailure(countSpawnFailure(task())).attempts.spawnFailures).toBe(2);
  });

  it('счёт несостоявшихся запусков не трогает счёт продолжений', () => {
    // Продолжение платит за сессию, которая была и не справилась,
    // а несостоявшийся запуск — за сессию, которой не было вовсе.
    // Общий счётчик увёл бы разбор искать причину не там.
    const counted = countSpawnFailure(task({ attempts: { continuations: 1, cycleFailures: 0 } }));
    expect(counted.attempts.continuations).toBe(1);
  });

  it('возврат проверяющего этапа считается', () => {
    expect(countRejection(task()).attempts.rejections).toBe(1);
    const again = countRejection(countRejection(task()));
    expect(again.attempts.rejections).toBe(2);
  });

  it('возврат гасит счёт продолжений, сохраняя счёт возвратов', () => {
    // Продолжения считают сессии на этапе, а возврат уводит задачу на другой
    // этап. Счёт, притащенный с аудита, останавливал проработку, не дав ей
    // ни одной сессии: так 02.09.2026 легли 0022, 0080 и 0088.
    const counted = countRejection(
      task({ attempts: { continuations: 2, cycleFailures: 1, spawnFailures: 1, rejections: 1 } }),
    );
    expect(counted.attempts).toEqual({
      continuations: 0,
      cycleFailures: 0,
      spawnFailures: 0,
      apiErrors: 0,
      rejections: 2,
    });
  });

  it('отказ сервера возвращает потраченное продолжение', () => {
    // Процесс родился и умер, не сделав ни одного хода: платить за это
    // задаче нечем и незачем. 03.09.2026 так пропали все продолжения
    // у 0153 и 0165.
    const spent = task({ attempts: { continuations: 1, cycleFailures: 0 } });
    expect(refundContinuation(spent).attempts.continuations).toBe(0);
  });

  it('возврат продолжения не уводит счёт ниже нуля', () => {
    // Задача, взятая из очереди впервые, продолжений не тратила, а первый
    // же её этап может лечь на 529. Отрицательный счёт дал бы ей лишнюю
    // попытку в обход предела.
    expect(refundContinuation(task()).attempts.continuations).toBe(0);
  });

  it('отказы сервера считаются своим счётом и гасятся живым ответом', () => {
    const once = countApiError(task());
    expect(once.attempts.apiErrors).toBe(1);
    expect(countApiError(once).attempts.apiErrors).toBe(2);
    // Без гашения счёт копится за сутки и взводит паузу по картине,
    // которой не было: три отказа, разделённые часами работы.
    expect(resetApiErrors(countApiError(once)).attempts.apiErrors).toBe(0);
  });

  it('расход прибавляется и не бывает отрицательным', () => {
    expect(addSpent(task(), 3.25).spentUsd).toBe(3.25);
    expect(addSpent(addSpent(task(), 3.25), 1.75).spentUsd).toBe(5);
    // Стоимость бывает не названа вовсе; вычесть из расхода нельзя ничем.
    expect(addSpent(task(), undefined).spentUsd).toBe(0);
    expect(addSpent(addSpent(task(), 2), -5).spentUsd).toBe(2);
  });

  it('дошедший до конца этап расхода НЕ обнуляет', () => {
    // Главная проба всего изменения. Предел спора умер оттого, что его
    // счётчик гасился удачным отчётом между отказами (задача 0216).
    // Расход обязан пережить и это, и вход в сквозное состояние.
    const spent = addSpent(task(), 12.5);
    expect(resetAttempts(spent).spentUsd).toBe(12.5);
  });

  it('вход в сквозное состояние расхода не обнуляет', () => {
    const spent = addSpent(task({ status: 'implement' }), 12.5);
    const { task: analysed } = applyTransition(spent, { status: 'postmortem', now: NOW });
    expect(analysed.spentUsd).toBe(12.5);
  });

  it('счёт отказов сервера не трогает счёт продолжений', () => {
    const counted = countApiError(task({ attempts: { continuations: 1, cycleFailures: 0 } }));
    expect(counted.attempts.continuations).toBe(1);
  });
});

describe('ссылки и связи', () => {
  it('ссылка на артефакт не затирает соседние', () => {
    const linked = linkArtifact(
      task({ links: { change: 'моё', pr: null, run: null, related: [] } }),
      'pr',
      50,
    );
    expect(linked.links).toEqual({ change: 'моё', pr: 50, run: null, related: [] });
  });

  it('связь заводится один раз', () => {
    const once = relate(task(), '0002-two');
    expect(relate(once, '0002-two').links.related).toEqual(['0002-two']);
  });
});

describe('журнал', () => {
  it('запись отвечает на «что сделано и почему»', () => {
    const text = journalEntry({
      at: NOW,
      from: 'design',
      to: 'audit',
      what: 'Создано изменение OpenSpec со всеми обязательными артефактами.',
      decisions: ['Бэклог разложен по файлам, потому что единый список конфликтует.'],
      links: { change: 'agent-backlog-pipeline', pr: null },
    });
    expect(text).toContain('## 2026-08-26T12:00:00+03:00 · design → audit');
    expect(text).toContain('**Решения:**');
    expect(text).toContain('change: agent-backlog-pipeline');
    expect(text).not.toContain('pr:'); // пустых ссылок в журнале нет
  });

  it('неудача названа отдельно', () => {
    const text = journalEntry({
      at: NOW,
      from: 'implement',
      to: 'failed',
      problem: 'сборка упала',
    });
    expect(text).toContain('**Не удалось:** сборка упала');
  });

  it('шапка отделена от первой записи пустой строкой', () => {
    // Иначе заголовок журнала слипается с первой записью, и разметка
    // разъезжается ровно в том файле, который читают глазами.
    const text = journalAppendix(task(), '', { at: NOW, from: 'new', to: 'design' });
    expect(text).toContain('\n\n## ');
  });

  it('первая запись заводит заголовок, следующая — нет', () => {
    const entry = { at: NOW, from: 'new', to: 'design' };
    const first = journalAppendix(task(), '', entry);
    expect(first).toContain('# 0001-one — Образец');
    expect(journalAppendix(task(), first, entry)).not.toContain('# 0001-one');
  });
});

describe('отказанные действия в журнале задачи', () => {
  // Журнал задачи уезжает в промпт следующей сессии, а журнал цикла
  // не уезжает никуда: отказ, названный только там, для работы невидим.
  const denials = [
    { tool_name: 'PowerShell', tool_input: { command: 'Remove-Item -Recurse .matchlog/run-42' } },
    { tool_name: 'Glob', tool_input: { pattern: '~/Downloads/*.mp3' } },
  ];

  it('оба отказа названы с доводами вызова', () => {
    const text = journalEntry({ at: NOW, from: 'benchmark', to: 'interpret', denials });
    expect(text).toContain('**Отказано в действиях:**');
    expect(text).toContain('- PowerShell: Remove-Item -Recurse .matchlog/run-42');
    expect(text).toContain('- Glob: {"pattern":"~/Downloads/*.mp3"}');
  });

  it('без отказов раздела нет вовсе', () => {
    const text = journalEntry({ at: NOW, from: 'design', to: 'audit', what: 'сделано' });
    expect(text).not.toContain('Отказано в действиях');
  });

  it('отметка «сверять нечем» стоит строкой в том же разделе', () => {
    const text = journalEntry({
      at: NOW,
      from: 'deploy',
      to: 'cleanup',
      denials,
      denialsNote: 'сопоставить отказ с делом нечем: проверяемого следа у этапа нет',
    });
    expect(text).toContain('- сопоставить отказ с делом нечем');
  });

  it('одна отметка без отказов раздела не заводит', () => {
    // Отметка объясняет отказ, а не заменяет его: без отказов объяснять нечего.
    const text = journalEntry({ at: NOW, from: 'deploy', to: 'cleanup', denialsNote: 'нечем' });
    expect(text).not.toContain('Отказано в действиях');
  });
});
