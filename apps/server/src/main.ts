import Fastify from 'fastify';
import { PROTOCOL_VERSION } from '@td/protocol';
import { SERVER_HOST, SERVER_PORT } from './config.js';
import { createGameHandlers } from './game-server.js';
import { registerLobbyRoutes } from './lobby-routes.js';
import { createWsTransport } from './ws-transport.js';
import type { GameTransport } from './transport.js';

/**
 * Точка входа сервера.
 *
 * Здесь сознательно два разных канала:
 *   - Fastify обслуживает обычный HTTP: health-чек и комнаты ожидания,
 *     включая поток их состояния;
 *   - WebSocket на /game обслуживает реалтайм матча.
 *
 * У них разные требования к задержке, поэтому смешивать их в одном
 * обработчике не стоит. Комнаты живут на первом канале намеренно:
 * событий там единицы в минуту, и платить за них бинарным кодеком,
 * рассчитанным на тридцать пакетов в секунду, не за что.
 */
export const buildServer = async () => {
  const app = Fastify({ logger: false });

  app.get('/health', () => ({ status: 'ok', protocol: PROTOCOL_VERSION }));

  const lobbies = registerLobbyRoutes(app);

  // Транспорт нужен обработчикам, а обработчики — транспорту.
  // Классическая circular dependency. Разрываем её через ссылку-держатель:
  // обработчики получают функцию доступа, а не сам объект, и к моменту
  // первого входящего сообщения ссылка уже заполнена.
  const transportRef: { current?: GameTransport } = {};

  const handlers = createGameHandlers(
    () => {
      if (transportRef.current === undefined) {
        throw new Error('Транспорт ещё не инициализирован');
      }
      return transportRef.current;
    },
    (message) => console.info(`[game] ${message}`),
  );

  await app.ready();
  transportRef.current = createWsTransport(app.server, handlers);

  // Таймеры комнат помечены `unref`, но потоки SSE держат соединения
  // открытыми, и без явного закрытия `app.close()` ждал бы их вечно.
  app.addHook('onClose', () => {
    lobbies.close();
  });

  return { app, lobbies, getTransport: () => transportRef.current };
};

const isDirectRun = process.argv[1]?.includes('main');

if (isDirectRun) {
  const { app } = await buildServer();
  await app.listen({ port: SERVER_PORT, host: SERVER_HOST });
  console.info(`Сервер слушает http://${SERVER_HOST}:${SERVER_PORT}`);
  console.info(`Игровой сокет: ws://${SERVER_HOST}:${SERVER_PORT}/game`);
}
