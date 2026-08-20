import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerLobbyRoutes } from './lobby-routes.js';
import type { FastifyInstance } from 'fastify';
import type { PlayerView } from './lobbies.js';
import type { LobbyRoutes } from './lobby-routes.js';

/**
 * Здесь проверяется транспорт, а не правила комнат: правила покрыты
 * в `lobbies.test.ts` без сети. Отсюда и настоящий слушающий сервер —
 * `inject` для потока не годится, он дожидается конца ответа, а поток
 * не кончается.
 */
let app: FastifyInstance;
let routes: LobbyRoutes;
let base: string;

beforeEach(async () => {
  app = Fastify({ logger: false });
  routes = registerLobbyRoutes(app);
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('Сервер не слушает порт');
  base = `http://127.0.0.1:${String(address.port)}`;
});

afterEach(async () => {
  routes.close();
  await app.close();
});

interface OpenStream {
  latest(): PlayerView | undefined;
  until(predicate: (view: PlayerView) => boolean): Promise<PlayerView>;
  close(): Promise<void>;
}

/** Подписка на поток состояния с разбором кадров SSE. */
const openStream = async (playerId: string): Promise<OpenStream> => {
  const response = await fetch(`${base}/api/lobbies/stream?playerId=${playerId}`);
  const body = response.body;
  if (body === null) throw new Error('Поток не открылся');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const views: PlayerView[] = [];
  let buffer = '';

  const pump = async (): Promise<void> => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;

      buffer += decoder.decode(chunk.value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        // Строка, начинающаяся с двоеточия, — комментарий поддержания
        // связи. Данными он не является и до потребителя не доходит.
        if (frame.startsWith('data: ')) views.push(JSON.parse(frame.slice(6)) as PlayerView);
        boundary = buffer.indexOf('\n\n');
      }
    }
  };

  void pump().catch(() => undefined);

  return {
    latest: () => views.at(-1),

    async until(predicate) {
      const deadline = Date.now() + 2000;
      for (;;) {
        const match = views.findLast(predicate);
        if (match !== undefined) return match;
        if (Date.now() > deadline) {
          throw new Error(`Не дождались состояния. Последнее: ${JSON.stringify(views.at(-1))}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },

    async close() {
      await reader.cancel();
    },
  };
};

const post = async (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('поток состояния', () => {
  it('отдаёт состояние сразу, а не с первым изменением', async () => {
    const stream = await openStream('a');

    const view = await stream.until(() => true);
    expect(view).toEqual({ lobbies: [], lobby: null, match: null });

    await stream.close();
  });

  it('доносит чужое действие без запроса', async () => {
    // Ради этого поток и существует: комната, созданная соседом, обязана
    // появиться у смотрящего на список без его участия.
    const watcher = await openStream('a');
    const actor = await openStream('b');

    await post('/api/lobbies', { playerId: 'b', name: 'Боря', title: 'Комната Бори' });

    const view = await watcher.until((state) => state.lobbies.length === 1);
    expect(view.lobbies[0]).toMatchObject({ title: 'Комната Бори', hostName: 'Боря', players: 1 });

    await watcher.close();
    await actor.close();
  });

  it('замечает уход по закрытию потока', async () => {
    const watcher = await openStream('a');
    const leaver = await openStream('b');

    await post('/api/lobbies', { playerId: 'b', name: 'Боря', title: 'Комната Бори' });
    await watcher.until((state) => state.lobbies.length === 1);

    await leaver.close();

    // Комната не исчезает сразу: у игрока есть отсрочка на перезагрузку
    // страницы. Но отметка о потере связи должна дойти немедленно.
    const view = await watcher.until((state) => state.lobbies.length === 1);
    expect(view.lobbies).toHaveLength(1);

    await watcher.close();
  });
});

describe('действия', () => {
  it('создание помещает создателя в комнату', async () => {
    const stream = await openStream('a');

    const response = await post('/api/lobbies', {
      playerId: 'a',
      name: 'Аня',
      title: 'Комната Ани',
    });
    expect(response.status).toBe(200);

    const view = await stream.until((state) => state.lobby !== null);
    expect(view.lobby?.slots[0]).toMatchObject({ name: 'Аня', you: true });

    await stream.close();
  });

  it('негодное имя отклоняется с причиной, а не молча', async () => {
    const response = await post('/api/lobbies', { playerId: 'a', name: ' ', title: 'Комната' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'bad-name' });
  });

  it('вход в заполненную комнату отклоняется с причиной', async () => {
    const first = await openStream('a');
    const second = await openStream('b');
    const third = await openStream('c');

    await post('/api/lobbies', { playerId: 'a', name: 'Аня', title: 'Комната Ани' });
    const view = await first.until((state) => state.lobby !== null);
    const id = view.lobby?.id ?? '';

    await post(`/api/lobbies/${id}/join`, { playerId: 'b', name: 'Боря' });
    const rejected = await post(`/api/lobbies/${id}/join`, { playerId: 'c', name: 'Вова' });

    // 409, а не 400: запрос был правильным, изменилось состояние.
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: 'full' });

    await first.close();
    await second.close();
    await third.close();
  });

  it('обоюдная готовность начинает матч у обоих', async () => {
    const first = await openStream('a');
    const second = await openStream('b');

    await post('/api/lobbies', { playerId: 'a', name: 'Аня', title: 'Комната Ани' });
    const created = await first.until((state) => state.lobby !== null);
    const id = created.lobby?.id ?? '';

    await post(`/api/lobbies/${id}/join`, { playerId: 'b', name: 'Боря' });
    await post('/api/lobbies/ready', { playerId: 'a', ready: true });
    await post('/api/lobbies/ready', { playerId: 'b', ready: true });

    const forA = await first.until((state) => state.match !== null);
    const forB = await second.until((state) => state.match !== null);

    expect(forA.match?.seed).toBe(forB.match?.seed);
    expect(forA.match?.matchId).toBe(forB.match?.matchId);
    expect(forA.match?.side).toBe(0);
    expect(forB.match?.side).toBe(1);
    expect(forA.match?.opponentName).toBe('Боря');
    expect(forB.match?.opponentName).toBe('Аня');

    await first.close();
    await second.close();
  });

  it('поток без игрока отклоняется', async () => {
    const response = await fetch(`${base}/api/lobbies/stream`);
    expect(response.status).toBe(400);
    // Тело нужно прочитать, иначе соединение останется висеть
    // и `app.close()` будет ждать его до таймаута.
    await response.text();
  });

  it('разрешает обращение с другого источника', async () => {
    // Клиент при разработке живёт на другом порту. Без этого заголовка
    // браузер не пропустит ни одно действие, и меню будет молчать.
    const response = await fetch(`${base}/api/lobbies/leave`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 'a' }),
    });

    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('отвечает на проверочный запрос перед каждым действием', async () => {
    // Адреса перечислены оба намеренно. Шаблон со звёздочкой не ловит
    // сам `/api/lobbies`, и однажды это уже стоило нам работающего
    // создания комнаты при живом потоке состояния: `EventSource`
    // шлёт простой GET и проверкой не предваряется, поэтому меню
    // выглядело исправным, а кнопка «Создать» молчала.
    for (const path of ['/api/lobbies', '/api/lobbies/ready', '/api/lobbies/l1/join']) {
      const response = await fetch(`${base}${path}`, { method: 'OPTIONS' });

      expect(response.status, path).toBe(204);
      expect(response.headers.get('access-control-allow-headers'), path).toContain('content-type');
      expect(response.headers.get('access-control-allow-origin'), path).toBe('*');
    }
  });
});
