import Fastify from 'fastify';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { PROTOCOL_VERSION } from '@td/protocol';
import { COUNT_BOUNDS, COUNT_BUDGET, JUMP_BOUNDS_CELLS, createMetrics } from '@td/shared';
import {
  COMPUTER_SECRET,
  MATCHLOG_DIR,
  MATCHLOG_ENABLED,
  SERVER_HOST,
  SERVER_PORT,
  TELEMETRY_DIR,
  TELEMETRY_ENABLED,
} from './config.js';
import { createGameHandlers } from './game-server.js';
import { createMatchRegistry } from './matches.js';
import { createMatchRecorder } from './recording.js';
import { createReadingsSink, createReadingsWriter } from './readings.js';
import { registerLobbyRoutes } from './lobby-routes.js';
import { createWsTransport } from './ws-transport.js';
import { createComputerRegistry } from './computer-registry.js';
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
  /**
   * Хранить ли показания игроков. Не указано — как велит настройка.
   *
   * Существует по той же причине и с той же оговоркой, что `record`:
   * иначе каждый прогон проверок оставлял бы файлы показаний, а тест,
   * смотрящий на переменную среды, однажды прошёл бы на чужой машине
   * и упал на своей.
   */
  readonly readings?: boolean;
}

export const buildServer = async (options: BuildOptions = {}) => {
  const app = Fastify({ logger: false });

  app.get('/health', () => ({ status: 'ok', protocol: PROTOCOL_VERSION }));

  /**
   * Приборы.
   *
   * Заведены после того, как разбор рывков дважды дал разные ответы
   * на один вопрос: мерить снаружи процесса нельзя — настенное время
   * ловит вытеснение планировщиком заодно с работой, — а изнутри было
   * нечем.
   *
   * Задержка цикла событий меряется средствами среды, а не своим
   * таймером. Свой таймер жил бы в том самом цикле, который меряет,
   * и добавлял бы в него работу; `monitorEventLoopDelay` реализован
   * в libuv, семплирует вне JavaScript и стоит практически ничего.
   * Это и есть главный ответ на вопрос «стоял ли процесс колом,
   * пока должен был рассылать кадры».
   */
  const metrics = createMetrics();
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();

  const asMs = (ns: number): number => Math.round(ns / 1000) / 1000;

  metrics.gauge('td_event_loop_delay_ms_p50', 'Медиана задержки цикла событий процесса', () =>
    asMs(loopDelay.percentile(50)),
  );
  metrics.gauge(
    'td_event_loop_delay_ms_p99',
    '99-й перцентиль задержки цикла событий процесса',
    () => asMs(loopDelay.percentile(99)),
  );
  metrics.gauge(
    'td_event_loop_delay_ms_max',
    'Наибольшая задержка цикла событий за время работы процесса',
    () => asMs(loopDelay.max),
  );

  /**
   * Отдача показаний.
   *
   * Здесь только величины времени и счётчики. Ни прозвищ, ни номеров
   * комнат, ни билетов: точка по природе своей доступна тому, кто
   * дотянулся до порта, а игровой сервер стоит в интернете.
   */
  app.get('/metrics', (_request, reply) => {
    void reply.type('text/plain; version=0.0.4; charset=utf-8');
    return metrics.render();
  });

  /**
   * Показания клиента.
   *
   * Приходят одним запросом после исхода матча, вне игрового
   * соединения: слать их в горячем пути значило бы, что измерение
   * влияет на измеряемое.
   *
   * Присылаются **корзины**, а не перцентили. Медиана двух выборок
   * не равна средней их медиан, поэтому перцентили сложить нельзя,
   * а корзины складываются честно: в них лежат числа наблюдений.
   *
   * Всё содержимое запроса недоверенное — это браузер игрока. Разметка
   * из тела не берётся ни в каком виде: `source="client"` проставляется
   * здесь, иначе первый же желающий завёл бы сервером тысячу рядов
   * с любыми именами и раздул отдачу до неразбираемой. Числа проверяет
   * `merge`; порченый снимок отвергается целиком, а не портит выборку.
   *
   * Чего здесь сознательно нет: защиты от игрока, который шлёт
   * правдоподобные, но выдуманные показания. Отличить его от честного
   * невозможно в принципе — показания снимаются на его машине, — и
   * городить ради этого подписи значило бы делать вид, что задача
   * решаема. Величины эти диагностические, решений по ним никто
   * не принимает автоматически.
   */
  const clientFrame = metrics.histogram(
    'td_client_frame_gap_ms',
    'Промежуток между кадрами отрисовки у игрока',
    { source: 'client' },
  );
  const clientNetGap = metrics.histogram(
    'td_client_tick_frame_gap_ms',
    'Промежуток между приходами кадров команд к игроку',
    { source: 'client' },
  );
  // Промежуток между продвижениями показываемого тика — прибор картинки,
  // а не канала. Ряд выше отвечает на вопрос «как приходят кадры»,
  // этот — на вопрос «как двигается мир на экране», и совпадают они
  // только до тех пор, пока показ висит на приходе кадров.
  const clientDisplayGap = metrics.histogram(
    'td_client_display_gap_ms',
    'Промежуток между продвижениями показываемого тика у игрока',
    { source: 'client' },
  );
  // Сдвиг команды в ТАКТАХ, поэтому и границы в тактах: миллисекундные
  // здесь означали бы бессмыслицу. Превышение — любой ненулевой сдвиг:
  // один сдвинутый такт это уже показанное игроку «не то».
  const clientShift = metrics.histogram(
    'td_client_command_shift_ticks',
    'На сколько тактов сервер сдвинул команду игрока',
    { source: 'client' },
    { bounds: COUNT_BOUNDS, budget: COUNT_BUDGET },
  );
  // Скачок — величина в клетках, поэтому и границы в клетках. Начинаются
  // с четверти: скачок мельче глазу не виден.
  const clientJump = metrics.histogram(
    'td_client_general_jump_cells',
    'Насколько генерал уехал сверх того, что мог пройти',
    { source: 'client' },
    { bounds: JUMP_BOUNDS_CELLS, budget: COUNT_BUDGET },
  );
  // Очередь снимается В МОМЕНТ скачка, а не по расписанию: вопрос был
  // «совпадает ли рост очереди со скачками», и равномерная выборка
  // на него не отвечает.
  const clientPendingOnJump = metrics.histogram(
    'td_client_pending_on_jump',
    'Сколько своих команд было в пути в момент скачка',
    { source: 'client' },
    { bounds: COUNT_BOUNDS, budget: COUNT_BUDGET },
  );
  const reportsAccepted = metrics.counter(
    'td_client_reports_total',
    'Сколько отчётов о плавности принято от игроков',
  );
  const reportsRejected = metrics.counter(
    'td_client_reports_rejected_total',
    'Сколько отчётов отвергнуто как неразбираемые',
  );

  const log = (message: string): void => console.info(`[game] ${message}`);

  /**
   * Куда складывать снимки показаний.
   *
   * Отсутствует — хранение выключено, и показания живут только
   * в счётчиках выше, как жили раньше.
   */
  const keepReadings = options.readings ?? TELEMETRY_ENABLED;
  const readingsWriter = keepReadings ? createReadingsWriter({ dir: TELEMETRY_DIR }) : undefined;

  // Состояние хранения служба называет вслух, как и состояние записи
  // матчей, и по той же причине: настройка, выставленная и не доехавшая,
  // снаружи выглядит ровно как невыставленная.
  if (readingsWriter === undefined) {
    log('Хранение показаний выключено настройкой. Убрать TELEMETRY=0 — и оно вернётся.');
  } else {
    log(`Показания игроков сохраняются, каталог ${TELEMETRY_DIR}`);
  }

  const readings = createReadingsSink({
    rows: {
      frame: clientFrame,
      netGap: clientNetGap,
      displayGap: clientDisplayGap,
      shift: clientShift,
      jump: clientJump,
      pendingOnJump: clientPendingOnJump,
    },
    writer: readingsWriter,
  });

  app.post('/api/telemetry', (request, reply) => {
    // Разбор целиком в приёмнике: здесь только доставка ответа.
    // Присланное — недоверенное тело, и обращаться с ним умеет тот,
    // кто проверяется без поднятого сервера.
    const ok = readings.accept(request.body);

    if (ok) reportsAccepted.add();
    else reportsRejected.add();

    // Отказ не объясняется подробно и не мешает игроку: отчёт
    // о плавности — не то, ради чего он сюда пришёл.
    void reply.code(ok ? 204 : 400).send();
  });

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

  /**
   * Кто из игроков — компьютер.
   *
   * Личности объявляет служба дежурных, предъявляя общий секрет; сервер
   * запоминает и дальше отвечает сам. Пустой секрет означает закрытую
   * регистрацию, то есть недоступную игру с компьютером.
   *
   * Саму службу сервер больше не поднимает: она живёт своим процессом
   * (`apps/computer`) и ходит сюда по сети, как всякий участник. Прежде
   * дежурные исполнялись в том же потоке, который считает тики
   * и рассылает кадры, и любая их заминка задерживала рассылку ВСЕМ
   * идущим матчам — включая матчи двух людей, к которым компьютер
   * отношения не имеет.
   *
   * Отсюда и порядок правил: пока сервер знал о службе хоть что-нибудь
   * помимо её объявления, уехать ей было некуда.
   */
  const computers = createComputerRegistry({ secret: COMPUTER_SECRET });

  if (COMPUTER_SECRET === '') {
    log(
      'COMPUTER_SECRET не задан: регистрация компьютера закрыта, ' + 'игра с ним будет недоступна.',
    );
  }

  app.post<{ Body: { secret?: unknown; identities?: unknown } }>(
    '/api/computer/declare',
    (request, reply) => {
      const { secret, identities } = request.body;
      const ok =
        typeof secret === 'string' &&
        Array.isArray(identities) &&
        computers.declare(
          secret,
          identities.filter(
            (entry): entry is { id: string; profile: string } =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof (entry as { id?: unknown }).id === 'string' &&
              typeof (entry as { profile?: unknown }).profile === 'string',
          ),
        );

      // Причина отказа не объясняется: тому, кто подбирает секрет,
      // знать, закрыта регистрация или он ошибся, незачем.
      void reply.code(ok ? 204 : 403).send();
    },
  );

  app.post<{ Body: { secret?: unknown; ids?: unknown } }>(
    '/api/computer/withdraw',
    (request, reply) => {
      const { secret, ids } = request.body;
      const ok =
        typeof secret === 'string' &&
        Array.isArray(ids) &&
        computers.withdraw(
          secret,
          ids.filter((id): id is string => typeof id === 'string'),
        );

      void reply.code(ok ? 204 : 403).send();
    },
  );

  metrics.gauge(
    'td_computer_identities',
    'Сколько компьютерных личностей объявлено и не протухло',
    () => computers.size,
  );

  const matches = createMatchRegistry({
    transport,
    log,
    recorder,
    metrics,
    // Приёмник показаний узнаёт о конце матча отсюда: билет обязан
    // опознаваться ещё некоторое время после исхода, потому что
    // последний снимок уходит уже после него.
    onFinished: (matchId) => readings.matchFinished(matchId),
  });

  // Число идущих матчей — сведение о службе, а не о людях, и отдавать
  // его можно. Читается в момент опроса, а не копится: величина
  // мгновенная, и история у неё есть у того, кто опрашивает.
  metrics.gauge('td_matches_running', 'Сколько матчей идёт сейчас', () => matches.size);

  const lobbies = registerLobbyRoutes(app, {
    onMatchStart: (start) => {
      matches.start(start);
      readings.matchStarted(start.matchId, start.tickets);
    },
    onMatchAbandon: (ticket) => matches.forfeit(ticket),
    // Ответ берётся из реестра объявленных личностей, а не вызовом
    // в память службы. Разница в том, что реестру всё равно, в каком
    // процессе живёт служба, — и это единственное, что держало её
    // внутри сервера.
    computerProfileOf: (playerId) => computers.profileOf(playerId),
  });

  const handlers = createGameHandlers(transport, matches, log);

  await app.ready();
  transportRef.current = createWsTransport(app.server, handlers);

  // Таймеры комнат помечены `unref`, но потоки SSE держат соединения
  // открытыми, и без явного закрытия `app.close()` ждал бы их вечно.
  app.addHook('onClose', async () => {
    lobbies.close();
    matches.close();
    // Недописанные строки показаний дописываются: закрытая посреди
    // записи служба оставила бы обрубленный файл, а он читается
    // как поломка.
    await readings.drain();
  });

  return { app, lobbies, matches, readings, getTransport: () => transportRef.current };
};

const isDirectRun = process.argv[1]?.includes('main');

if (isDirectRun) {
  const { app } = await buildServer();
  await app.listen({ port: SERVER_PORT, host: SERVER_HOST });

  console.info(`Сервер слушает http://${SERVER_HOST}:${SERVER_PORT}`);
  console.info(`Игровой сокет: ws://${SERVER_HOST}:${SERVER_PORT}/game`);
}
