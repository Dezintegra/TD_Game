import { describe, expect, it } from 'vitest';
import { NAME_MAX_LENGTH, NAME_MIN_LENGTH, NameError, checkName } from './player.js';

describe('проверка имени игрока', () => {
  it('отсекает пробелы по краям и сохраняет внутренние', () => {
    expect(checkName('  Иван Петров  ')).toEqual({ ok: true, name: 'Иван Петров' });
  });

  it('не принимает пустое поле', () => {
    expect(checkName('')).toEqual({ ok: false, error: NameError.Empty });
  });

  it('не принимает поле из одних пробелов', () => {
    // Для игрока это то же самое, что пустое поле: он не набрал ничего.
    expect(checkName('   ')).toEqual({ ok: false, error: NameError.Empty });
  });

  it('различает пустое и слишком короткое', () => {
    // Одна проверка — одна причина: не набравший ничего и набравший
    // одну букву должны прочитать разное.
    expect(checkName('я')).toEqual({ ok: false, error: NameError.TooShort });
  });

  it('не принимает имя длиннее предела', () => {
    expect(checkName('а'.repeat(NAME_MAX_LENGTH + 1))).toEqual({
      ok: false,
      error: NameError.TooLong,
    });
  });

  it('принимает имя ровно предельной длины', () => {
    // Границы включительные: предел — допустимая длина, а не первая
    // недопустимая. Ошибка на единицу здесь тиха и живёт годами.
    const longest = 'а'.repeat(NAME_MAX_LENGTH);
    expect(checkName(longest)).toEqual({ ok: true, name: longest });

    const shortest = 'а'.repeat(NAME_MIN_LENGTH);
    expect(checkName(shortest)).toEqual({ ok: true, name: shortest });
  });

  it('не приводит регистр и не заменяет символы', () => {
    expect(checkName('иВаН-42_ok')).toEqual({ ok: true, name: 'иВаН-42_ok' });
  });
});
