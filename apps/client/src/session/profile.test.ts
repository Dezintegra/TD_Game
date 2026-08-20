import { describe, expect, it } from 'vitest';
import { cookieValue, createProfileId, parseProfile, serializeProfile } from './profile.js';

/**
 * Проверка самого имени живёт в `@td/shared` и покрыта там же:
 * то же правило применяет сервер. Здесь — только куки.
 */
describe('разбор профиля из куки', () => {
  it('читает то, что сам записал', () => {
    const profile = { id: 'abc-123', name: 'Иван' };
    expect(parseProfile(serializeProfile(profile))).toEqual(profile);
  });

  it('переживает имя со знаками, требующими кодирования', () => {
    // Точка с запятой — разделитель кук. Незакодированная, она разорвала бы
    // строку, и профиль читался бы обрезанным.
    const profile = { id: 'abc-123', name: 'Иван; Пётр' };
    expect(parseProfile(serializeProfile(profile))).toEqual(profile);
  });

  it('считает отсутствующую куку отсутствием профиля', () => {
    expect(parseProfile(undefined)).toBeNull();
    expect(parseProfile('')).toBeNull();
  });

  it('считает неразбираемое содержимое отсутствием профиля', () => {
    expect(parseProfile('%7Bне json')).toBeNull();
  });

  it('не принимает запись без идентификатора', () => {
    expect(parseProfile(encodeURIComponent(JSON.stringify({ name: 'Иван' })))).toBeNull();
  });

  it('не принимает запись без имени', () => {
    expect(parseProfile(encodeURIComponent(JSON.stringify({ id: 'abc' })))).toBeNull();
  });

  it('не принимает запись с непроходящим проверку именем', () => {
    // Куку правят руками. Имя из неё обязано пройти ту же проверку,
    // что и введённое в форме, иначе в списке комнат окажется пустая строка.
    const forged = encodeURIComponent(JSON.stringify({ id: 'abc', name: '   ' }));
    expect(parseProfile(forged)).toBeNull();
  });

  it('не бросает исключений ни на каком вводе', () => {
    for (const raw of ['null', '[]', '"строка"', '%', '{%7D', '{"id":42,"name":7}']) {
      expect(() => parseProfile(raw)).not.toThrow();
      expect(parseProfile(raw)).toBeNull();
    }
  });
});

describe('чтение значения из строки кук', () => {
  it('находит нужную куку среди прочих', () => {
    expect(cookieValue('a=1; td_profile=xyz; b=2', 'td_profile')).toBe('xyz');
  });

  it('не путает куку с той, чьё имя начинается так же', () => {
    expect(cookieValue('td_profile_old=нет; td_profile=да', 'td_profile')).toBe('да');
  });

  it('сохраняет знаки равенства внутри значения', () => {
    expect(cookieValue('td_profile=a=b=c', 'td_profile')).toBe('a=b=c');
  });

  it('возвращает undefined, когда куки нет', () => {
    expect(cookieValue('a=1; b=2', 'td_profile')).toBeUndefined();
    expect(cookieValue('', 'td_profile')).toBeUndefined();
  });
});

describe('выдача идентификатора', () => {
  it('выдаёт непустые и разные идентификаторы', () => {
    const first = createProfileId();
    const second = createProfileId();

    expect(first.length).toBeGreaterThan(0);
    expect(second).not.toBe(first);
  });
});
