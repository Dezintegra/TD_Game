import { MS_PER_TICK, asPlayerId } from '@td/shared';
import { applyClientMessage, createMatchHost } from '@td/netplay';
import { encode } from '@td/protocol';
import type { MatchHost } from '@td/netplay';
import type { ClientMessage } from '@td/protocol';
import type { ConnectionId, GameTransport } from './transport.js';

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
}

export const createMatchRegistry = (options: MatchRegistryOptions): MatchRegistry => {
  const now = options.now ?? (() => Date.now());
  const matches = new Map<string, Entry>();
  /** Билет → место. */
  const seats = new Map<string, Seat>();
  /** Номер соединения → место. */
  const admitted = new Map<number, Seat>();

  const dispatch = (entry: Entry): void => {
    // Один проход уборки на весь реестр, а не таймер на матч. Таймеров
    // было бы столько же, сколько матчей, и каждый пришлось бы снимать
    // в двух местах.
    if (entry.host.phase === 'finished' && entry.finishedAtMs === null) {
      entry.finishedAtMs = now();
      options.log?.(`Матч ${entry.id} завершён: ${String(entry.host.outcome?.reason)}`);
    }
  };

  const sweep = (): void => {
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
  };

  const timer = setInterval(sweep, POLL_INTERVAL_MS);
  // Таймер не должен держать процесс: иначе тесты, поднявшие сервер,
  // не завершатся никогда.
  timer.unref?.();

  return {
    start(request) {
      const seatsOfMatch: (ConnectionId | null)[] = [];

      const entry: Entry = {
        id: request.matchId,
        seats: seatsOfMatch,
        tickets: [...request.tickets.keys()],
        finishedAtMs: null,
        host: createMatchHost({
          seed: request.seed,
          now,
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
      options.log?.(`Матч ${entry.id} заведён, seed ${String(request.seed)}`);
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
      matches.clear();
      seats.clear();
      admitted.clear();
    },
  };
};
