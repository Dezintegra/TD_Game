import Fastify from 'fastify';
import { PROTOCOL_VERSION } from '@td/protocol';
import { startComputerService } from '@td/bot';
import { ADAPTIVE_SWARM_PROFILE, BULWARK_PROFILE, STRATEGIST_PROFILE } from '@td/ai';
import type { ComputerService } from '@td/bot';
import { MATCHLOG_DIR, MATCHLOG_ENABLED, SERVER_HOST, SERVER_PORT } from './config.js';
import { createGameHandlers } from './game-server.js';
import { createMatchRegistry } from './matches.js';
import { createMatchRecorder } from './recording.js';
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
export interface BuildOptions {
  /**
   * Писать ли матчи. Не указано — как велит настройка сервера.
   *
   * Существует ради проверок. Тест поднимает настоящий сервер, а запись
   * теперь идёт по умолчанию, и без явного отказа каждый прогон тестов
   * оставлял бы файлы в каталоге записей. Отказ именно явный: тест,
   * который смотрит на переменную среды, однажды пройдёт на чужой машине
   * и упадёт на своей.
   */
  readonly record?: boolean;
}

export const buildServer = async (options: BuildOptions = {}) => {
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

  // Запись матчей — за флагом и по умолчанию выключена. Без неё
  // не создаётся ни писателя, ни наблюдателя, и ведущий матча работает
  // ровно так же, как работал бы без всей этой затеи.
  const record = options.record ?? MATCHLOG_ENABLED;
  const recorder = record ? createMatchRecorder({ dir: MATCHLOG_DIR }) : undefined;

  // Состояние записи сервер называет вслух в обоих случаях, и это
  // не болтливость. Настройка, выставленная и не доехавшая, выглядит
  // снаружи ровно как невыставленная: матчи идут, файлов нет, ошибок нет.
  // Различить их можно было только чтением исходников.
  if (recorder === undefined) {
    log('Запись матчей выключена настройкой. Убрать MATCHLOG=0 — и она вернётся.');
  } else {
    log(`Запись матчей включена, каталог ${MATCHLOG_DIR}`);
  }

  const matches = createMatchRegistry({ transport, log, recorder });

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
  const computerRef: { current: ComputerService[] } = { current: [] };

  const lobbies = registerLobbyRoutes(app, {
    onMatchStart: (start) => matches.start(start),
    onMatchAbandon: (ticket) => matches.forfeit(ticket),
    // Службы спрашиваются по очереди, и берётся первый непустой ответ.
    // Наборы идентификаторов у них не пересекаются: секрет выдаётся
    // службе при запуске.
    computerProfileOf: (playerId) => {
      for (const service of computerRef.current) {
        const profile = service.profileOf(playerId);
        if (profile !== undefined) return profile;
      }

      return undefined;
    },
  });

  const handlers = createGameHandlers(transport, matches, log);

  await app.ready();
  transportRef.current = createWsTransport(app.server, handlers);

  // Таймеры комнат помечены `unref`, но потоки SSE держат соединения
  // открытыми, и без явного закрытия `app.close()` ждал бы их вечно.
  app.addHook('onClose', () => {
    lobbies.close();
    matches.close();
    for (const service of computerRef.current) service.close();
  });

  /**
   * Поднять службы компьютерных соперников — по одной на манеру.
   *
   * Вызывается после `listen`, потому что адрес до этого момента
   * неизвестен: в бою он берётся из настроек, а в тестах порт выдаёт
   * система. Тесты службы не поднимают вовсе — им нужен сервер,
   * а не соперник.
   *
   * Манер две, и обе выбраны замером — 2017 матчей чемпионата плюс
   * прогон против записи живого матча с человеком.
   *
   * Основная — рой, отвечающий на потери: 72% побед в чемпионате
   * и победа над записью человека за 6,7 минуты. Он единственный силён
   * по обеим меркам сразу. Обычный рой сильнее в чемпионате (76%),
   * но именно ему человек и выиграл; манеры, бьющие человека надёжнее,
   * заметно слабее в чемпионате.
   *
   * Вторая — «Оплот»: четыре минуты обороны человеческой манерой
   * (стены первыми, дешёвые башни, дальность, генерал дома), затем
   * переход в наступление. В чемпионате он слаб — 27%, потому что
   * четыре минуты без войска не наверстать, — но играет ЗАМЕТНО иначе,
   * и запись человека он тоже обыграл. Вторая комната нужна ради
   * разнообразия соперника, а не ради второй ступени сложности.
   *
   * Третья — «Стратег», и он здесь не ради разнообразия, а ради того,
   * чтобы в игре вообще существовал ядерный удар. Ни рой, ни оплот
   * не наносят его ни разу: запас под удар держится, только пока
   * достижим за горизонт накопления, а при сорока пяти секундах удар
   * недостижим всегда. Стратегу горизонт поднят до полутораста —
   * и удары появляются: 18 на 24 матчах против нуля у прочих.
   *
   * По силе он между двумя первыми: 79% побед против оплота, 17%
   * против роя. Копит и бьёт; пока копит — держит энергию в казне
   * вместо поля (14 927 против 1199 у базового) и строит втрое меньше.
   * Это и есть зацепка для игрока.
   *
   * Дороже он при этом не стоит, вопреки ожиданию: 1,3 мс на решение
   * против 1,4 у роя, p99 2,4 против 2,6, ни одного решения сверх
   * бюджета тика. Разбор замера — в задаче 2.2 изменения
   * `add-strategist-opponent`.
   *
   * Прежний базовый профиль в игре не встречается: 40% побед, двенадцатое
   * место из восемнадцати. Умолчанием библиотеки он при этом остаётся —
   * там оно значит другое и стережётся эталоном.
   */
  const startComputer = (host: string, port: number): readonly ComputerService[] => {
    const apiUrl = `http://${host}:${String(port)}`;
    const wsUrl = `ws://${host}:${String(port)}/game`;
    const botLog = (message: string): void => {
      console.info(`[bot] ${message}`);
    };

    const services = [
      startComputerService({
        apiUrl,
        wsUrl,
        profile: ADAPTIVE_SWARM_PROFILE.id,
        name: 'Компьютер',
        title: 'Матч с компьютером',
        log: botLog,
      }),
      startComputerService({
        apiUrl,
        wsUrl,
        profile: BULWARK_PROFILE.id,
        name: 'Компьютер-оплот',
        // Двадцать знаков — предел для названия комнаты, общий с именем
        // игрока. «Матч с компьютером: рой» в него не влезал, и комната
        // молча не создавалась вовсе.
        title: 'Матч с оплотом',
        log: botLog,
      }),
      startComputerService({
        apiUrl,
        wsUrl,
        profile: STRATEGIST_PROFILE.id,
        name: 'Компьютер-стратег',
        // Семнадцать знаков при пределе в двадцать — тот же предел,
        // что у имени игрока, и на нём уже спотыкались соседние
        // названия.
        title: 'Матч со стратегом',
        log: botLog,
      }),
    ];

    computerRef.current = services;
    return services;
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
