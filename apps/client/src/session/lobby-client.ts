import { LobbyError } from '@td/protocol';
import type { PlayerView } from '@td/protocol';

/**
 * Клиентская сторона комнат ожидания.
 *
 * Два канала с разными обязанностями. Действия — обычные POST: у них
 * есть исход, включая отказ с причиной, и выражать его ответом
 * на запрос естественнее, чем искать его потом в потоке событий.
 * Состояние — поток SSE: «соперник нажал готов» обязано доехать сразу,
 * а не через полсекунды опроса.
 *
 * Своей логики переподключения здесь нет и не должно быть: `EventSource`
 * переподключается сам. Сравните с `game/net.ts`, где для веб-сокета
 * пришлось написать экспоненциальную задержку руками, — это одна
 * из причин, по которой для одностороннего потока выбран SSE.
 */

/**
 * Сервер до нас не доехал: он лежит, сеть оборвалась, ответ невнятен.
 *
 * Причина клиентская и в `LobbyError` намеренно не входит: то
 * перечисление описывает исходы, о которых сообщает сервер, и мешать
 * в него случаи, когда сервера не было слышно вовсе, значило бы
 * размывать смысл списка.
 */
export const UNREACHABLE = 'unreachable';

export type ActionError = LobbyError | typeof UNREACHABLE;

export const lobbyErrorText: Record<ActionError, string> = {
  [LobbyError.NotFound]: 'Комнату уже закрыли',
  [LobbyError.Full]: 'В комнате уже двое',
  [LobbyError.AlreadyStarted]: 'В комнате уже идёт матч',
  [LobbyError.NotInLobby]: 'Вы не в комнате',
  [LobbyError.NeedOpponent]: 'Сначала дождитесь соперника',
  [LobbyError.BadName]: 'Имя не подходит',
  [LobbyError.BadTitle]: 'Название не подходит',
  [UNREACHABLE]: 'Сервер не отвечает',
};

const API_URL = import.meta.env['VITE_API_URL'] ?? 'http://127.0.0.1:3001';

export interface LobbyClient {
  /** Открывает поток состояния. Повторный вызов с тем же игроком ничего не делает. */
  listen(playerId: string): void;
  /** Закрывает поток. */
  stop(): void;
  create(playerId: string, name: string, title: string): Promise<ActionError | null>;
  join(playerId: string, name: string, lobbyId: string): Promise<ActionError | null>;
  leave(playerId: string): Promise<void>;
  setReady(playerId: string, ready: boolean): Promise<ActionError | null>;
}

export interface LobbyClientHandlers {
  onView(view: PlayerView): void;
  /** Открыт ли поток. Ложь — сервер недоступен, идут попытки. */
  onConnected(connected: boolean): void;
}

const post = async (path: string, body: unknown): Promise<ActionError | null> => {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return UNREACHABLE;
  }

  if (response.ok) return null;

  // Ответ об отказе разбираем осторожно: до нас мог ответить не наш
  // сервер, а прокси, и в теле окажется страница, а не наш JSON.
  try {
    const payload = (await response.json()) as { error?: string };
    const known = Object.values(LobbyError).find((value) => value === payload.error);
    return known ?? UNREACHABLE;
  } catch {
    return UNREACHABLE;
  }
};

export const createLobbyClient = (handlers: LobbyClientHandlers): LobbyClient => {
  let source: EventSource | undefined;
  let listeningFor: string | undefined;

  return {
    listen(playerId) {
      if (listeningFor === playerId) return;
      this.stop();
      listeningFor = playerId;

      source = new EventSource(
        `${API_URL}/api/lobbies/stream?playerId=${encodeURIComponent(playerId)}`,
      );

      source.addEventListener('open', () => {
        handlers.onConnected(true);
      });

      source.addEventListener('message', (event: MessageEvent<string>) => {
        try {
          handlers.onView(JSON.parse(event.data) as PlayerView);
        } catch {
          // Испорченный кадр — не повод рушить меню. Следующий придёт
          // целым, и он содержит состояние целиком, а не приращение
          // к пропущенному.
          console.warn('Не разобрано состояние комнат');
        }
      });

      source.addEventListener('error', () => {
        // `EventSource` уже начал переподключаться сам. Наше дело —
        // сказать об этом игроку.
        handlers.onConnected(false);
      });
    },

    stop() {
      source?.close();
      source = undefined;
      listeningFor = undefined;
      handlers.onConnected(false);
    },

    create: (playerId, name, title) => post('/api/lobbies', { playerId, name, title }),

    join: (playerId, name, lobbyId) =>
      post(`/api/lobbies/${encodeURIComponent(lobbyId)}/join`, { playerId, name }),

    async leave(playerId) {
      await post('/api/lobbies/leave', { playerId });
    },

    setReady: (playerId, ready) => post('/api/lobbies/ready', { playerId, ready }),
  };
};
