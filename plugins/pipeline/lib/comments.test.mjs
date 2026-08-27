import { describe, expect, it } from 'vitest';
import { joinJournalParts, splitJournalEntry, stripMarker } from './comments.mjs';

/**
 * Проверки журнала комментариями.
 *
 * Главное требование одно и оно жёсткое: ни одна строка не теряется.
 * Запись журнала разбивают тогда, когда в ней разбор падения вместе
 * с куском лога, — то есть ровно тогда, когда потеря строки обходится
 * дороже всего.
 */

const marker = '🤖';
const opts = { marker, limit: 200 };

/** Сложить части обратно голым способом — для сверки, что ничего не пропало. */
const glue = (parts) => parts.map((part) => stripMarker(part, marker)).join('\n');

describe('короткая запись', () => {
  it('уходит одним комментарием с пометкой', () => {
    const parts = splitJournalEntry('design → audit\n\nПроработка закончена.', opts);
    expect(parts).toHaveLength(1);
    expect(parts[0].startsWith('🤖 ')).toBe(true);
  });

  it('помещающаяся ровно в предел не разбивается', () => {
    const text = 'я'.repeat(opts.limit - marker.length - 1);
    expect(splitJournalEntry(text, opts)).toHaveLength(1);
  });
});

describe('длинная запись', () => {
  const long = Array.from({ length: 40 }, (_, i) => `строка журнала номер ${i + 1}`).join('\n');

  it('разбивается на пронумерованные части', () => {
    const parts = splitJournalEntry(long, opts);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toContain(`часть 1 из ${parts.length}`);
    expect(parts.at(-1)).toContain(`часть ${parts.length} из ${parts.length}`);
  });

  it('ни одна строка не теряется', () => {
    const parts = splitJournalEntry(long, opts);
    expect(glue(parts)).toBe(long);
  });

  it('каждая часть помещается в предел', () => {
    for (const part of splitJournalEntry(long, opts)) {
      expect(part.length).toBeLessThanOrEqual(opts.limit);
    }
  });

  it('не разрывает строки посередине, пока они помещаются', () => {
    for (const part of splitJournalEntry(long, opts)) {
      for (const line of stripMarker(part, marker).split('\n')) {
        expect(line === '' || /^строка журнала номер \d+$/.test(line)).toBe(true);
      }
    }
  });
});

describe('строка длиннее предела', () => {
  const monster = 'я'.repeat(1000);

  it('режется по знакам, а не выбрасывается', () => {
    const parts = splitJournalEntry(monster, opts);
    expect(glue(parts).replace(/\n/g, '')).toBe(monster);
  });

  it('и соседние строки при этом целы', () => {
    const text = `до\n${monster}\nпосле`;
    const parts = splitJournalEntry(text, opts);
    const back = glue(parts).replace(/\n/g, '');
    expect(back.startsWith('до')).toBe(true);
    expect(back.endsWith('после')).toBe(true);
  });
});

describe('склейка обратно', () => {
  it('возвращает запись целой', () => {
    const text = Array.from({ length: 30 }, (_, i) => `строка ${i}`).join('\n');
    const parts = splitJournalEntry(text, opts);
    expect(joinJournalParts(parts, { marker })).toBe(text);
  });

  it('пометку с одиночного комментария снимает', () => {
    expect(stripMarker('🤖 запись', marker)).toBe('запись');
  });

  it('чужой комментарий не трогает', () => {
    expect(stripMarker('ответ владельца', marker)).toBe('ответ владельца');
  });
});
