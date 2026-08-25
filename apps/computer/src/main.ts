import { createServer } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createMetrics } from '@td/shared';
import type { ComputerService } from '@td/bot';
import { API_URL, COMPUTER_SECRET, METRICS_HOST, METRICS_PORT, WS_URL } from './config.js';
import { awaitAcceptance, offerDeclaration } from './handshake.js';
import { startComputerServices } from './services.js';

/**
 * Точка входа службы компьютерных дежурных.
 *
 * Приложение содержит **только** точку входа: чтение настроек, запуск
 * служб из `@td/bot`, свои приборы и завершение по сигналу. Ни игровых
 * правил, ни поведения противника, ни собственного ведения матча здесь
 * быть не должно — всё это уже есть в `@td/ai` и `@td/bot`. Соблазн
 * будет: точка входа притягивает к себе «ещё немножко логики», потому
 * что там удобно.
 *
 * Ради чего процесс отдельный. Прежде дежурные исполнялись в том же
 * потоке, который считает тики и рассылает кадры, и любая их заминка
 * задерживала рассылку ВСЕМ идущим матчам — включая матчи двух людей,
 * к которым компьютер отношения не имеет. Величина заминки при этом
 * ничем не ограничена: восстановление после расхождения переигрывает
 * весь матч синхронно.
 */

const log = (message: string): void => {
  console.info(`[computer] ${message}`);
};

const botLog = (message: string): void => {
  console.info(`[bot] ${message}`);
};

/**
 * Приборы службы.
 *
 * Главная величина здесь та же, что и у сервера, — задержка цикла
 * событий. В том и смысл переезда: заминка раздумий обязана быть видна
 * там, где происходит, и не видна там, где рассылаются кадры. Пока
 * приборы были только у сервера, «стало лучше» нечем было бы отличить
 * от «перестало меряться».
 */
const metrics = createMetrics();
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

const asMs = (ns: number): number => Math.round(ns / 1000) / 1000;

metrics.gauge('td_event_loop_delay_ms_p50', 'Медиана задержки цикла событий процесса', () =>
  asMs(loopDelay.percentile(50)),
);
metrics.gauge('td_event_loop_delay_ms_p99', '99-й перцентиль задержки цикла событий процесса', () =>
  asMs(loopDelay.percentile(99)),
);
metrics.gauge(
  'td_event_loop_delay_ms_max',
  'Наибольшая задержка цикла событий за время работы процесса',
  () => asMs(loopDelay.max),
);

let services: readonly ComputerService[] = [];

metrics.gauge('td_computer_matches', 'Сколько матчей ведут дежурные сейчас', () =>
  services.reduce((sum, service) => sum + service.matchCount, 0),
);
metrics.gauge('td_computer_idle', 'Сколько дежурных ждёт соперника', () =>
  services.reduce((sum, service) => sum + service.idleCount, 0),
);

/**
 * Отдача показаний.
 *
 * Голый `node:http`, а не Fastify: маршрут здесь один, и тащить ради
 * него веб-каркас со всем его деревом зависимостей в боевой образ
 * не за что.
 *
 * Слушателя нет вовсе, пока порт не назван явно. Рабочих деревьев
 * на машине несколько, и порт, занятый по умолчанию, дрался бы
 * с соседним деревом ровно так же, как дерутся игровые порты.
 */
const startMetricsEndpoint = (): void => {
  if (!Number.isFinite(METRICS_PORT) || METRICS_PORT <= 0) {
    log('COMPUTER_METRICS_PORT не задан: показания службы никуда не отдаются.');
    return;
  }

  const endpoint = createServer((request, response) => {
    if (request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    response.end(metrics.render());
  });

  endpoint.listen(METRICS_PORT, METRICS_HOST, () => {
    log(`Показания на http://${METRICS_HOST}:${String(METRICS_PORT)}/metrics`);
  });

  // Слушатель не должен мешать процессу завершиться по сигналу:
  // закрывать его отдельной веткой — лишний повод забыть.
  endpoint.unref();
};

/**
 * Уход по-хорошему.
 *
 * Закрытие службы снимает объявление личностей, и это не вежливость:
 * без снятия комнаты ушедшей службы висели бы в списке до истечения
 * срока, и игрок минуту смотрел бы на комнату, в которую никто
 * не войдёт.
 *
 * Обработчик защищён от повторного входа: `docker compose down` шлёт
 * TERM, а нетерпеливый человек добавляет к нему Ctrl+C, и снимать
 * объявление дважды незачем.
 */
let leaving = false;

const leave = (signal: string): void => {
  if (leaving) return;
  leaving = true;

  log(`Получен ${signal}: снимаю объявление и ухожу.`);
  for (const service of services) service.close();

  // Снятие объявления уходит запросом, а он не мгновенен. Небольшая
  // отсрочка перед выходом даёт запросу уехать; не уехал — сервер
  // всё равно забудет личности по истечении срока, просто позже.
  setTimeout(() => process.exit(0), 500).unref();
};

process.on('SIGINT', () => leave('SIGINT'));
process.on('SIGTERM', () => leave('SIGTERM'));

startMetricsEndpoint();

if (COMPUTER_SECRET === '') {
  // Не поломка, а объявленное состояние: сборка без секрета — это
  // сборка без игры с компьютером. Поднять дежурных молча было бы
  // хуже — их комнаты встали бы в списке человеческими на вид.
  log(
    'COMPUTER_SECRET не задан: объявиться нечем, дежурных не поднимаю. ' +
      'Игра с компьютером будет недоступна.',
  );

  // Процесс при этом остаётся жить, хотя делать ему нечего. Выход
  // означал бы бесконечный перезапуск контейнера (`restart: unless-stopped`
  // возвращает и того, кто вышел с нулём), то есть страницу журнала
  // вместо одной строки. Пусть стоит и молчит: состояние честное
  // и названо вслух.
  setInterval(() => undefined, 60_000);
} else {
  log(`Сервер ${API_URL}, игровой сокет ${WS_URL}`);

  /**
   * Сперва рукопожатие, потом найм.
   *
   * Служба ходит к серверу по сети, значит сервер должен быть готов
   * раньше. В одном процессе это решалось вызовом после `listen`;
   * между процессами так уже нельзя — в compose оба контейнера
   * стартуют разом. Поэтому ждём с нарастающей паузой, а не падаем:
   * перезапуск по кругу шумит в журнале и ничего не чинит.
   */
  const accepted = await awaitAcceptance({
    offer: () =>
      offerDeclaration({
        apiUrl: API_URL,
        secret: COMPUTER_SECRET,
        post: (url, init) => fetch(url, init),
      }),
    // Таймер ожидания намеренно НЕ помечен `unref`: пока служба ждёт
    // сервера, держать процесс живым больше нечему, и помеченный таймер
    // дал бы тихий выход вместо ожидания.
    wait: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    log,
    stopped: () => leaving,
  });

  if (accepted) {
    services = startComputerServices({
      apiUrl: API_URL,
      wsUrl: WS_URL,
      secret: COMPUTER_SECRET,
      metrics,
      log: botLog,
    });
  }
}
