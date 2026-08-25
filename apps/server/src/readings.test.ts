import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COUNT_BOUNDS, COUNT_BUDGET, createHistogram } from '@td/shared';
import type { HistogramSnapshot, ReadingRows, ReadingsRecord } from '@td/shared';
import { createReadingsWriter, createTicketBook, deltaOf } from './readings.js';

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

describe('писатель показаний', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'td-readings-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const record = (matchId: string, side: number, seq: number): ReadingsRecord => ({
    t: 'readings',
    matchId,
    side,
    seq,
    atMs: 1_000_000 + seq,
    tick: seq * 150,
    delayTicks: 2,
    pending: 0,
    jump: filled([1]),
  });

  const linesOf = (path: string): string[] =>
    readFileSync(path, 'utf8').split('\n').filter(Boolean);

  it('строки ложатся по одной и по порядку', async () => {
    const writer = createReadingsWriter({ dir, now: () => new Date(2026, 7, 25, 12, 0, 0) });

    writer.append(record('m1', 0, 1));
    writer.append(record('m1', 0, 2));
    writer.append(record('m1', 0, 3));
    await writer.drain();

    const files = readdirSync(dir);
    expect(files).toEqual(['20260825-120000-m1-0.jsonl']);

    const lines = linesOf(join(dir, files[0] ?? ''));
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => (JSON.parse(line) as ReadingsRecord).seq)).toEqual([1, 2, 3]);
  });

  it('стороны одного матча пишутся порознь', async () => {
    // В партии двух людей отчёты приходят вперемежку, и в одном файле
    // две копилки перемешались бы. А сравнивать их как раз и интересно.
    const writer = createReadingsWriter({ dir, now: () => new Date(2026, 7, 25, 12, 0, 0) });

    writer.append(record('m1', 0, 1));
    writer.append(record('m1', 1, 1));
    await writer.drain();

    expect(readdirSync(dir).sort()).toEqual([
      '20260825-120000-m1-0.jsonl',
      '20260825-120000-m1-1.jsonl',
    ]);
  });

  it('на пределе запись останавливается и говорит об этом', async () => {
    const said: string[] = [];
    const writer = createReadingsWriter({
      dir,
      now: () => new Date(2026, 7, 25, 12, 0, 0),
      maxSnapshots: 2,
      log: (message) => said.push(message),
    });

    for (let seq = 1; seq <= 5; seq += 1) writer.append(record('m1', 0, seq));
    await writer.drain();

    expect(linesOf(join(dir, '20260825-120000-m1-0.jsonl'))).toHaveLength(2);
    // Молчаливый обрыв читался бы как поломка службы.
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('предела');
  });

  it('имя файла чистится от всего, кроме букв, цифр и дефиса', async () => {
    // Идентификатор матча сервер выдаёт сам, и всё же он процеживается:
    // путь не составляется из данных, гуляющих по программе.
    const writer = createReadingsWriter({ dir, now: () => new Date(2026, 7, 25, 12, 0, 0) });

    writer.append(record('../../побег', 0, 1));
    await writer.drain();

    expect(readdirSync(dir)).toEqual(['20260825-120000-match-0.jsonl']);
  });

  it('каталог заводится сам', async () => {
    const nested = join(dir, 'нет', 'такого');
    const writer = createReadingsWriter({
      dir: nested,
      now: () => new Date(2026, 7, 25, 12, 0, 0),
    });

    writer.append(record('m1', 0, 1));
    await writer.drain();

    expect(readdirSync(nested)).toHaveLength(1);
  });
});
