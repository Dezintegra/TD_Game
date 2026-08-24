import { MS_PER_TICK, asPlayerId } from '@td/shared';
import { applyClientMessage, createMatchHost } from '@td/netplay';
import { encode } from '@td/protocol';
import type { MatchHost } from '@td/netplay';
import type { MatchSide } from '@td/shared';
import type { ClientMessage } from '@td/protocol';
import type { HostMeasure } from '@td/netplay';
import type { ConnectionId, GameTransport } from './transport.js';
import type { MatchRecorder, MatchRecording } from './recording.js';
import type { Metrics } from './metrics.js';

/**
 * Реестр матчей: кто сейчас играет и по какому соединению.
 *
 * Разделение обязанностей здесь такое. `@td/netplay` знает, как из потока
 * команд получается мир, и ничего не знает про сокеты. Этот модуль знает
 * про сокеты и ничего не знает про правила игры. Между ними — билет:
 * единственное, что связывает соединение со стороной в симуляции.
 *
 * Почему матч не начинает считаться сразу после обоюдной готовности:
 * между «оба нажали готов» и первым тиком клиенту нужно создать сцену,
 * а компьютеру — открыть соединение. Ведущий поэтому создаётся в фазе
 * ожидания и трогается с места, только когда пришли оба.
 */

/** Как часто опрашиваются матчи. Втрое чаще тика — чтобы не дрожал темп. */
const POLL_INTERVAL_MS = Math.floor(MS_PER_TICK / 3);

/**
 * Сколько держать завершённый матч.
 *
 * Не ноль: участник, у которого в этот момент оборвалась связь, должен
 * успеть вернуться и узнать исход, а не наткнуться на «такого матча нет».
 */
const KEEP_FINISHED_MS = 30_000;

export interface MatchStartRequest {
  readonly matchId: string;
  readonly seed: number;
  /** Билет — сторона в симуляции. */
  readonly tickets: ReadonlyMap<string, number>;
  /** Кем занята каждая сторона. Нужно записи и только ей. */
  readonly sides: readonly MatchSide[];
}

export interface MatchRegistry {
  /** Завести матч, начавшийся в комнате. */
  start(request: MatchStartRequest): void;
  /**
   * Соединение предъявило билет. Возвращает `false`, если билет не подошёл
   * или место уже занято живым соединением.
   */
  admit(connection: ConnectionId, ticket: string): boolean;
  /**
   * Сообщение от уже впущенного соединения. Возвращает `false`, если
   * соединение ни в каком матче не состоит: такое сообщение адресовать
   * некому.
   */
  handle(connection: ConnectionId, message: ClientMessage): boolean;
  /** Соединение закрылось. */
  release(connection: ConnectionId): void;
  /**
   * Участник сдался: вышел из матча сам.
   *
   * Отличается от `release` тем, что не даёт отсрочки на возврат.
   * Ушедший по своей воле не вернётся, и заставлять соперника ждать
   * полминуты его возвращения незачем.
   */
  forfeit(ticket: string): void;
  /** Идёт ли матч с таким идентификатором (для тестов и диагностики). */
  find(matchId: string): MatchHost | undefined;
  readonly size: number;
  close(): void;
}

interface Entry {
  readonly id: string;
  readonly host: MatchHost;
  /** Соединение каждой стороны; `null` — сторона сейчас не на связи. */
  readonly seats: (ConnectionId | null)[];
  readonly tickets: readonly string[];
  /** Запись матча; `undefined` — запись выключена. */
  readonly recording: MatchRecording | undefined;
  finishedAtMs: number | null;
}

interface Seat {
  readonly entry: Entry;
  readonly side: number;
}

export interface MatchRegistryOptions {
  readonly transport: () => GameTransport;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  /** Куда писать матчи. Отсутствует — не пишется ничего. */
  readonly recorder?: MatchRecorder | undefined;
  /** Приборы. Отсутствуют — не меряется ничего. */
  readonly metrics?: Metrics | undefined;
}

export const createMatchRegistry = (options: MatchRegistryOptions): MatchRegistry => {
  const now = options.now ?? (() => Date.now());
  const matches = new Map<string, Entry>();
  /** Билет → место. */
  const seats = new Map<string, Seat>();
  /** Номер соединения → место. */
  const admitted = new Map<number, Seat>();

  /**
   * Приборы такта. Заводятся один раз на реестр, а не на матч:
   * вопрос «уложился ли сервер в бюджет» — про процесс целиком,
   * и раздельные показания на каждый матч на него не отвечают.
   *
   * Секундомер здесь `performance.now`, а не `now` реестра: тот
   * миллисекундный, а шаг мира стоит десятые доли миллисекунды
   * и показался бы ему нулём.
   */
  const metrics = options.metrics;
  const sweepMs = metrics?.histogram(
    'td_sweep_duration_ms',
    'Длительность одного прохода по реестру матчей',
  );
  const stepMs = metrics?.histogram('td_world_step_duration_ms', 'Длительность одного шага мира');
  // Границы в штуках, а не в миллисекундах, и превышением считается
  // всё сверх одного тика: посчитать за проход больше одного — уже
  // догон, а бюджет тика для счётной величины ничего не значит.
  const advancedTicks = metrics?.histogram(
    'td_ticks_per_advance',
    'Сколько тиков посчитано за один проход. Больше единицы — уже догон',
    {},
    { bounds: [0, 1, 2, 4, 8, 16, 32, 64], budget: 1 },
  );
  const debts = metrics?.counter(
    'td_tick_debt_total',
    'Сколько раз матч признал отставание и сдвинул точку отсчёта',
  );
  // Ряд один на все матчи, а не на каждый: кадр уходит всем местам
  // одной рассылкой, и промежутки у мест совпадают по построению.
  // Границы и бюджет по умолчанию — миллисекунды и тик: промежуток
  // длиннее тика и есть то, чего здесь быть не должно.
  const sendGapMs = metrics?.histogram(
    'td_frame_send_gap_ms',
    'Промежуток между отправками кадра команд',
  );

  const measure: HostMeasure | undefined =
    metrics === undefined
      ? undefined
      : {
          step: (run) => {
            const started = performance.now();
            try {
              return run();
            } finally {
              stepMs?.add(performance.now() - started);
            }
          },
          advanced: (ticks) => advancedTicks?.add(ticks),
          debt: (ticks) => debts?.add(ticks),
          sent: (gapMs) => sendGapMs?.add(gapMs),
        };

  const dispatch = (entry: Entry): void => {
    // Один проход уборки на весь реестр, а не таймер на матч. Таймеров
    // было бы столько же, сколько матчей, и каждый пришлось бы снимать
    // в двух местах.
    if (entry.host.phase === 'finished' && entry.finishedAtMs === null) {
      entry.finishedAtMs = now();
      options.log?.(`Матч ${entry.id} завершён: ${String(entry.host.outcome?.reason)}`);

      // Запись закрывается здесь, а не по отдельному вызову наблюдателя:
      // место, где кончается матч, должно остаться одно.
      const outcome = entry.host.outcome;
      void entry.recording?.close(
        outcome === null
          ? null
          : {
              tick: entry.host.world.tick,
              winner: outcome.winner,
              reason: String(outcome.reason),
            },
      );
    }
  };

  const sweep = (): void => {
    const startedAt = sweepMs === undefined ? 0 : performance.now();
    const nowMs = now();

    for (const entry of matches.values()) {
      entry.host.advance();
      dispatch(entry);

      if (entry.finishedAtMs !== null && nowMs - entry.finishedAtMs > KEEP_FINISHED_MS) {
        matches.delete(entry.id);
        for (const ticket of entry.tickets) seats.delete(ticket);

        for (const seat of entry.seats) {
          if (seat !== null) admitted.delete(seat.value);
        }
      }
    }

    sweepMs?.add(performance.now() - startedAt);
  };

  const timer = setInterval(sweep, POLL_INTERVAL_MS);
  // Таймер не должен держать процесс: иначе тесты, поднявшие сервер,
  // не завершатся никогда.
  timer.unref?.();

  return {
    start(request) {
      const seatsOfMatch: (ConnectionId | null)[] = [];

      const recording = options.recorder?.open({
        matchId: request.matchId,
        seed: request.seed,
        sides: request.sides,
      });

      const entry: Entry = {
        id: request.matchId,
        seats: seatsOfMatch,
        tickets: [...request.tickets.keys()],
        recording,
        finishedAtMs: null,
        host: createMatchHost({
          seed: request.seed,
          now,
          observe: recording,
          measure,
          send(player, message) {
            const connection = seatsOfMatch[player];
            if (connection === undefined || connection === null) return;

            options.transport().send(connection, encode(message));
          },
        }),
      };

      for (const [ticket, side] of request.tickets) {
        seatsOfMatch[side] = null;
        seats.set(ticket, { entry, side });
      }

      matches.set(entry.id, entry);
      options.log?.(
        `Матч ${entry.id} заведён, seed ${String(request.seed)}` +
          (recording === undefined ? '' : `, запись в ${recording.path}`),
      );
    },

    admit(connection, ticket) {
      const seat = seats.get(ticket);
      if (seat === undefined) return false;
      if (seat.entry.host.phase === 'finished') return false;

      // Место, занятое живым соединением, второму не отдаётся: иначе
      // за одну сторону играли бы двое, и чья команда исполнится,
      // решала бы очерёдность пакетов.
      if (seat.entry.seats[seat.side] !== null) return false;

      seat.entry.seats[seat.side] = connection;
      admitted.set(connection.value, seat);
      seat.entry.host.join(asPlayerId(seat.side));

      return true;
    },

    handle(connection, message) {
      const seat = admitted.get(connection.value);
      if (seat === undefined) return false;

      applyClientMessage(seat.entry.host, asPlayerId(seat.side), message);
      return true;
    },

    release(connection) {
      const seat = admitted.get(connection.value);
      if (seat === undefined) return;

      admitted.delete(connection.value);
      if (seat.entry.seats[seat.side] === connection) {
        seat.entry.seats[seat.side] = null;
      }

      seat.entry.host.drop(asPlayerId(seat.side));
    },

    forfeit(ticket) {
      const seat = seats.get(ticket);
      if (seat === undefined) return;

      seat.entry.host.forfeit(asPlayerId(seat.side));
      dispatch(seat.entry);
    },

    find(matchId) {
      return matches.get(matchId)?.host;
    },

    get size() {
      return matches.size;
    },

    close() {
      clearInterval(timer);

      // Хвосты недоигранных матчей дописываются: сервер останавливают
      // чаще, чем доигрывают партию до победы, и потерять из-за этого
      // десять минут игры было бы обидно. Исхода у таких записей нет —
      // его и не было.
      for (const entry of matches.values()) void entry.recording?.close(null);

      matches.clear();
      seats.clear();
      admitted.clear();
    },
  };
};
