import { describe, expect, it } from 'vitest';
import {
  applyTransition,
  claimTask,
  countContinuation,
  linkArtifact,
  relate,
  releaseClaim,
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
    const tired = task({ attempts: { continuations: 2, cycleFailures: 1 } });
    expect(resetAttempts(tired).attempts).toEqual({ continuations: 0, cycleFailures: 0 });
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

  it('первая запись заводит заголовок, следующая — нет', () => {
    const entry = { at: NOW, from: 'new', to: 'design' };
    const first = journalAppendix(task(), '', entry);
    expect(first).toContain('# 0001-one — Образец');
    expect(journalAppendix(task(), first, entry)).not.toContain('# 0001-one');
  });
});
