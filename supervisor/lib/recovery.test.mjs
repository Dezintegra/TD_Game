import { describe, expect, it } from 'vitest';
import { pipelineCause, recoveryFrom } from './recovery.mjs';

/**
 * Проверки вердикта разбора.
 *
 * Главное здесь — строгость и связывание. Вердикт приходит из отчёта
 * сессии, то есть из недоверенного места, и правдоподобное значение
 * не должно тихо вернуть задачу в работу. А идентификаторов собственных
 * заявок разбор знать не может — их подставляет перенос, и проверить,
 * что они доехали, можно только здесь.
 */

const task = (over = {}) => ({ id: '0041-one', status: 'failed', ...over });
const known = ['0041-one', '0084-pnpm', '0088-perms'];

describe('чья причина', () => {
  it('причина в задаче даёт вердикт без починок и без возврата', () => {
    const { recovery, notes } = recoveryFrom({ causedBy: 'task' }, { task: task(), known });
    expect(recovery).toEqual({ causedBy: 'task', fixedBy: [], returns: 0 });
    expect(notes).toEqual([]);
  });

  it('вердикт проходит только точным словом', () => {
    // Отчёт не отвергается — разбор в нём есть, — но и не возвращает:
    // цена ошибки разбора здесь ручной подъём, как прежде, а не лишние сессии.
    for (const value of ['Pipeline', 'конвейер', true, 1, undefined, null]) {
      const { recovery, notes } = recoveryFrom(
        { causedBy: value, fixedBy: ['0084-pnpm'] },
        { task: task(), known },
      );
      expect(recovery, JSON.stringify(value)).toEqual({ causedBy: null, fixedBy: [], returns: 0 });
      expect(notes.join(), JSON.stringify(value)).toContain('не назвал причину');
    }
  });

  it('признак конвейерной причины читается из отчёта', () => {
    expect(pipelineCause({ causedBy: 'pipeline' })).toBe(true);
    expect(pipelineCause({ causedBy: 'task' })).toBe(false);
    expect(pipelineCause(undefined)).toBe(false);
  });
});

describe('чем чинится', () => {
  it('заведённые по отчёту конвейерные задачи подставляются в fixedBy', () => {
    const { recovery } = recoveryFrom(
      { causedBy: 'pipeline' },
      { task: task(), created: ['0091-fix'], known },
    );
    expect(recovery).toEqual({ causedBy: 'pipeline', fixedBy: ['0091-fix'], returns: 0 });
  });

  it('названные разбором задачи с описи добавляются к заведённым без повторов', () => {
    const { recovery, notes } = recoveryFrom(
      { causedBy: 'pipeline', fixedBy: ['0084-pnpm', '0091-fix', '0084-pnpm'] },
      { task: task(), created: ['0091-fix'], known: [...known, '0091-fix'] },
    );
    expect(recovery.fixedBy).toEqual(['0091-fix', '0084-pnpm']);
    expect(notes).toEqual([]);
  });

  it('задача, которой нет на доске, отбрасывается с причиной', () => {
    // Иначе её ждали бы вечно: задача, которой нет, никогда не закроется.
    const { recovery, notes } = recoveryFrom(
      { causedBy: 'pipeline', fixedBy: ['0084-pnpm', '0999-nowhere', '', 7] },
      { task: task(), known },
    );
    expect(recovery.fixedBy).toEqual(['0084-pnpm']);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('0999-nowhere');
    expect(notes[1]).toContain('7');
  });

  it('сама себя задача не ждёт', () => {
    const { recovery, notes } = recoveryFrom(
      { causedBy: 'pipeline', fixedBy: ['0041-one'] },
      { task: task(), known },
    );
    expect(recovery.fixedBy).toEqual([]);
    expect(notes.join()).toContain('сама задача');
  });

  it('fixedBy не перечнем отбрасывается целиком с причиной', () => {
    const { recovery, notes } = recoveryFrom(
      { causedBy: 'pipeline', fixedBy: '0084-pnpm' },
      { task: task(), known },
    );
    expect(recovery.fixedBy).toEqual([]);
    expect(notes.join()).toContain('не перечень');
  });

  it('пустой fixedBy — это «вернуть сразу», а не ошибка', () => {
    const { recovery, notes } = recoveryFrom({ causedBy: 'pipeline' }, { task: task(), known });
    expect(recovery).toEqual({ causedBy: 'pipeline', fixedBy: [], returns: 0 });
    expect(notes).toEqual([]);
  });
});

describe('предохранитель', () => {
  it('счёт возвратов переносится из прежнего вердикта', () => {
    const judged = task({ recovery: { causedBy: null, fixedBy: [], returns: 1 } });
    const { recovery } = recoveryFrom({ causedBy: 'pipeline' }, { task: judged, maxReturns: 2 });
    expect(recovery.returns).toBe(1);
    expect(recovery.causedBy).toBe('pipeline');
  });

  it('на пределе вердикт не записывается, а журнал зовёт человека', () => {
    // Третье падение подряд по «вине конвейера» говорит, что дело не в нём.
    // Запись делается здесь один раз, а не сканером каждый оборот.
    const judged = task({ recovery: { causedBy: null, fixedBy: [], returns: 2 } });
    const { recovery, notes } = recoveryFrom(
      { causedBy: 'pipeline', fixedBy: ['0084-pnpm'] },
      { task: judged, created: ['0091-fix'], known, maxReturns: 2 },
    );
    expect(recovery).toEqual({ causedBy: null, fixedBy: [], returns: 2 });
    expect(notes.join()).toContain('возвращалась дважды, дальше человек');
  });

  it('без предела возвращать можно сколько угодно', () => {
    const judged = task({ recovery: { causedBy: null, fixedBy: [], returns: 5 } });
    const { recovery } = recoveryFrom({ causedBy: 'pipeline' }, { task: judged });
    expect(recovery.causedBy).toBe('pipeline');
  });
});
