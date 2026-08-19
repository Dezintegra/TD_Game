import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { MessageType, decode, encode } from '@td/protocol';
import { buildServer } from './main.js';

/**
 * Интеграционный тест сквозной вертикали на стороне сервера:
 * реальный WebSocket-клиент, реальный бинарный протокол, реальный сервер.
 */
describe('игровой сервер', () => {
  let close: () => Promise<void>;
  let url: string;

  beforeAll(async () => {
    const { app } = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });

    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Не удалось определить порт сервера');
    }
    url = `ws://127.0.0.1:${address.port}/game`;
    close = () => app.close();
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

  it('отвечает Pong на Ping с теми же tick и nonce', async () => {
    const socket = await openSocket();

    const answer = new Promise<ArrayBuffer>((resolve) => {
      socket.once('message', (data: Buffer) => {
        resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      });
    });

    socket.send(encode({ type: MessageType.Ping, tick: 42, nonce: 7 }));
    const result = decode(await answer);
    socket.close();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toEqual({ type: MessageType.Pong, tick: 42, nonce: 7 });
    }
  });

  it('разрывает соединение при получении мусора', async () => {
    const socket = await openSocket();
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));

    socket.send(new Uint8Array([1, 2, 3]));

    await expect(closed).resolves.toBeUndefined();
  });
});
