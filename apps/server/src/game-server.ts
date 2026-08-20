import { CloseCode, DecodeError, MessageType, decode, encode, isFromClient } from '@td/protocol';
import type { MatchRegistry } from './matches.js';
import type { ConnectionId, GameTransport, TransportHandlers } from './transport.js';

/**
 * Обработчик игровых сообщений.
 *
 * Всё, что он делает, — раскладывает входящие кадры по трём стопкам:
 * вход в матч, сообщения уже впущенного участника и мусор. Правила игры,
 * тики и кадры живут в `@td/netplay`, соответствие «соединение — сторона»
 * в `matches.ts`, а здесь только разбор и решение о закрытии.
 *
 * Отдельного сообщения «вход отклонён» нет намеренно. Устаревшему клиенту
 * оно не помогло бы: раскладка байтов у него другая, и наш ответ он
 * отвергнет на первом же байте версии. Код закрытия соединения читается
 * любой версией, потому что от нашего протокола не зависит вовсе.
 */
export const createGameHandlers = (
  getTransport: () => GameTransport,
  matches: MatchRegistry,
  log: (message: string) => void,
): TransportHandlers => ({
  onConnect(connection: ConnectionId) {
    log(`Игрок подключился: соединение ${String(connection.value)}`);
  },

  onMessage(connection: ConnectionId, frame: ArrayBuffer) {
    const result = decode(frame);

    if (!result.ok) {
      // Битый или устаревший кадр — не повод падать и уж точно не повод
      // трогать матч соперника. Рвём одно соединение, назвав причину.
      log(`Отклонён кадр от соединения ${String(connection.value)}: ${result.error}`);
      getTransport().close(
        connection,
        result.error === DecodeError.VersionMismatch
          ? CloseCode.VersionMismatch
          : CloseCode.BadFrame,
      );
      return;
    }

    const { message } = result;

    // Сообщение серверного направления, пришедшее от клиента, — либо
    // ошибка, либо чужой клиент. Разбирать его нельзя ни в том, ни
    // в другом случае.
    if (!isFromClient(message)) {
      log(`Соединение ${String(connection.value)} прислало серверное сообщение`);
      getTransport().close(connection, CloseCode.BadFrame);
      return;
    }

    if (message.type === MessageType.Join) {
      if (matches.admit(connection, message.ticket)) {
        log(`Соединение ${String(connection.value)} вошло в матч по билету`);
      } else {
        log(`Билет соединения ${String(connection.value)} не принят`);
        getTransport().close(connection, CloseCode.BadTicket);
      }
      return;
    }

    // Всё остальное имеет смысл только внутри матча. Соединение, не
    // предъявившее билет, для реестра не существует, и его сообщения
    // молча пропадают — закрывать за это нельзя: кадр мог прийти
    // от участника, чей матч только что кончился.
    if (matches.handle(connection, message)) return;

    // Кроме замера канала: на него отвечаем всегда. Клиент меряет
    // задержку и до входа в матч — например, чтобы показать её в меню, —
    // и молчание в ответ он справедливо примет за обрыв.
    if (message.type === MessageType.Ping) {
      getTransport().send(
        connection,
        encode({ type: MessageType.Pong, tick: message.tick, nonce: message.nonce }),
      );
    }
  },

  onDisconnect(connection: ConnectionId) {
    matches.release(connection);
    log(`Игрок отключился: соединение ${String(connection.value)}`);
  },
});
