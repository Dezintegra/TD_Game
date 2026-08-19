import { MessageType, decode, encode } from '@td/protocol';
import type { ConnectionId, GameTransport, TransportHandlers } from './transport.js';

/**
 * Обработчик игровых сообщений.
 *
 * Пока умеет ровно одно: отвечать Pong на Ping. Это smoke-вертикаль,
 * доказывающая, что клиент, протокол и сервер собраны правильно.
 * Матчи, симуляция и подтверждение команд приедут отдельными
 * изменениями по OpenSpec.
 */
export const createGameHandlers = (
  getTransport: () => GameTransport,
  log: (message: string) => void,
): TransportHandlers => ({
  onConnect(connection: ConnectionId) {
    log(`Игрок подключился: соединение ${connection.value}`);
  },

  onMessage(connection: ConnectionId, frame: ArrayBuffer) {
    const result = decode(frame);

    if (!result.ok) {
      // Битый или устаревший кадр — не повод падать. Логируем и рвём
      // соединение: продолжать диалог на несовместимом протоколе бессмысленно.
      log(`Отклонён кадр от соединения ${connection.value}: ${result.error}`);
      getTransport().close(connection);
      return;
    }

    if (result.message.type === MessageType.Ping) {
      getTransport().send(
        connection,
        encode({
          type: MessageType.Pong,
          tick: result.message.tick,
          nonce: result.message.nonce,
        }),
      );
    }
  },

  onDisconnect(connection: ConnectionId) {
    log(`Игрок отключился: соединение ${connection.value}`);
  },
});
