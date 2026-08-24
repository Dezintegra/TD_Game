import Fastify from 'fastify';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { PROTOCOL_VERSION } from '@td/protocol';
import { startComputerService } from '@td/bot';
import { ADAPTIVE_SWARM_PROFILE, BULWARK_PROFILE, STRATEGIST_PROFILE } from '@td/ai';
import type { ComputerService } from '@td/bot';
import { COUNT_BOUNDS, COUNT_BUDGET, JUMP_BOUNDS_CELLS } from '@td/shared';
import type { Command } from '@td/shared';
import { MATCHLOG_DIR, MATCHLOG_ENABLED, SERVER_HOST, SERVER_PORT } from './config.js';
import { createGameHandlers } from './game-server.js';
import { createMatchRegistry } from './matches.js';
import { createMatchRecorder } from './recording.js';
import { registerLobbyRoutes } from './lobby-routes.js';
import { createWsTransport } from './ws-transport.js';
import { createMetrics, mergeReport } from './metrics.js';
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

  app.post<{
    Body: {
      frame?: unknown;
      netGap?: unknown;
      displayGap?: unknown;
      shift?: unknown;
      jump?: unknown;
      pendingOnJump?: unknown;
    };
  }>('/api/telemetry', (request, reply) => {
    // Набор про показ — необязательный, и это не послабление
    // к порядку. Страница живёт у игрока в открытой вкладке дольше,
    // чем выкладка: отчёт от прежнего бандла обязан приниматься,
    // иначе счётчик отвергнутых покраснеет от нашей же выкладки.
    // Пришедший, но порченый — отвергается наравне с остальными.
    const displayGap = request.body?.displayGap;
    const shift = request.body?.shift;
    const jump = request.body?.jump;
    const pendingOnJump = request.body?.pendingOnJump;
    const ok =
      mergeReport(clientFrame, request.body?.frame) &&
      mergeReport(clientNetGap, request.body?.netGap) &&
      (displayGap === undefined || mergeReport(clientDisplayGap, displayGap)) &&
      (shift === undefined || mergeReport(clientShift, shift)) &&
      (jump === undefined || mergeReport(clientJump, jump)) &&
      (pendingOnJump === undefined || mergeReport(clientPendingOnJump, pendingOnJump));

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

  const matches = createMatchRegistry({ transport, log, recorder, metrics });

  // Число идущих матчей — сведение о службе, а не о людях, и отдавать
  // его можно. Читается в момент опроса, а не копится: величина
  // мгновенная, и история у неё есть у того, кто опрашивает.
  metrics.gauge('td_matches_running', 'Сколько матчей идёт сейчас', () => matches.size);

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

    /**
     * Прибор раздумий, размеченный манерой.
     *
     * Имя манеры берётся из того же значения, которым служба и играет,
     * а не выводится заново: два источника одного сведения однажды
     * разойдутся, и в показаниях появится манера, которой никто
     * не играл. Ровно так когда-то запись матча получала
     * правдоподобную неправду.
     */
    const measureFor = (profile: string) => {
      const duration = metrics.histogram(
        'td_ai_decision_duration_ms',
        'Длительность одного решения компьютерного соперника',
        { profile },
      );
      // Границы в штуках: команд за решение бывает от нуля до десятка,
      // и миллисекундные корзины сложили бы их все в первую.
      const commands = metrics.histogram(
        'td_ai_decision_commands',
        'Сколько команд дало одно решение',
        { profile },
        { bounds: [0, 1, 2, 4, 8, 16, 32], budget: Number.POSITIVE_INFINITY },
      );
      const decisions = metrics.counter(
        'td_ai_decisions_total',
        'Сколько решений принято. Частота выводится из него производной',
      );

      return {
        decision: (run: () => readonly Command[]): readonly Command[] => {
          const started = performance.now();
          try {
            const result = run();
            commands.add(result.length);
            return result;
          } finally {
            duration.add(performance.now() - started);
            decisions.add();
          }
        },
      };
    };

    const services = [
      startComputerService({
        apiUrl,
        wsUrl,
        profile: ADAPTIVE_SWARM_PROFILE.id,
        name: 'Компьютер',
        title: 'Матч с компьютером',
        log: botLog,
        measure: measureFor(ADAPTIVE_SWARM_PROFILE.id),
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
        measure: measureFor(BULWARK_PROFILE.id),
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
        measure: measureFor(STRATEGIST_PROFILE.id),
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
