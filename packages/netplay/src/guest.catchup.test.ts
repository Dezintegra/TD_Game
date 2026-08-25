import { FRAME_WORK_BUDGET_MS, asPlayerId } from '@td/shared';
import { MessageType } from '@td/protocol';
import type { ClientMessage, ServerMessage } from '@td/protocol';
import { describe, expect, it } from 'vitest';
import { createMatchGuest } from './guest.js';
import type { MatchGuest } from './guest.js';

/**
 * Догон по истории идёт порциями, а не одним куском.
 *
 * Часы здесь дорожают на каждый вопрос: один вопрос — одна миллисекунда.
 * Благодаря этому «бюджет в миллисекундах» превращается в «столько-то
 * тиков за порцию», и проверять можно счётом, а не секундомером.
 * Настоящее время в проверке было бы худшим из миров: на занятой машине
 * порция вышла бы короче, на быстрой длиннее, и падало бы это через раз.
 */

const SEED = 4242;
const ME = asPlayerId(1);
const DELAY = 3;

/** Часы, дорожающие на каждый вопрос ровно на миллисекунду. */
const tickingClock = (): (() => number) => {
  let ms = 1_000;
  return () => {
    const value = ms;
    ms += 1;
    return value;
  };
};

const welcome = (tick: number): ServerMessage => ({
  type: MessageType.Welcome,
  side: ME,
  seed: SEED,
  tick,
  delayTicks: DELAY,
});

const history = (throughTick: number): ServerMessage => ({
  type: MessageType.History,
  fromTick: 0,
  throughTick,
  commands: [],
});

interface Bench {
  readonly guest: MatchGuest;
  readonly outgoing: ClientMessage[];
  /** Сколько тиков проиграно с прошлого замера. */
  portion(): number;
}

const bench = (options: { readonly clock: boolean }): Bench => {
  const outgoing: ClientMessage[] = [];
  let played = 0;

  const guest = createMatchGuest({
    send: (message) => outgoing.push(message),
    onFrame: () => {
      played += 1;
    },
    ...(options.clock ? { now: tickingClock() } : {}),
  });

  return {
    guest,
    outgoing,
    portion() {
      const value = played;
      played = 0;
      return value;
    },
  };
};

describe('догон по истории', () => {
  it('идёт порциями, и ни одна не длиннее бюджета', () => {
    const TICKS = 600;
    const BUDGET = 5;

    const table = bench({ clock: true });
    table.guest.receive(welcome(TICKS));
    table.guest.receive(history(TICKS - 1));

    // Порция, сыгранная в обработчике сообщения, тоже ограничена:
    // проигрывать историю целиком в колбэке сокета — то самое, что
    // здесь и чинится.
    const portions = [table.portion()];
    expect(portions[0]).toBeLessThanOrEqual(FRAME_WORK_BUDGET_MS);

    // Кадры отрисовки, каждый со своим бюджетом. Предел числа кадров
    // страхует от вечного цикла: при бюджете в пять тиков шестьсот
    // укладываются в полтораста порций с запасом.
    for (let frame = 0; frame < 1_000 && table.guest.status !== 'playing'; frame += 1) {
      table.guest.advance(BUDGET);
      const played = table.portion();
      if (played > 0) portions.push(played);
    }

    expect(table.guest.status).toBe('playing');
    expect(table.guest.confirmed?.tick).toBe(TICKS);

    // Порций много, и каждая короче бюджета: между ними главный поток
    // свободен, и ровно за этим всё затевалось.
    expect(portions.length).toBeGreaterThan(10);
    expect(Math.max(...portions)).toBeLessThanOrEqual(FRAME_WORK_BUDGET_MS);
    expect(portions.reduce((sum, value) => sum + value, 0)).toBe(TICKS);
  });

  it('при нулевом остатке бюджета проигрывает по тику, но доигрывает', () => {
    const TICKS = 90;

    const table = bench({ clock: true });
    table.guest.receive(welcome(TICKS));
    table.guest.receive(history(TICKS - 1));
    table.portion();

    // Ноль — это «времени не осталось вовсе», а не «стой». Иначе
    // на медленной машине догон не сдвинулся бы ни на тик.
    const portions: number[] = [];
    for (let frame = 0; frame < 1_000 && table.guest.status !== 'playing'; frame += 1) {
      table.guest.advance(0);
      const played = table.portion();
      if (played > 0) portions.push(played);
    }

    expect(table.guest.status).toBe('playing');
    expect(table.guest.confirmed?.tick).toBe(TICKS);
    expect(new Set(portions)).toEqual(new Set([1]));
  });

  it('участник без часов догоняет целиком в момент получения', () => {
    const TICKS = 200;

    const table = bench({ clock: false });
    table.guest.receive(welcome(TICKS));
    table.guest.receive(history(TICKS - 1));

    // Компьютерный соперник и стенды проверок заводят участника без
    // часов и без цикла отрисовки. Качать нарезку там некому, а решение
    // принимать надо по подтверждённому миру, которого без догона нет.
    expect(table.portion()).toBe(TICKS);
    expect(table.guest.confirmed?.tick).toBe(TICKS);
    expect(table.guest.status).toBe('playing');
  });
});
