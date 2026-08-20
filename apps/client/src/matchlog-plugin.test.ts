import { describe, expect, it } from 'vitest';
import { safeName } from './matchlog-plugin.js';

/**
 * Обработчик приёма записи пишет в файловую систему по запросу
 * из браузера. Живёт он полчаса в день на машине разработчика — и всё же
 * относиться к нему надо соответственно.
 *
 * Проверяется здесь именно то, на чём такие обработчики и ломаются:
 * имя файла составляет обработчик, а не запрос.
 */

describe('имя файла составляет обработчик, а не запрос', () => {
  it('обычное имя проходит как есть', () => {
    expect(safeName('s1337')).toBe('s1337');
    expect(safeName('s1337-baseline-2026-08')).toBe('s1337-baseline-2026-08');
  });

  it('переход по каталогам не выживает', () => {
    expect(safeName('../../etc/passwd')).toBe('etcpasswd');
    expect(safeName('..\\..\\windows\\system32')).toBe('windowssystem32');
  });

  it('разделители путей и двоеточия дисков вырезаны', () => {
    const name = safeName('C:/src/x');

    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
    expect(name).not.toContain(':');
  });

  it('пустое и нестроковое превращается в запасное имя', () => {
    // Молчаливое «ничего не пишем» было бы хуже: запись пропала бы,
    // а разработчик узнал бы об этом, когда пошёл её разбирать.
    expect(safeName('')).toBe('match');
    expect(safeName(undefined)).toBe('match');
    expect(safeName(42)).toBe('match');
    expect(safeName({ toString: () => 'зло' })).toBe('match');
  });

  it('нулевой байт и перевод строки не проходят', () => {
    expect(safeName('a\u0000b')).toBe('ab');
    expect(safeName('a\nb')).toBe('ab');
  });

  it('длина ограничена', () => {
    expect(safeName('a'.repeat(500)).length).toBe(64);
  });

  it('разрешено ровно то, что перечислено', () => {
    // Перечислять разрешённое надёжнее, чем угадывать всё запрещённое:
    // второй список никогда не бывает полным.
    expect(safeName('aA0-')).toBe('aA0-');
    expect(safeName('имя.с точками_и$знаками')).toBe('match');
  });
});
