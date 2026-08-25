import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COUNT_BOUNDS, COUNT_BUDGET, createHistogram } from '@td/shared';
import type { ReadingMoment, ReadingRows } from '@td/shared';
import { createReadingsSender } from './readings-sender.js';

/** Что отправитель собрал бы с живых копилок. */
const collected = (): ReadingRows & ReadingMoment => {
  const jump = createHistogram({ bounds: COUNT_BOUNDS, budget: COUNT_BUDGET });
  jump.add(1);

  return { tick: 1234, delayTicks: 9, pending: 2, jump: jump.snapshot() };
};

interface SentBody {
  readonly ticket?: unknown;
  readonly seq?: unknown;
  readonly tick?: unknown;
  readonly delayTicks?: unknown;
  readonly pending?: unknown;
}

const bodiesOf = (post: ReturnType<typeof vi.fn>): SentBody[] =>
  post.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)) as SentBody);

describe('отправка показаний', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('снимки уходят по часам, не дожидаясь конца матча', () => {
    const post = vi.fn(async () => undefined);
    const sender = createReadingsSender({
      apiUrl: 'http://сервер',
      ticket: 'билет',
      everyMs: 1000,
      collect: collected,
      post,
    });

    vi.advanceTimersByTime(3500);
    sender.stop();

    expect(post).toHaveBeenCalledTimes(3);
  });

  it('вставший мир отправку не останавливает', () => {
    // Часы, а не такты: замри они вместе с миром — молчали бы ровно
    // тогда, когда сказать им есть что.
    const post = vi.fn(async () => undefined);
    const sender = createReadingsSender({
      apiUrl: 'http://сервер',
      ticket: 'билет',
      everyMs: 1000,
      // Мир стоит: тик не двигается ни на единицу.
      collect: () => ({ ...collected(), tick: 7 }),
      post,
    });

    vi.advanceTimersByTime(3000);
    sender.stop();

    expect(post).toHaveBeenCalledTimes(3);
    expect(bodiesOf(post).map((body) => body.tick)).toEqual([7, 7, 7]);
  });

  it('после остановки снимки не уходят', () => {
    // Утёкший таймер стучался бы на сервер всю жизнь вкладки, уже
    // из меню, с билетом кончившегося матча.
    const post = vi.fn(async () => undefined);
    const sender = createReadingsSender({
      apiUrl: 'http://сервер',
      ticket: 'билет',
      everyMs: 1000,
      collect: collected,
      post,
    });

    vi.advanceTimersByTime(2000);
    sender.stop();
    vi.advanceTimersByTime(10_000);

    expect(post).toHaveBeenCalledTimes(2);
  });

  it('билет едет в каждом снимке, а номер растёт на единицу', () => {
    const post = vi.fn(async () => undefined);
    const sender = createReadingsSender({
      apiUrl: 'http://сервер',
      ticket: 'билет',
      everyMs: 1000,
      collect: collected,
      post,
    });

    vi.advanceTimersByTime(2000);
    sender.send();
    sender.stop();

    const bodies = bodiesOf(post);
    expect(bodies.map((body) => body.seq)).toEqual([1, 2, 3]);
    expect(bodies.every((body) => body.ticket === 'билет')).toBe(true);
  });

  it('мгновенные величины едут рядом с распределениями', () => {
    const post = vi.fn(async () => undefined);
    const sender = createReadingsSender({
      apiUrl: 'http://сервер',
      ticket: 'билет',
      everyMs: 1000,
      collect: collected,
      post,
    });

    sender.send();
    sender.stop();

    const [body] = bodiesOf(post);
    expect(body?.tick).toBe(1234);
    expect(body?.delayTicks).toBe(9);
    expect(body?.pending).toBe(2);
  });

  it('неудача отправки наружу не выходит', async () => {
    // Диагностика не имеет права ломать игру: ни исключения, ни
    // необработанного отказа обещания.
    const post = vi.fn(async () => {
      throw new Error('сеть кончилась');
    });
    const sender = createReadingsSender({
      apiUrl: 'http://сервер',
      ticket: 'билет',
      everyMs: 1000,
      collect: collected,
      post,
    });

    expect(() => {
      sender.send();
    }).not.toThrow();

    sender.stop();
    await vi.runAllTimersAsync();
  });

  it('прозвища и номера комнат в снимок не попадают', () => {
    // Требование «показания отдаются без сведений об игроках» действует
    // и на отправку: билет опознаёт сиденье, а не человека.
    const post = vi.fn(async () => undefined);
    const sender = createReadingsSender({
      apiUrl: 'http://сервер',
      ticket: 'билет',
      everyMs: 1000,
      collect: collected,
      post,
    });

    sender.send();
    sender.stop();

    const keys = Object.keys(bodiesOf(post)[0] ?? {});
    expect(keys).not.toContain('name');
    expect(keys).not.toContain('lobbyId');
    expect(keys).not.toContain('playerId');
  });
});
