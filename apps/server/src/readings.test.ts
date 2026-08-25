import { describe, expect, it } from 'vitest';
import { COUNT_BOUNDS, COUNT_BUDGET, createHistogram } from '@td/shared';
import type { HistogramSnapshot, ReadingRows } from '@td/shared';
import { createTicketBook, deltaOf } from './readings.js';

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

/** Копилка, наполненная наблюдениями, — как её копит клиент. */
const filled = (values: readonly number[]): HistogramSnapshot => {
  const histogram = createHistogram({ bounds: COUNT_BOUNDS, budget: COUNT_BUDGET });
  for (const value of values) histogram.add(value);
  return histogram.snapshot();
};

describe('разность накопительных снимков', () => {
  it('первый снимок отдаётся целиком', () => {
    const first: ReadingRows = { jump: filled([1, 2, 3]) };

    expect(deltaOf(undefined, first).jump?.count).toBe(3);
  });

  it('второй снимок отдаётся приращением', () => {
    const previous: ReadingRows = { jump: filled([1, 2, 3]) };
    const next: ReadingRows = { jump: filled([1, 2, 3, 4, 5]) };

    const delta = deltaOf(previous, next).jump;

    expect(delta?.count).toBe(2);
    expect(delta?.sum).toBe(9);
  });

  it('десять снимков подряд дают ровно последний', () => {
    // Главное свойство: сколько бы раз клиент ни отправил копилку,
    // наблюдений в общих рядах столько же, сколько он их сделал.
    const target = createHistogram({ bounds: COUNT_BOUNDS, budget: COUNT_BUDGET });
    let previous: ReadingRows | undefined;

    for (let step = 1; step <= 10; step += 1) {
      const rows: ReadingRows = { jump: filled(Array.from({ length: step }, () => 1)) };
      const delta = deltaOf(previous, rows).jump;

      expect(delta === undefined ? false : target.merge(delta)).toBe(true);
      previous = rows;
    }

    expect(target.snapshot().count).toBe(10);
  });

  it('максимум едет как есть, а не разностью', () => {
    // `merge` берёт от максимума большее. Вычти мы его — общий максимум
    // оказался бы меньше любого наблюдения, и хвост, ради которого всё
    // затевалось, пропал бы.
    const previous: ReadingRows = { jump: filled([5]) };
    const next: ReadingRows = { jump: filled([5, 9]) };

    expect(deltaOf(previous, next).jump?.max).toBe(9);
  });

  it('убывший счётчик читается как перезапуск копилки', () => {
    // Игрок перезагрузил страницу посреди матча: билет тот же, копилка
    // новая. Вычитание дало бы отрицательное число наблюдений.
    const previous: ReadingRows = { jump: filled([1, 2, 3, 4, 5]) };
    const next: ReadingRows = { jump: filled([1]) };

    expect(deltaOf(previous, next).jump?.count).toBe(1);
  });

  it('ряд, которого в новом снимке нет, в разности не появляется', () => {
    const previous: ReadingRows = { jump: filled([1]), shift: filled([2]) };
    const next: ReadingRows = { jump: filled([1, 2]) };

    const delta = deltaOf(previous, next);

    expect(delta.shift).toBeUndefined();
    expect(delta.jump?.count).toBe(1);
  });

  it('ряды считаются порознь', () => {
    const previous: ReadingRows = { jump: filled([1]), shift: filled([2]) };
    const next: ReadingRows = { jump: filled([1, 1]), shift: filled([2]) };

    const delta = deltaOf(previous, next);

    expect(delta.jump?.count).toBe(1);
    expect(delta.shift?.count).toBe(0);
  });
});

describe('прошлый снимок живёт вместе с билетом', () => {
  it('запомненное отдаётся обратно', () => {
    const book = createTicketBook();
    book.register('m1', new Map([['ticket-a', 0]]));

    const rows: ReadingRows = { jump: filled([1]) };
    book.remember('ticket-a', rows);

    expect(book.lastOf('ticket-a')).toBe(rows);
  });

  it('чужой билет запомнить нельзя', () => {
    const book = createTicketBook();

    book.remember('ничей', { jump: filled([1]) });

    expect(book.lastOf('ничей')).toBeUndefined();
  });
});
