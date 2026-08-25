import { describe, expect, it } from 'vitest';
import { createTicketBook } from './readings.js';

/** Часы под управлением теста: отсрочку иначе не проверить. */
const clock = (): { now: () => number; advance: (ms: number) => void } => {
  let value = 1_000_000;

  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
};

const seats = (): ReadonlyMap<string, number> =>
  new Map([
    ['ticket-a', 0],
    ['ticket-b', 1],
  ]);

describe('карта билетов', () => {
  it('билет идущего матча опознаётся', () => {
    const time = clock();
    const book = createTicketBook({ now: time.now, graceMs: 1000 });

    book.register('m1', seats());

    expect(book.resolve('ticket-a')).toEqual({ matchId: 'm1', side: 0 });
    expect(book.resolve('ticket-b')).toEqual({ matchId: 'm1', side: 1 });
  });

  it('неизвестный билет не опознаётся', () => {
    const book = createTicketBook({ graceMs: 1000 });

    expect(book.resolve('чужой')).toBeUndefined();
  });

  it('билет кончившегося матча опознаётся до срока', () => {
    // Ради этого карта и заведена своя: последний снимок уходит уже
    // после исхода, когда сиденье в реестре матчей освобождено.
    const time = clock();
    const book = createTicketBook({ now: time.now, graceMs: 1000 });

    book.register('m1', seats());
    book.finish('m1');
    time.advance(999);

    expect(book.resolve('ticket-a')).toEqual({ matchId: 'm1', side: 0 });
  });

  it('после срока билет забыт', () => {
    const time = clock();
    const book = createTicketBook({ now: time.now, graceMs: 1000 });

    book.register('m1', seats());
    book.finish('m1');
    time.advance(1001);

    expect(book.resolve('ticket-a')).toBeUndefined();
  });

  it('идущий матч не забывается, сколько бы ни шёл', () => {
    const time = clock();
    const book = createTicketBook({ now: time.now, graceMs: 1000 });

    book.register('m1', seats());
    time.advance(60 * 60 * 1000);

    expect(book.resolve('ticket-a')).toEqual({ matchId: 'm1', side: 0 });
  });

  it('конец одного матча не задевает соседний', () => {
    const time = clock();
    const book = createTicketBook({ now: time.now, graceMs: 1000 });

    book.register('m1', new Map([['ticket-a', 0]]));
    book.register('m2', new Map([['ticket-c', 0]]));
    book.finish('m1');
    time.advance(1001);

    expect(book.resolve('ticket-a')).toBeUndefined();
    expect(book.resolve('ticket-c')).toEqual({ matchId: 'm2', side: 0 });
  });

  it('карта не растёт от кончившихся матчей', () => {
    // Просроченное выметается при заведении нового матча. Без этого
    // карта росла бы весь срок жизни службы, и заметили бы это нескоро.
    const time = clock();
    const book = createTicketBook({ now: time.now, graceMs: 1000 });

    for (let index = 0; index < 10; index += 1) {
      const matchId = `m${String(index)}`;
      book.register(matchId, new Map([[`ticket-${String(index)}`, 0]]));
      book.finish(matchId);
      time.advance(1001);
    }

    book.register('последний', new Map([['ticket-последний', 0]]));

    expect(book.size).toBe(1);
  });
});
