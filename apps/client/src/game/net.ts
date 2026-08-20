import { CloseCode, MessageType, decode, encode, isFromServer } from '@td/protocol';
import type { ClientMessage, ServerMessage } from '@td/protocol';
import { hudActions } from './store.js';

/**
 * Сетевой клиент матча.
 *
 * Отвечает ровно за доставку байтов: соединиться, переподключиться,
 * закодировать исходящее, раскодировать входящее. Что означают эти
 * сообщения и как из них получается мир — дело `@td/netplay`.
 *
 * Обратите внимание: используется браузерный WebSocket, а не библиотека
 * `ws`. Библиотека нужна только на сервере; в браузере такой класс
 * встроен. Линт следит, чтобы `ws` не просочился в клиент.
 */
export interface NetClient {
  connect(): void;
  disconnect(): void;
  send(message: ClientMessage): void;
  /** Отправляет ping и запоминает время для замера задержки. */
  ping(tick: number): void;
}

export interface NetClientOptions {
  readonly url: string;
  /** Билет на вход в матч. Предъявляется первым сообщением. */
  readonly ticket: string;
  readonly onMessage: (message: ServerMessage) => void;
  /**
   * Соединение закрыто сервером с объяснением: версия протокола
   * не сходится или билет не принят. Переподключаться в этих случаях
   * бессмысленно — от повторной попытки версия не изменится.
   */
  readonly onRejected?: (code: number) => void;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;

export const createNetClient = (options: NetClientOptions): NetClient => {
  let socket: WebSocket | undefined;
  let nonce = 0;
  let reconnectDelay = RECONNECT_BASE_MS;
  let reconnectTimer: number | undefined;
  let shouldReconnect = true;

  /** Время отправки по nonce — чтобы посчитать время оборота пакета. */
  const sentAt = new Map<number, number>();

  const scheduleReconnect = (): void => {
    if (!shouldReconnect) return;

    // Экспоненциальная задержка: если сервер лежит, не бомбим его
    // попытками каждые полсекунды, а постепенно разряжаем частоту.
    reconnectTimer = window.setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      open();
    }, reconnectDelay);
  };

  const open = (): void => {
    hudActions.setStatus('connecting');

    socket = new WebSocket(options.url);
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', () => {
      reconnectDelay = RECONNECT_BASE_MS;
      hudActions.setStatus('online');

      // Билет — первое, что уходит в матч: до него сервер не знает,
      // чьё это соединение, и все прочие сообщения ему адресовать некому.
      socket?.send(encode({ type: MessageType.Join, ticket: options.ticket }));
    });

    socket.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
      const result = decode(event.data);
      if (!result.ok) {
        console.warn(`Отклонён кадр от сервера: ${result.error}`);
        return;
      }

      const { message } = result;
      if (!isFromServer(message)) return;

      // Замер задержки для панели матча. Он же остаётся признаком живого
      // канала: сервер отвечает Pong, даже когда матч ещё не начался.
      if (message.type === MessageType.Pong) {
        const departed = sentAt.get(message.nonce);
        if (departed !== undefined) {
          sentAt.delete(message.nonce);
          hudActions.registerPong(Math.round(performance.now() - departed));
        }
        return;
      }

      options.onMessage(message);
    });

    socket.addEventListener('close', (event: CloseEvent) => {
      hudActions.setStatus('offline');

      // Отказ по существу — не повод стучаться заново: ни версия
      // протокола, ни билет от повторной попытки не изменятся.
      if (event.code === CloseCode.VersionMismatch || event.code === CloseCode.BadTicket) {
        shouldReconnect = false;
        options.onRejected?.(event.code);
        return;
      }

      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      socket?.close();
    });
  };

  return {
    connect() {
      shouldReconnect = true;
      open();
    },
    disconnect() {
      shouldReconnect = false;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    },
    send(message) {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(encode(message));
    },
    ping(tick) {
      if (socket?.readyState !== WebSocket.OPEN) return;

      nonce = (nonce + 1) >>> 0;
      sentAt.set(nonce, performance.now());
      socket.send(encode({ type: MessageType.Ping, tick, nonce }));
    },
  };
};
