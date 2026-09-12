import { describe, expect, it } from 'vitest';
import {
  findAnswer,
  isOurs,
  joinJournalParts,
  prefixOf,
  splitJournalEntry,
  stripMarker,
} from './comments.mjs';

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
    const text = 'я'.repeat(opts.limit - prefixOf(marker).length - 1);
    expect(splitJournalEntry(text, opts)).toHaveLength(1);
  });
});

describe('источник записи', () => {
  it('запись сессии помечается агентской', () => {
    const [only] = splitJournalEntry('Проработка закончена.', { ...opts, source: 'agent' });
    expect(only.startsWith('🤖 [agent] ')).toBe(true);
  });

  it('запись конвейера — супервизорской', () => {
    const [only] = splitJournalEntry('Взята в работу.', { ...opts, source: 'supervisor' });
    expect(only.startsWith('🤖 [supervisor] ')).toBe(true);
  });

  it('не названный источник считается супервизорским: доску пишет он', () => {
    const [only] = splitJournalEntry('Взята в работу.', opts);
    expect(only.startsWith('🤖 [supervisor] ')).toBe(true);
  });

  it('тег стоит на каждой части длинной записи, а не только на первой', () => {
    const long = Array.from({ length: 40 }, (_, i) => `строка ${i}`).join('\n');
    for (const part of splitJournalEntry(long, { ...opts, source: 'agent' })) {
      expect(part.startsWith('🤖 [agent] (часть ')).toBe(true);
    }
  });

  it('тег снимается вместе с пометкой, а в самой записи не остаётся', () => {
    const text = 'Проработка закончена.';
    const [only] = splitJournalEntry(text, { ...opts, source: 'agent' });
    expect(stripMarker(only, marker)).toBe(text);
  });

  it('записи, написанные до появления тегов, читаются по-прежнему', () => {
    // На доске лежат сотни таких. Не прочитав их, конвейер принёс бы
    // следующей сессии журнал с мусором в первой строке каждой записи.
    expect(stripMarker('🤖 старая запись', marker)).toBe('старая запись');
    expect(stripMarker('🤖 (часть 1 из 2)\n\nстарая часть', marker)).toBe('старая часть');
  });

  it('свой комментарий узнаётся с тегом так же, как и без него', () => {
    const [only] = splitJournalEntry('вопрос', { ...opts, source: 'agent' });
    expect(isOurs(only, marker)).toBe(true);
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

describe('чей комментарий', () => {
  it('свой узнаётся по пометке, а не по автору', () => {
    // Автор у обоих один и тот же: токен-то один.
    expect(isOurs('🤖 вопрос', marker)).toBe(true);
    expect(isOurs('Берите первый вариант.', marker)).toBe(false);
  });
});

describe('ответ владельца продукта', () => {
  const since = '2026-08-21T10:00:00.000Z';
  const at = (minutes) => new Date(Date.parse(since) + minutes * 60000).toISOString();

  it('находится среди комментариев конвейера', () => {
    const answer = findAnswer(
      [
        { date: at(1), text: '🤖 (часть 1 из 2)\n\nвопрос' },
        { date: at(2), text: '🤖 (часть 2 из 2)\n\nпродолжение вопроса' },
        { date: at(30), text: 'Берите второй вариант.' },
      ],
      { marker, since },
    );
    expect(answer).toEqual({ text: 'Берите второй вариант.', at: at(30) });
  });

  it('конвейер не принимает свою запись за ответ', () => {
    const only = [{ date: at(5), text: '🤖 design → awaiting-po' }];
    expect(findAnswer(only, { marker, since })).toBeNull();
  });

  it('обсуждение до вопроса ответом не считается', () => {
    const before = [{ date: at(-60), text: 'Давно написанное замечание.' }];
    expect(findAnswer(before, { marker, since })).toBeNull();
  });

  it('берётся первый ответ, а не последний: главное сказано сразу', () => {
    const answer = findAnswer(
      [
        { date: at(20), text: 'Второй вариант.' },
        { date: at(25), text: 'И ещё: не трогайте баланс.' },
      ],
      { marker, since },
    );
    expect(answer.text).toBe('Второй вариант.');
  });

  it('пустой комментарий ответом не считается', () => {
    const empty = [{ date: at(10), text: '   ' }];
    expect(findAnswer(empty, { marker, since })).toBeNull();
  });
});
