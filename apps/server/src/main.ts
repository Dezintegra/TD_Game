import Fastify from 'fastify';
import { PROTOCOL_VERSION } from '@td/protocol';
import { startComputerService } from '@td/bot';
import type { ComputerService } from '@td/bot';
import { SERVER_HOST, SERVER_PORT } from './config.js';
import { createGameHandlers } from './game-server.js';
import { createMatchRegistry } from './matches.js';
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

  // Транспорт нужен обработчикам, а обработчики — транспорту.
  // Классическая circular dependency. Разрываем её через ссылку-держатель:
  // обработчики получают функцию доступа, а не сам объект, и к моменту
  // первого входящего сообщения ссылка уже заполнена.
  const transportRef: { current?: GameTransport } = {};
  const transport = (): GameTransport => {
    if (transportRef.current === undefined) {
      throw new Error('Транспорт ещё не инициализирован');
    }
    return transportRef.current;
  };

  const log = (message: string): void => console.info(`[game] ${message}`);

  const matches = createMatchRegistry({ transport, log });

  // Компьютер — обычный участник, но сервер обязан знать, кто из игроков
  // им является: иначе комнату компьютера нечем пометить, а врать
  // про живого соперника нельзя. Идентификаторы дежурных случайны
  // и выдаются службе при запуске, поэтому назваться компьютером
  // со стороны невозможно.
  //
  // Служба поднимается не здесь, а после `listen`: она ходит к серверу
  // по сети, как и все прочие клиенты, и до открытия порта ходить ей
  // некуда. Отсюда же и ссылка-держатель — маршруты нужно объявить
  // раньше, чем служба появится.
  const computerRef: { current?: ComputerService } = {};

  const lobbies = registerLobbyRoutes(app, {
    onMatchStart: (start) => matches.start(start),
    onMatchAbandon: (ticket) => matches.forfeit(ticket),
    isComputer: (playerId) => computerRef.current?.owns(playerId) ?? false,
  });

  const handlers = createGameHandlers(transport, matches, log);

  await app.ready();
  transportRef.current = createWsTransport(app.server, handlers);

  // Таймеры комнат помечены `unref`, но потоки SSE держат соединения
  // открытыми, и без явного закрытия `app.close()` ждал бы их вечно.
  app.addHook('onClose', () => {
    lobbies.close();
    matches.close();
    computerRef.current?.close();
  });

  /**
   * Поднять службу компьютерных соперников.
   *
   * Вызывается после `listen`, потому что адрес до этого момента
   * неизвестен: в бою он берётся из настроек, а в тестах порт выдаёт
   * система. Тесты службу не поднимают вовсе — им нужен сервер,
   * а не соперник.
   */
  const startComputer = (host: string, port: number): ComputerService => {
    const service = startComputerService({
      apiUrl: `http://${host}:${String(port)}`,
      wsUrl: `ws://${host}:${String(port)}/game`,
      log: (message) => console.info(`[bot] ${message}`),
    });

    computerRef.current = service;
    return service;
  };

  return { app, lobbies, matches, startComputer, getTransport: () => transportRef.current };
};

const isDirectRun = process.argv[1]?.includes('main');

if (isDirectRun) {
  const { app, startComputer } = await buildServer();
  await app.listen({ port: SERVER_PORT, host: SERVER_HOST });

  startComputer(SERVER_HOST, SERVER_PORT);

  console.info(`Сервер слушает http://${SERVER_HOST}:${SERVER_PORT}`);
  console.info(`Игровой сокет: ws://${SERVER_HOST}:${SERVER_PORT}/game`);
}
