import { MS_PER_TICK, PLAYERS_PER_MATCH, asPlayerId } from '@td/shared';
import type { PlayerId } from '@td/shared';
import type { ClientMessage, ServerMessage } from '@td/protocol';
import { applyClientMessage, createMatchHost } from './host.js';
import type { MatchHost } from './host.js';
import { createMatchGuest } from './guest.js';
import type { GuestStatus, MatchGuest, MatchGuestOptions } from './guest.js';

/**
 * Стол: ведущий и два участника, связанные напрямую вызовами функций.
 *
 * Никаких сокетов и никакого настоящего времени — часы двигаются
 * вручную, сообщения летят с заданной задержкой. Благодаря этому матч
 * длиной в минуты прогоняется за миллисекунды, а «связь пропала
 * на пятнадцать секунд» проверяется без пятнадцати секунд ожидания.
 *
 * Разбор сообщений здесь тот же, что на сервере: `applyClientMessage`
 * общая. Иначе тест проверял бы не то, что работает в бою.
 */

export interface Clock {
  now(): number;
  advance(ms: number): void;
}

export const createClock = (start = 1_000): Clock => {
  let ms = start;
  return {
    now: () => ms,
    advance(delta) {
      ms += delta;
    },
  };
};

interface Envelope {
  readonly atMs: number;
  readonly deliver: () => void;
}

export interface Table {
  readonly host: MatchHost;
  readonly guests: readonly MatchGuest[];
  readonly clock: Clock;
  /** Односторонняя задержка доставки, миллисекунды. */
  setLatency(player: PlayerId, oneWayMs: number): void;
  /** Перестать доставлять сообщения участнику и от него. */
  setLinkUp(player: PlayerId, up: boolean): void;
  /** Прокрутить заданное время, доставляя сообщения и считая тики. */
  run(durationMs: number): void;
  /** Сообщения, доставленные участнику, для проверок. */
  received(player: PlayerId): readonly ServerMessage[];
}

export interface TableOptions {
  readonly seed: number;
  readonly latencyMs?: number;
  readonly guestOptions?: (player: PlayerId) => Partial<MatchGuestOptions>;
  /** Не подключать участников сразу — для проверки ожидания. */
  readonly joinNow?: boolean;
}

export const createTable = (options: TableOptions): Table => {
  const clock = createClock();
  const queue: Envelope[] = [];
  const latency = new Array<number>(PLAYERS_PER_MATCH).fill(options.latencyMs ?? 0);
  const linkUp = new Array<boolean>(PLAYERS_PER_MATCH).fill(true);
  const inbox: ServerMessage[][] = Array.from({ length: PLAYERS_PER_MATCH }, () => []);
  const statuses: GuestStatus[][] = Array.from({ length: PLAYERS_PER_MATCH }, () => []);

  const post = (player: PlayerId, deliver: () => void): void => {
    if (!linkUp[player]) return;
    queue.push({ atMs: clock.now() + (latency[player] ?? 0), deliver });
  };

  const host = createMatchHost({
    seed: options.seed,
    now: () => clock.now(),
    send(player, message) {
      post(player, () => {
        inbox[player]?.push(message);
        guests[player]?.receive(message);
      });
    },
  });

  const guests: MatchGuest[] = [];
  for (let index = 0; index < PLAYERS_PER_MATCH; index += 1) {
    const player = asPlayerId(index);
    const extra = options.guestOptions?.(player) ?? {};

    guests.push(
      createMatchGuest({
        ...extra,
        send(message: ClientMessage) {
          post(player, () => {
            applyClientMessage(host, player, message);
          });
        },
        onStatus(status) {
          statuses[player]?.push(status);
          extra.onStatus?.(status);
        },
      }),
    );
  }

  if (options.joinNow !== false) {
    for (let index = 0; index < PLAYERS_PER_MATCH; index += 1) {
      host.join(asPlayerId(index));
    }
  }

  const deliverDue = (): void => {
    const nowMs = clock.now();
    for (let index = 0; index < queue.length; index += 1) {
      const envelope = queue[index];
      if (envelope === undefined || envelope.atMs > nowMs) continue;

      queue.splice(index, 1);
      index -= 1;
      envelope.deliver();
    }
  };

  return {
    host,
    guests,
    clock,

    setLatency(player, oneWayMs) {
      latency[player] = oneWayMs;
    },

    setLinkUp(player, up) {
      linkUp[player] = up;
    },

    run(durationMs) {
      const stepMs = MS_PER_TICK / 2;
      let left = durationMs;

      while (left > 0) {
        const slice = Math.min(stepMs, left);
        clock.advance(slice);
        left -= slice;

        deliverDue();
        host.advance();
      }
    },

    received(player) {
      return inbox[player] ?? [];
    },
  };
};
