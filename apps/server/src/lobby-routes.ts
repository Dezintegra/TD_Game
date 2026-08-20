import { randomBytes } from 'node:crypto';
import { LobbyError, TICKET_BYTES } from '@td/protocol';
import { createLobbyStore } from './lobbies.js';
import type { PlayerView } from '@td/protocol';
import type { LobbyResult, LobbyStore, MatchStart } from './lobbies.js';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * Комнаты по сети: действия обычным HTTP, состояние — потоком SSE.
 *
 * Почему не игровым сокетом. Бинарный кодек в `@td/protocol` устроен под
 * тридцать пакетов в секунду с кадром фиксированной длины; протаскивать
 * через него строки переменной длины и списки неизвестного размера
 * пришлось бы ради экономии сорока байт на событии, случающемся
 * единицы раз в минуту. Зато `PROTOCOL_VERSION` начал бы двигаться
 * от правки формы кнопки.
 *
 * Почему не опрос. Момент «соперник нажал готов» обязан доехать сразу,
 * а опрос ради события, случающегося дважды за партию, — это десятки
 * тысяч холостых запросов в час от каждого открытого браузера.
 *
 * Почему SSE, а не второй веб-сокет. Поток нужен односторонний, а
 * `EventSource` в браузере переподключается сам, без нашего кода
 * с экспоненциальной задержкой.
 */

/** Как часто просматриваются комнаты на предмет просроченных отсрочек. */
const SWEEP_INTERVAL_MS = 1000;

/**
 * Как часто в поток уходит комментарий-пустышка.
 *
 * Прокси и балансировщики закрывают соединение, по которому долго ничего
 * не шло. Комментарий SSE (строка, начинающаяся с двоеточия) браузером
 * игнорируется, но для промежуточных узлов это трафик, и соединение живёт.
 */
const KEEPALIVE_INTERVAL_MS = 25_000;

const statusOf = (error: LobbyError): number => {
  switch (error) {
    case LobbyError.BadName:
    case LobbyError.BadTitle:
      return 400;
    case LobbyError.NotFound:
      return 404;
    // Заполненная комната, начавшийся матч, готовность в одиночестве —
    // это не «неверный запрос», а «состояние изменилось, пока вы решали».
    // Отсюда 409: клиенту следует перечитать состояние, а не чинить запрос.
    case LobbyError.Full:
    case LobbyError.AlreadyStarted:
    case LobbyError.NotInLobby:
    case LobbyError.NeedOpponent:
      return 409;
  }
};

interface Stream {
  readonly playerId: string;
  readonly reply: FastifyReply;
}

export interface LobbyRoutes {
  readonly store: LobbyStore;
  /** Гасит таймеры и закрывает потоки. Нужен тестам и остановке сервера. */
  close(): void;
}

export interface LobbyRoutesOptions {
  readonly store?: LobbyStore;
  /**
   * Откуда разрешено обращаться. Клиент при разработке живёт на другом
   * порту, то есть на другом источнике, и без этого заголовка браузер
   * не пропустит ни запрос, ни поток.
   *
   * По умолчанию открыто всем: в API нет ни авторизации, ни кук, красть
   * через чужую страницу нечего. Появится что защищать — появится
   * и список источников.
   */
  readonly allowOrigin?: string;
  /** Матч начался: пора заводить для него симуляцию. */
  readonly onMatchStart?: ((start: MatchStart) => void) | undefined;
  /** Игрок вышел из идущего матча — это сдача. */
  readonly onMatchAbandon?: ((ticket: string) => void) | undefined;
  /** Этот игрок — компьютер? Знает только тот, кто запускал его службу. */
  readonly isComputer?: ((playerId: string) => boolean) | undefined;
}

export const registerLobbyRoutes = (
  app: FastifyInstance,
  options: LobbyRoutesOptions = {},
): LobbyRoutes => {
  const store =
    options.store ??
    createLobbyStore({
      now: () => Date.now(),
      randomSeed: () => Math.floor(Math.random() * 0x100000000),
      randomTicket: () => randomBytes(TICKET_BYTES).toString('hex'),
      onMatchStart: options.onMatchStart,
      onMatchAbandon: options.onMatchAbandon,
      isComputer: options.isComputer,
    });

  const allowOrigin = options.allowOrigin ?? '*';
  const streams = new Set<Stream>();

  const writeView = (stream: Stream, view: PlayerView): void => {
    stream.reply.raw.write(`data: ${JSON.stringify(view)}\n\n`);
  };

  /**
   * Разослать всем полное состояние — каждому своё, потому что «своя
   * комната» и «мой матч» у всех разные.
   *
   * Полное, а не дельту. Дельта экономит байты и покупает на них порядок
   * применения и восстановление после разрыва: клиент, пропустивший
   * событие, обязан уметь запросить состояние целиком — то есть полное
   * состояние всё равно придётся реализовать, но теперь ещё и вместе
   * с нумерацией событий. Здесь же событие идемпотентно, порядок
   * не важен, а первое сообщение после переподключения чинит клиента
   * целиком.
   */
  const broadcast = (): void => {
    for (const stream of streams) writeView(stream, store.view(stream.playerId));
  };

  const reply409 = <T>(reply: FastifyReply, result: LobbyResult<T>): boolean => {
    if (result.ok) return false;
    void reply.code(statusOf(result.error)).send({ error: result.error });
    return true;
  };

  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('access-control-allow-origin', allowOrigin);
    done(null, payload);
  });

  // Запрос с телом в формате JSON браузер предваряет проверочным
  // OPTIONS. Без ответа на него не уйдёт ни одно действие.
  //
  // Адресов ДВА, и это не перестраховка: шаблон со звёздочкой ловит
  // `/api/lobbies/ready` и `/api/lobbies/l1/join`, но не сам
  // `/api/lobbies`, на который уходит проверка перед созданием комнаты.
  // Без второй строки создать комнату из браузера нельзя вовсе, притом
  // что поток состояния работает: `EventSource` шлёт простой GET
  // и проверкой не предваряется.
  const preflight = (_request: unknown, reply: FastifyReply): void => {
    void reply
      .header('access-control-allow-methods', 'GET, POST, OPTIONS')
      .header('access-control-allow-headers', 'content-type')
      .header('access-control-max-age', '86400')
      .code(204)
      .send();
  };

  app.options('/api/lobbies', preflight);
  app.options('/api/lobbies/*', preflight);

  app.get<{ Querystring: { playerId?: string } }>('/api/lobbies/stream', (request, reply) => {
    const playerId = request.query.playerId;
    if (playerId === undefined || playerId.length === 0) {
      void reply.code(400).send({ error: 'no-player' });
      return;
    }

    // Дальше отвечаем в сырой поток сами, поэтому забираем ответ
    // у Fastify: иначе он попытается закрыть его своим телом.
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Отдельная просьба к обратным прокси не копить ответ в буфере:
      // накопленный поток событий перестаёт быть потоком.
      'x-accel-buffering': 'no',
      'access-control-allow-origin': allowOrigin,
    });

    const stream: Stream = { playerId, reply };
    streams.add(stream);
    store.connect(playerId);

    // Состояние уходит немедленно, а не с первым изменением: иначе
    // игрок, открывший игру в тишине, смотрел бы на пустой экран
    // до чужого действия.
    writeView(stream, store.view(playerId));
    broadcast();

    request.raw.on('close', () => {
      streams.delete(stream);
      store.disconnect(playerId);
      broadcast();
    });
  });

  app.post<{ Body: { playerId?: string; name?: string; title?: string } }>(
    '/api/lobbies',
    (request, reply) => {
      const { playerId = '', name = '', title = '' } = request.body;
      const created = store.create(playerId, name, title);
      if (reply409(reply, created)) return;

      broadcast();
      void reply.send(created);
    },
  );

  app.post<{ Params: { id: string }; Body: { playerId?: string; name?: string } }>(
    '/api/lobbies/:id/join',
    (request, reply) => {
      const { playerId = '', name = '' } = request.body;
      const joined = store.join(playerId, name, request.params.id);
      if (reply409(reply, joined)) return;

      broadcast();
      void reply.send(joined);
    },
  );

  app.post<{ Body: { playerId?: string } }>('/api/lobbies/leave', (request, reply) => {
    const { playerId = '' } = request.body;
    // Выход того, кто нигде не состоит, — не ошибка, а обычный исход
    // повторного нажатия или возврата в меню из тренировочного матча.
    if (store.leave(playerId)) broadcast();
    void reply.send({ ok: true });
  });

  app.post<{ Body: { playerId?: string; ready?: boolean } }>(
    '/api/lobbies/ready',
    (request, reply) => {
      const { playerId = '', ready = false } = request.body;
      const result = store.setReady(playerId, ready);
      if (reply409(reply, result)) return;

      broadcast();
      void reply.send(result);
    },
  );

  const sweeper = setInterval(() => {
    if (store.sweep()) broadcast();
  }, SWEEP_INTERVAL_MS);

  const keepalive = setInterval(() => {
    for (const stream of streams) stream.reply.raw.write(': ping\n\n');
  }, KEEPALIVE_INTERVAL_MS);

  // Один проход на все комнаты, а не таймер на слот: таймеров было бы
  // столько же, сколько слотов, каждый пришлось бы снимать при выходе
  // и заводить заново при возврате, а забытый держал бы процесс живым.
  // `unref` — чтобы и эти два не мешали процессу завершиться.
  sweeper.unref();
  keepalive.unref();

  return {
    store,
    close() {
      clearInterval(sweeper);
      clearInterval(keepalive);
      for (const stream of streams) stream.reply.raw.end();
      streams.clear();
    },
  };
};
