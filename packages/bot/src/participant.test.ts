import { MS_PER_TICK, TICKS_PER_SECOND, asPlayerId } from '@td/shared';
import { applyClientMessage, createMatchHost } from '@td/netplay';
import { MessageType, decode, encode } from '@td/protocol';
import type { ClientMessage } from '@td/protocol';
import { describe, expect, it } from 'vitest';
import { aiSeedOf, joinMatch } from './participant.js';
import type { BotSocket, OpenSocket, SocketHandlers } from './participant.js';

/**
 * Компьютер играет по протоколу — вот что здесь проверяется.
 *
 * Ведущий берётся настоящий, из `@td/netplay`, и разговаривает
 * с компьютером настоящими закодированными кадрами. Подставлен только
 * провод между ними: сокета нет, байты передаются вызовом функции.
 * Всё остальное — то же самое, что в бою, включая билет, задержку ввода
 * и назначение тиков.
 */

const SEED = 31337;
const TICKET = 'a'.repeat(32);

interface Bench {
  readonly host: ReturnType<typeof createMatchHost>;
  runMs(ms: number): void;
}

const bench = (side: number): Bench => {
  let nowMs = 1000;
  let botHandlers: SocketHandlers | undefined;
  const me = asPlayerId(side);
  const foe = asPlayerId(side === 0 ? 1 : 0);

  const host = createMatchHost({
    seed: SEED,
    now: () => nowMs,
    send(player, message) {
      if (player !== me) return;
      botHandlers?.onMessage(encode(message));
    },
  });

  const openSocket: OpenSocket = (_url, handlers): BotSocket => {
    botHandlers = handlers;

    // Соединение открывается не мгновенно, но и не по-настоящему:
    // достаточно, чтобы `Join` ушёл после того, как участник готов
    // принимать ответ.
    queueMicrotask(() => handlers.onOpen());

    return {
      send(frame) {
        const result = decode(frame);
        if (!result.ok) throw new Error(`компьютер прислал мусор: ${result.error}`);

        const message = result.message as ClientMessage;
        if (message.type === MessageType.Join) {
          expect(message.ticket).toBe(TICKET);
          host.join(me);
          return;
        }

        applyClientMessage(host, me, message);
      },
      close: () => undefined,
    };
  };

  joinMatch({ wsUrl: 'ws://bench/game', ticket: TICKET, seed: SEED, side, openSocket });

  // Второй участник — не наше дело: он просто присутствует, иначе матч
  // не тронется с места.
  host.join(foe);

  return {
    host,
    runMs(ms) {
      let left = ms;
      while (left > 0) {
        const slice = Math.min(MS_PER_TICK / 2, left);
        nowMs += slice;
        left -= slice;
        host.advance();
      }
    },
  };
};

describe('компьютер как участник', () => {
  it('входит по билету и начинает отдавать команды', async () => {
    const table = bench(1);
    await Promise.resolve();

    table.runMs(4000);

    expect(table.host.history.length).toBeGreaterThan(0);
    expect(table.host.history.every((command) => command.player === 1)).toBe(true);
  });

  it('его команды исполняются не раньше назначенного тика', async () => {
    const table = bench(1);
    await Promise.resolve();

    table.runMs(6000);

    // Ни одна команда не оказалась на тике, который сервер уже проиграл
    // к моменту её отправки: задержка ввода действует на компьютер так же,
    // как на человека. Проверяем косвенно, но надёжно: между решением
    // и исполнением обязан пройти хотя бы минимум задержки.
    const first = table.host.history[0];
    expect(first).toBeDefined();
    expect(first?.tick).toBeGreaterThanOrEqual(table.host.delayTicks);
  });

  it('решает не чаще, чем позволено', async () => {
    const table = bench(0);
    await Promise.resolve();

    table.runMs(10_000);

    const ticks = new Set(table.host.history.map((command) => command.tick));
    const played = table.host.world.tick;

    // Интервал между решениями — половина секунды. Даже с запасом
    // на пачки команд число тиков с командами обязано быть заметно
    // меньше числа сыгранных тиков.
    expect(ticks.size).toBeLessThan(played / 4);
    expect(played).toBeGreaterThan(TICKS_PER_SECOND * 9);
  });

  it('seed решений выводится из seed мира и стороны', () => {
    expect(aiSeedOf(SEED, 0)).not.toBe(aiSeedOf(SEED, 1));
    expect(aiSeedOf(SEED, 0)).toBe(aiSeedOf(SEED, 0));
  });

  it('два матча идут независимо и дают одно и то же', async () => {
    const first = bench(1);
    await Promise.resolve();
    const second = bench(1);
    await Promise.resolve();

    first.runMs(5000);
    second.runMs(5000);

    const asText = (bench: Bench): string =>
      bench.host.history.map((command) => `${String(command.tick)}:${String(command.kind)}`).join('|');

    expect(asText(first)).toBe(asText(second));
  });
});
