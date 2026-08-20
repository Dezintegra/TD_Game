import {
  CHECKSUM_INTERVAL_TICKS,
  INPUT_DELAY_JITTER_TICKS,
  INPUT_DELAY_MAX_TICKS,
  INPUT_DELAY_MIN_TICKS,
  MATCH_JOIN_TIMEOUT_SECONDS,
  MS_PER_TICK,
  PLAYERS_PER_MATCH,
  RECONNECT_GRACE_SECONDS,
  asPlayerId,
  asTickNumber,
  withPlayer,
} from '@td/shared';
import { checksum, createWorld, step } from '@td/sim';
import { MessageType, OutcomeReason } from '@td/protocol';
import type { Command, PlayerId, UnownedCommand } from '@td/shared';
import type { ClientMessage, ServerMessage } from '@td/protocol';
import type { WorldState } from '@td/sim';

/**
 * Ведущая сторона матча: тик, приём команд, рассылка кадров, исход.
 *
 * Это судья. Он владеет временем — решает, какой тик уже сыгран
 * и переписан быть не может; принимает команды и назначает им тик
 * исполнения; объявляет победителя. Всё остальное — клиент, компьютер,
 * запись матча — считает тот же мир из тех же команд и обязано с ним
 * сойтись.
 *
 * Транспорта здесь нет ни в каком виде: сообщения уходят через функцию
 * `send`, время приходит через функцию `now`. Благодаря этому весь матч
 * прогоняется в тесте без единого сокета и без единой настоящей секунды
 * ожидания.
 */

export type MatchPhase = 'awaiting-players' | 'running' | 'finished';

export interface MatchOutcome {
  readonly winner: PlayerId | null;
  readonly reason: OutcomeReason;
}

export interface MatchHostOptions {
  readonly seed: number;
  /** Часы в миллисекундах. Внедряются ради тестов и только ради них. */
  readonly now: () => number;
  readonly send: (player: PlayerId, message: ServerMessage) => void;
  /**
   * Предохранитель на число тиков за один вызов `advance`.
   *
   * Процесс сервера может встать на секунду — сборщик мусора, дисковая
   * заминка, что угодно. Без предела матч попытается наверстать долг
   * целиком в одном вызове и заблокирует цикл событий, а вместе с ним
   * и все остальные матчи.
   */
  readonly maxTicksPerAdvance?: number;
  /** Сколько истории отдавать одним сообщением. */
  readonly historyChunk?: number;
}

export interface MatchHost {
  /** Участник подключился к матчу. */
  join(player: PlayerId): void;
  /** Связь с участником потеряна: запускается отсчёт до поражения. */
  drop(player: PlayerId): void;
  /** Участник вышел сам — это немедленное поражение. */
  forfeit(player: PlayerId): void;
  /** Команда от участника. Сторона берётся отсюда, а не из сообщения. */
  submit(player: PlayerId, command: UnownedCommand): void;
  /** Участник просит историю команд начиная с тика. */
  serveHistory(player: PlayerId, fromTick: number): void;
  /** Ответ на замер канала. */
  observePong(player: PlayerId, nonce: number): void;
  /** Ответить на замер, затеянный участником. */
  pingBack(player: PlayerId, tick: number, nonce: number): void;
  /** Продвинуть матч к текущему моменту. Вызывается из цикла сервера. */
  advance(): void;
  readonly world: WorldState;
  readonly phase: MatchPhase;
  readonly outcome: MatchOutcome | null;
  readonly delayTicks: number;
  readonly history: readonly Command[];
}

interface Seat {
  connected: boolean;
  /** Когда потеряна связь; `null` — связь есть. */
  lostAtMs: number | null;
  /** Подключался ли участник к матчу хоть раз. */
  arrived: boolean;
  rttMs: number;
  pingNonce: number;
  pingSentAtMs: number;
}

const PING_INTERVAL_TICKS = 30;

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

/**
 * Отдать ведущему сообщение, пришедшее от участника.
 *
 * Возвращает `false` для `Join`: вход — единственное, что ведущий сам
 * решить не может. Билет проверяет тот, кто держит соединения, потому
 * что только он знает, какое соединение чьё.
 *
 * Функция живёт здесь, а не в сервере, ради второго её пользователя —
 * теста, который прогоняет матч целиком без сокетов. Две копии этого
 * разбора неминуемо разошлись бы, и разошлись бы незаметно: тест
 * проверял бы не то, что работает в бою.
 */
export const applyClientMessage = (
  host: MatchHost,
  player: PlayerId,
  message: ClientMessage,
): boolean => {
  switch (message.type) {
    case MessageType.Command:
      host.submit(player, message.command);
      return true;
    case MessageType.HistoryFrom:
      host.serveHistory(player, message.tick);
      return true;
    case MessageType.Pong:
      host.observePong(player, message.nonce);
      return true;
    case MessageType.Ping:
      host.pingBack(player, message.tick, message.nonce);
      return true;
    case MessageType.Join:
      return false;
  }
};

export const createMatchHost = (options: MatchHostOptions): MatchHost => {
  const maxTicks = options.maxTicksPerAdvance ?? 60;
  const historyChunk = options.historyChunk ?? 4096;

  let world = createWorld(options.seed);
  let phase: MatchPhase = 'awaiting-players';
  let outcome: MatchOutcome | null = null;
  let delayTicks = INPUT_DELAY_MIN_TICKS;

  /** Команды, ожидающие своего тика. */
  const pending = new Map<number, Command[]>();
  const history: Command[] = [];

  const seats: Seat[] = Array.from({ length: PLAYERS_PER_MATCH }, () => ({
    connected: false,
    lostAtMs: null,
    arrived: false,
    rttMs: 0,
    pingNonce: 0,
    pingSentAtMs: 0,
  }));

  const createdAtMs = options.now();
  let startedAtMs = 0;
  let nextNonce = 1;

  const seatOf = (player: PlayerId): Seat | undefined => seats[player];

  const broadcast = (message: ServerMessage): void => {
    for (let index = 0; index < seats.length; index += 1) {
      options.send(asPlayerId(index), message);
    }
  };

  const finish = (winner: PlayerId | null, reason: OutcomeReason): void => {
    if (phase === 'finished') return;

    phase = 'finished';
    outcome = { winner, reason };
    broadcast({ type: MessageType.MatchOver, winner, reason });
  };

  const otherSeat = (player: PlayerId): PlayerId => asPlayerId(player === 0 ? 1 : 0);

  /**
   * Пересчитать задержку ввода по худшему из каналов.
   *
   * Считается полное время кругового обхода, а не его половина, и это
   * не описка. Участник планирует команду от **своего подтверждённого**
   * тика, а тот отстаёт от серверного на время полёта кадра — половину
   * обхода. Пока команда летит обратно, набегает вторая половина. Задержка
   * в половину обхода означала бы, что команда приходит ровно на тик,
   * который сервер уже играет, то есть опаздывает всегда.
   *
   * Только вверх. Задержка, гуляющая вверх-вниз, рвёт предсказание при
   * каждом изменении, и дрожание управления раздражает сильнее, чем
   * стабильно большая задержка. Матч длится минуты — застревание
   * на худшем значении здесь меньшее зло.
   */
  const reconsiderDelay = (): void => {
    const worstRtt = seats.reduce((worst, seat) => Math.max(worst, seat.rttMs), 0);
    const wanted = clamp(
      Math.ceil(worstRtt / MS_PER_TICK) + INPUT_DELAY_JITTER_TICKS,
      INPUT_DELAY_MIN_TICKS,
      INPUT_DELAY_MAX_TICKS,
    );

    if (wanted <= delayTicks) return;

    delayTicks = wanted;
    broadcast({
      type: MessageType.InputDelay,
      delayTicks,
      // Вступает в силу не сейчас, а через задержку: команды, уже
      // отправленные по прежнему правилу, должны успеть исполниться там,
      // где их ждали.
      fromTick: world.tick + delayTicks,
    });
  };

  const welcome = (player: PlayerId): void => {
    options.send(player, {
      type: MessageType.Welcome,
      side: player,
      seed: options.seed,
      tick: world.tick,
      delayTicks,
    });
  };

  const tickOnce = (): void => {
    const tick = world.tick;
    const commands = pending.get(tick) ?? [];
    pending.delete(tick);

    world = step(world, commands);

    if (commands.length > 0) history.push(...commands);

    broadcast({ type: MessageType.TickFrame, tick, commands });

    if (world.tick % CHECKSUM_INTERVAL_TICKS === 0) {
      broadcast({ type: MessageType.Checksum, tick: world.tick, value: checksum(world) });
    }

    if (world.tick % PING_INTERVAL_TICKS === 0) {
      const sentAt = options.now();
      seats.forEach((seat, index) => {
        if (!seat.connected) return;

        seat.pingNonce = nextNonce;
        seat.pingSentAtMs = sentAt;
        nextNonce = (nextNonce + 1) >>> 0;

        options.send(asPlayerId(index), {
          type: MessageType.Ping,
          tick: world.tick,
          nonce: seat.pingNonce,
        });
      });
    }

    if (world.winner !== null) {
      finish(asPlayerId(world.winner), OutcomeReason.BaseDestroyed);
    }
  };

  /** Просрочки, которые проверяются независимо от того, идут ли тики. */
  const checkTimeouts = (): void => {
    const nowMs = options.now();

    if (phase === 'awaiting-players') {
      if (nowMs - createdAtMs < MATCH_JOIN_TIMEOUT_SECONDS * 1000) return;

      const missing = seats.findIndex((seat) => !seat.arrived);
      if (missing < 0) return;

      finish(otherSeat(asPlayerId(missing)), OutcomeReason.NoShow);
      return;
    }

    seats.forEach((seat, index) => {
      if (seat.lostAtMs === null) return;
      if (nowMs - seat.lostAtMs < RECONNECT_GRACE_SECONDS * 1000) return;

      finish(otherSeat(asPlayerId(index)), OutcomeReason.Disconnected);
    });
  };

  return {
    join(player) {
      const seat = seatOf(player);
      if (seat === undefined || phase === 'finished') return;

      seat.connected = true;
      seat.arrived = true;
      seat.lostAtMs = null;

      welcome(player);

      if (phase === 'awaiting-players' && seats.every((each) => each.arrived)) {
        phase = 'running';
        startedAtMs = options.now();
      }
    },

    drop(player) {
      const seat = seatOf(player);
      if (seat === undefined || !seat.connected) return;

      seat.connected = false;
      seat.lostAtMs = options.now();
    },

    forfeit(player) {
      if (phase === 'finished') return;
      finish(otherSeat(player), OutcomeReason.Left);
    },

    submit(player, command) {
      if (phase !== 'running') return;

      // Ближайший ещё не сыгранный тик — нижняя граница. Сыгранное
      // переписать нельзя, но и потерять команду нельзя: опоздавшая
      // уезжает вперёд, а не пропадает.
      const earliest = world.tick;
      // Верхняя граница — против попытки запланировать действие далеко
      // в будущее и тем самым сделать его невидимым для соперника
      // до самого исполнения.
      const latest = world.tick + delayTicks + INPUT_DELAY_MAX_TICKS;
      const at = clamp(command.tick, earliest, latest);

      const owned = withPlayer({ ...command, tick: asTickNumber(at) }, player);
      const list = pending.get(at);
      if (list === undefined) {
        pending.set(at, [owned]);
      } else {
        list.push(owned);
      }
    },

    serveHistory(player, fromTick) {
      const from = Math.max(0, fromTick);
      const slice = history.filter((command) => command.tick >= from).slice(0, historyChunk);

      // Докуда история заведомо полна. Если кусок упёрся в предел,
      // честнее сказать «по тик последней отданной команды», чем
      // пообещать больше, чем отдано: участник сам попросит продолжение.
      const throughTick =
        slice.length === historyChunk && slice.length > 0
          ? (slice[slice.length - 1]?.tick ?? from)
          : Math.max(from, world.tick - 1);

      options.send(player, {
        type: MessageType.History,
        fromTick: from,
        throughTick,
        commands: slice.filter((command) => command.tick <= throughTick),
      });
    },

    observePong(player, nonce) {
      const seat = seatOf(player);
      if (seat === undefined || seat.pingNonce !== nonce) return;

      seat.rttMs = Math.max(0, options.now() - seat.pingSentAtMs);
      reconsiderDelay();
    },

    pingBack(player, tick, nonce) {
      options.send(player, { type: MessageType.Pong, tick, nonce });
    },

    advance() {
      checkTimeouts();

      if (phase !== 'running') return;

      const elapsed = options.now() - startedAtMs;
      const target = Math.floor(elapsed / MS_PER_TICK);

      let budget = maxTicks;
      while (world.tick < target && budget > 0 && phase === 'running') {
        tickOnce();
        budget -= 1;
      }

      // Не успели наверстать — признаём отставание, а не копим долг.
      // Иначе после долгой заминки матч будет вечно догонять несуществующее
      // прошлое, тратя на это каждый вызов целиком.
      if (world.tick < target) {
        startedAtMs += (target - world.tick) * MS_PER_TICK;
      }
    },

    get world() {
      return world;
    },
    get phase() {
      return phase;
    },
    get outcome() {
      return outcome;
    },
    get delayTicks() {
      return delayTicks;
    },
    get history() {
      return history;
    },
  };
};
