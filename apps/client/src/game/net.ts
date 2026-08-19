import { MessageType, decode, encode } from '@td/protocol';
import { hudActions } from './store.js';

/**
 * Сетевой клиент.
 *
 * Пока умеет только ping/pong — это smoke-вертикаль, доказывающая,
 * что протокол, транспорт и сервер стыкуются. Отправка команд,
 * приём подтверждений и rollback приедут отдельным изменением.
 *
 * Обратите внимание: используется браузерный WebSocket, а не библиотека
 * `ws`. Библиотека нужна только на сервере; в браузере такой класс
 * встроен. Линт следит, чтобы `ws` не просочился в клиент.
 */
export interface NetClient {
  connect(): void;
  disconnect(): void;
  /** Отправляет ping и запоминает время для замера задержки. */
  ping(tick: number): void;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;

export const createNetClient = (url: string): NetClient => {
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

    socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', () => {
      reconnectDelay = RECONNECT_BASE_MS;
      hudActions.setStatus('online');
    });

    socket.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
      const result = decode(event.data);
      if (!result.ok) {
        console.warn(`Отклонён кадр от сервера: ${result.error}`);
        return;
      }

      if (result.message.type === MessageType.Pong) {
        const departed = sentAt.get(result.message.nonce);
        if (departed !== undefined) {
          sentAt.delete(result.message.nonce);
          hudActions.registerPong(Math.round(performance.now() - departed));
        }
      }
    });

    socket.addEventListener('close', () => {
      hudActions.setStatus('offline');
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
    ping(tick) {
      if (socket?.readyState !== WebSocket.OPEN) return;

      nonce = (nonce + 1) >>> 0;
      sentAt.set(nonce, performance.now());
      socket.send(encode({ type: MessageType.Ping, tick, nonce }));
    },
  };
};
