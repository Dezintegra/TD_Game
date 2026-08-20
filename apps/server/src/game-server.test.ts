import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { CloseCode, MessageType, decode, encode } from '@td/protocol';
import { CommandKind, TICKS_PER_SECOND, asTickNumber } from '@td/shared';
import type { ServerMessage } from '@td/protocol';
import { buildServer } from './main.js';
import type { MatchRegistry } from './matches.js';

/**
 * Интеграционный тест сквозной вертикали на стороне сервера:
 * реальный WebSocket-клиент, реальный бинарный протокол, реальный сервер.
 *
 * Проверяется именно то, что нельзя проверить в `@td/netplay`: билет,
 * соответствие соединения и стороны, поведение при мусоре в кадре.
 * Правила матча проверены там, и повторять их здесь незачем.
 */
describe('игровой сервер', () => {
  let close: () => Promise<void>;
  let url: string;
  let matches: MatchRegistry;

  beforeAll(async () => {
    const built = await buildServer();
    matches = built.matches;

    await built.app.listen({ port: 0, host: '127.0.0.1' });

    const address = built.app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Не удалось определить порт сервера');
    }
    url = `ws://127.0.0.1:${address.port}/game`;
    close = () => built.app.close();
  });

  afterAll(async () => {
    await close();
  });

  const openSocket = (): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.binaryType = 'nodebuffer';
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    });

  /** Ждать сообщение указанного типа, накапливая всё пришедшее. */
  const waitFor = (socket: WebSocket, type: ServerMessage['type']): Promise<ServerMessage> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`не дождались типа ${String(type)}`)), 4000);

      const onMessage = (data: Buffer): void => {
        const frame = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        const result = decode(frame as ArrayBuffer);
        if (!result.ok || result.message.type !== type) return;

        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(result.message as ServerMessage);
      };

      socket.on('message', onMessage);
    });

  it('отвечает Pong на Ping с теми же tick и nonce', async () => {
    const socket = await openSocket();

    socket.send(encode({ type: MessageType.Ping, tick: 42, nonce: 7 }));
    const pong = await waitFor(socket, MessageType.Pong);
    socket.close();

    expect(pong).toEqual({ type: MessageType.Pong, tick: 42, nonce: 7 });
  });

  it('разрывает соединение при получении мусора', async () => {
    const socket = await openSocket();
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));

    socket.send(new Uint8Array([1, 2, 3]));

    await expect(closed).resolves.toBe(CloseCode.VersionMismatch);
  });

  it('не пускает в матч без действительного билета', async () => {
    const socket = await openSocket();
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));

    socket.send(encode({ type: MessageType.Join, ticket: 'f'.repeat(32) }));

    await expect(closed).resolves.toBe(CloseCode.BadTicket);
  });

  it('впускает по билету и проводит команду в общий мир', async () => {
    matches.start({
      matchId: 'm-test',
      seed: 12345,
      tickets: new Map([
        ['a'.repeat(32), 0],
        ['b'.repeat(32), 1],
      ]),
    });

    const first = await openSocket();
    const second = await openSocket();

    const welcomeFirst = waitFor(first, MessageType.Welcome);
    const welcomeSecond = waitFor(second, MessageType.Welcome);

    first.send(encode({ type: MessageType.Join, ticket: 'a'.repeat(32) }));
    second.send(encode({ type: MessageType.Join, ticket: 'b'.repeat(32) }));

    expect(await welcomeFirst).toMatchObject({ side: 0, seed: 12345 });
    expect(await welcomeSecond).toMatchObject({ side: 1, seed: 12345 });

    // Матч тикает: кадры идут обоим.
    const tickAtFirst = await waitFor(first, MessageType.TickFrame);
    expect(tickAtFirst.type).toBe(MessageType.TickFrame);

    // Команда второго участника приходит обоим, и сторона в ней — его,
    // хотя в отправленном сообщении стороны нет вовсе.
    const carried = new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('команда не дошла')), 4000);

      first.on('message', (data: Buffer) => {
        const frame = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        const result = decode(frame as ArrayBuffer);
        if (!result.ok || result.message.type !== MessageType.TickFrame) return;
        if (result.message.commands.length === 0) return;

        clearTimeout(timer);
        resolve(result.message);
      });
    });

    const host = matches.find('m-test');
    expect(host).toBeDefined();

    second.send(
      encode({
        type: MessageType.Command,
        command: {
          kind: CommandKind.MoveGeneral,
          tick: asTickNumber((host?.world.tick ?? 0) + 4),
          direction: 1,
        },
      }),
    );

    const frame = await carried;
    expect(frame.type).toBe(MessageType.TickFrame);
    if (frame.type !== MessageType.TickFrame) return;

    expect(frame.commands).toHaveLength(1);
    expect(frame.commands[0]?.player).toBe(1);
    expect(frame.commands[0]?.kind).toBe(CommandKind.MoveGeneral);

    first.close();
    second.close();
  });

  it('считает тики в реальном темпе', async () => {
    matches.start({
      matchId: 'm-tempo',
      seed: 7,
      tickets: new Map([
        ['e'.repeat(32), 0],
        ['f'.repeat(32), 1],
      ]),
    });

    const first = await openSocket();
    const second = await openSocket();
    const ready = Promise.all([waitFor(first, MessageType.Welcome), waitFor(second, MessageType.Welcome)]);

    first.send(encode({ type: MessageType.Join, ticket: 'e'.repeat(32) }));
    second.send(encode({ type: MessageType.Join, ticket: 'f'.repeat(32) }));
    await ready;

    const host = matches.find('m-tempo');
    const before = host?.world.tick ?? 0;

    // Единственное место, где тест ждёт по-настоящему: проверяется как раз
    // настоящий таймер сервера, а подменить его — значит проверить подмену.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const after = host?.world.tick ?? 0;

    expect(after - before).toBeGreaterThanOrEqual(TICKS_PER_SECOND - 2);
    expect(after - before).toBeLessThanOrEqual(TICKS_PER_SECOND + 2);

    first.close();
    second.close();
  });

  it('второе соединение с занятым билетом не проходит', async () => {
    matches.start({
      matchId: 'm-busy',
      seed: 999,
      tickets: new Map([
        ['c'.repeat(32), 0],
        ['d'.repeat(32), 1],
      ]),
    });

    const holder = await openSocket();
    const welcome = waitFor(holder, MessageType.Welcome);
    holder.send(encode({ type: MessageType.Join, ticket: 'c'.repeat(32) }));
    await welcome;

    const intruder = await openSocket();
    const closed = new Promise<number>((resolve) => intruder.once('close', (code) => resolve(code)));
    intruder.send(encode({ type: MessageType.Join, ticket: 'c'.repeat(32) }));

    await expect(closed).resolves.toBe(CloseCode.BadTicket);

    holder.close();
  });
});
