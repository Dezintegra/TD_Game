import { WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import type { WebSocket } from 'ws';
import type { ConnectionId, GameTransport, TransportHandlers } from './transport.js';

/**
 * Реализация транспорта поверх библиотеки `ws`.
 *
 * Единственное место в проекте, которое знает про `ws`. Всё остальное
 * работает через интерфейс GameTransport.
 */
export const createWsTransport = (
  httpServer: Server,
  handlers: TransportHandlers,
): GameTransport => {
  const sockets = new Map<number, WebSocket>();
  let nextId = 1;

  const wss = new WebSocketServer({ server: httpServer, path: '/game' });

  wss.on('connection', (socket) => {
    const connection: ConnectionId = { value: nextId };
    nextId += 1;
    sockets.set(connection.value, socket);

    // Просим отдавать данные как Buffer, а не как массив кусков:
    // иначе придётся склеивать фрагменты вручную.
    socket.binaryType = 'nodebuffer';

    handlers.onConnect(connection);

    socket.on('message', (data: Buffer) => {
      // Buffer в Node.js может быть окном в более крупный пул памяти,
      // поэтому вырезаем ровно свой отрезок, а не отдаём весь буфер.
      const frame = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      handlers.onMessage(connection, frame as ArrayBuffer);
    });

    socket.on('close', () => {
      sockets.delete(connection.value);
      handlers.onDisconnect(connection);
    });

    socket.on('error', () => {
      socket.close();
    });
  });

  return {
    send(connection, frame) {
      sockets.get(connection.value)?.send(frame);
    },
    broadcast(frame) {
      for (const socket of sockets.values()) {
        socket.send(frame);
      }
    },
    close(connection, code) {
      sockets.get(connection.value)?.close(code);
    },
    get connectionCount() {
      return sockets.size;
    },
  };
};
