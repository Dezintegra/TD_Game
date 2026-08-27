import { describe, expect, it } from 'vitest';
import { buildSnapshot, extractSessions } from './snapshot.mjs';

/**
 * Проверки сборки снимка сессий.
 *
 * Снимок решает, жива сессия или пора слать продолжателя, поэтому главное
 * здесь — не «разобрали ли мы ответ», а «не выдали ли пустоту за правду».
 * Пустой снимок означает «о живости исполнителей ничего не известно»,
 * и продолжателей по нему не назначают вовсе.
 */

const session = (over = {}) => ({
  title: 'pipeline:0001-one:design',
  isRunning: true,
  lastActivityAt: '2026-08-27T12:00:00+03:00',
  ...over,
});

describe('форма ответа', () => {
  it('голый массив', () => {
    expect(extractSessions([session()])).toHaveLength(1);
  });

  it('обёртка sessions', () => {
    expect(extractSessions({ sessions: [session()] })).toHaveLength(1);
  });

  it('обёртка result', () => {
    expect(extractSessions({ result: [session()] })).toHaveLength(1);
  });

  it('незнакомая форма — не массив, а отказ', () => {
    expect(extractSessions({ что: 'то' })).toBeNull();
    expect(extractSessions('строка')).toBeNull();
  });
});

describe('сборка снимка', () => {
  it('остаются только нужные поля', () => {
    const { snapshot } = buildSnapshot([session({ лишнее: 'выкинуть', id: 42 })]);
    expect(snapshot.sessions[0]).toEqual({
      title: 'pipeline:0001-one:design',
      isRunning: true,
      lastActivityAt: '2026-08-27T12:00:00+03:00',
    });
  });

  it('идущесть приводится к строгому да или нет', () => {
    // Иначе «идёт» окажется истиной от любой непустой строки, и умершая
    // сессия будет считаться живой вечно.
    const { snapshot } = buildSnapshot([session({ isRunning: 'да' }), session({ isRunning: 1 })]);
    expect(snapshot.sessions.map((item) => item.isRunning)).toEqual([false, false]);
  });

  it('сессия без заголовка отбрасывается', () => {
    // По заголовку оркестратор сопоставляет сессию с задачей; безымянная
    // не сопоставится ни с чем и только замусорит снимок.
    const { snapshot } = buildSnapshot([session(), { isRunning: true }]);
    expect(snapshot.sessions).toHaveLength(1);
  });

  it('отсутствующая отметка времени становится пустотой, а не выдумкой', () => {
    const { snapshot } = buildSnapshot([session({ lastActivityAt: undefined })]);
    expect(snapshot.sessions[0].lastActivityAt).toBeNull();
  });
});

describe('отказы', () => {
  it('незнакомая форма ответа — снимок не собран', () => {
    const { snapshot, problem } = buildSnapshot({ что: 'то' });
    expect(snapshot).toBeNull();
    expect(problem).toContain('нет перечня сессий');
  });

  it('пустой перечень — снимок не собран', () => {
    // Сама читающая сессия в списке есть всегда, поэтому пустота означает
    // не «сессий нет», а «разобран не тот ответ». Записать её значило бы
    // сказать сканеру, что о живости исполнителей ничего не известно.
    const { snapshot, problem } = buildSnapshot([]);
    expect(snapshot).toBeNull();
    expect(problem).toContain('не тот ответ');
  });

  it('перечень из одних безымянных — тоже отказ', () => {
    expect(buildSnapshot([{ isRunning: true }]).snapshot).toBeNull();
  });
});
