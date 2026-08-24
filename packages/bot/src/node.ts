import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { createComputerService } from './service.js';
import type { ComputerService } from './service.js';
import type { FetchLike } from './lobby-api.js';
import type { BotSocket, OpenSocket, ParticipantMeasure, SocketHandlers } from './participant.js';

/**
 * Запуск службы компьютера в Node.js.
 *
 * Здесь и только здесь появляется настоящий транспорт: `fetch` для
 * комнат и `ws` для матча. Всё остальное в пакете о способе доставки
 * байтов не знает и потому проверяется тестами без сети.
 *
 * Служба запускается рядом с сервером — это один процесс и одна команда
 * запуска, — но разговаривает с ним только через публичные HTTP
 * и WebSocket. Прямой доступ к внутренностям сервера отсюда невозможен
 * не по договорённости, а потому, что `@td/bot` про `@td/server` ничего
 * не знает; за этим следит линт.
 */

const openWsSocket: OpenSocket = (url: string, handlers: SocketHandlers): BotSocket => {
  const socket = new WebSocket(url);
  socket.binaryType = 'nodebuffer';

  socket.on('open', () => handlers.onOpen());

  socket.on('message', (data: Buffer) => {
    // Buffer в Node.js может быть окном в более крупный пул памяти,
    // поэтому вырезаем ровно свой отрезок, а не отдаём весь буфер.
    const frame = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    handlers.onMessage(frame as ArrayBuffer);
  });

  socket.on('close', () => handlers.onClose());
  socket.on('error', () => socket.close());

  return {
    send(frame) {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    },
    close() {
      socket.close();
    },
  };
};

export interface NodeComputerOptions {
  readonly apiUrl: string;
  readonly wsUrl: string;
  readonly maxMatches?: number;
  /** Манера этой службы. Не указана — умолчание библиотеки. */
  readonly profile?: string;
  /** Как зовут компьютер в списке комнат. */
  readonly name?: string;
  /** Как называется его комната. */
  readonly title?: string;
  readonly log?: (message: string) => void;
  /** Приборы раздумий. Отсутствуют — не меряется ничего. */
  readonly measure?: ParticipantMeasure | undefined;
}

export const startComputerService = (options: NodeComputerOptions): ComputerService => {
  // Идентификатор дежурного случаен и наружу не сообщается: по нему
  // сервер отличает компьютер от человека, и предсказуемый идентификатор
  // позволил бы назваться компьютером со стороны.
  const secret = randomBytes(8).toString('hex');

  return createComputerService({
    apiUrl: options.apiUrl,
    wsUrl: options.wsUrl,
    fetch: fetch as unknown as FetchLike,
    openSocket: openWsSocket,
    makeId: (index) => `computer-${secret}-${String(index)}`,
    ...(options.maxMatches === undefined ? {} : { maxMatches: options.maxMatches }),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.measure === undefined ? {} : { measure: options.measure }),
  });
};
