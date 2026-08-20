import type { PlayerView } from '@td/protocol';

/**
 * Разговор компьютера с комнатами — тот же самый HTTP и тот же самый
 * поток событий, которыми пользуется браузер.
 *
 * Соблазн сходить напрямую в память сервера велик: служба компьютера
 * запускается в том же процессе, и вызвать функцию дешевле, чем послать
 * запрос самому себе. Соблазн отвергнут, и причина не в чистоплюйстве.
 * Компьютер, читающий состояние из памяти сервера, получает его без
 * задержки и в обход проверок, а честность такой конструкции нельзя
 * проверить ничем, кроме внимательности. Здесь же она проверяется
 * границей пакетов: `@td/bot` про `@td/server` не знает вовсе.
 *
 * Побочная выгода — та же служба запускается отдельным процессом
 * на другой машине без единой правки.
 */

/** Минимум от `fetch`, который нам нужен. Внедряется ради тестов. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}>;

export interface LobbyApi {
  create(playerId: string, name: string, title: string): Promise<boolean>;
  setReady(playerId: string, ready: boolean): Promise<boolean>;
  leave(playerId: string): Promise<boolean>;
  /**
   * Слушать состояние. Возвращает функцию остановки.
   *
   * Поток — обычный `text/event-stream`, разобранный своим кодом поверх
   * `fetch`. Браузерный `EventSource` здесь недоступен, а тащить ради
   * трёх десятков строк зависимость незачем.
   */
  listen(playerId: string, onView: (view: PlayerView) => void): () => void;
}

export interface LobbyApiOptions {
  readonly apiUrl: string;
  readonly fetch: FetchLike;
  readonly log?: (message: string) => void;
}

const post = async (
  options: LobbyApiOptions,
  path: string,
  body: Record<string, unknown>,
): Promise<boolean> => {
  try {
    const response = await options.fetch(`${options.apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.ok;
  } catch (error) {
    options.log?.(`Запрос ${path} не удался: ${String(error)}`);
    return false;
  }
};

/**
 * Разбор потока событий.
 *
 * Формат прост до неприличия: события разделены пустой строкой, полезная
 * часть лежит в строках, начинающихся с `data:`. Строки, начинающиеся
 * с двоеточия, — комментарии для промежуточных узлов, их пропускаем.
 */
export const parseEvents = (chunk: string): string[] => {
  const out: string[] = [];

  for (const block of chunk.split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');

    if (data.length > 0) out.push(data);
  }

  return out;
};

export const createLobbyApi = (options: LobbyApiOptions): LobbyApi => ({
  create: (playerId, name, title) =>
    post(options, '/api/lobbies', { playerId, name, title }),

  setReady: (playerId, ready) => post(options, '/api/lobbies/ready', { playerId, ready }),

  leave: (playerId) => post(options, '/api/lobbies/leave', { playerId }),

  listen(playerId, onView) {
    const controller = new AbortController();
    let stopped = false;

    const run = async (): Promise<void> => {
      const url = `${options.apiUrl}/api/lobbies/stream?playerId=${encodeURIComponent(playerId)}`;
      const response = await options.fetch(url, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      });

      const body = response.body;
      if (body === null) return;

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;

        buffer += decoder.decode(value, { stream: true });

        // Хвост без завершающей пустой строки — недочитанное событие.
        // Оставляем его в буфере: разобрать половину JSON нельзя.
        const boundary = buffer.lastIndexOf('\n\n');
        if (boundary < 0) continue;

        const ready = buffer.slice(0, boundary + 2);
        buffer = buffer.slice(boundary + 2);

        for (const data of parseEvents(ready)) {
          try {
            onView(JSON.parse(data) as PlayerView);
          } catch (error) {
            options.log?.(`Испорченное событие комнат: ${String(error)}`);
          }
        }
      }
    };

    void run().catch((error: unknown) => {
      if (!stopped) options.log?.(`Поток комнат оборвался: ${String(error)}`);
    });

    return () => {
      stopped = true;
      controller.abort();
    };
  },
});
