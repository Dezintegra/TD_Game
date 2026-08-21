import { asPlayerId } from '@td/shared';
import { createMatchGuest } from '@td/netplay';
import { DEFAULT_PROFILE_ID, createOpponent, profileByName } from '@td/ai';
import { MessageType, decode, encode, isFromServer } from '@td/protocol';
import type { Command, CommandIntent, ComputerSide } from '@td/shared';
import type { GuestOutcome } from '@td/netplay';

/**
 * Компьютер за игровым столом: участник матча, ничем не отличимый
 * от человека с точки зрения сервера.
 *
 * Он ведёт собственную копию мира по тем же кадрам команд, решает
 * по подтверждённому состоянию и отправляет команды тем же путём,
 * получая ту же задержку ввода. Никакого доступа к состоянию сервера
 * у него нет — только сокет и протокол.
 *
 * Прежде противник жил внутри браузера игрока и получал три поблажки:
 * видел мир того тика, на котором решает, обходил очередь ввода
 * и считался в чужом кадре отрисовки. Здесь нет ни одной из них.
 */

export interface BotSocket {
  send(frame: ArrayBuffer): void;
  close(): void;
}

export interface SocketHandlers {
  onOpen(): void;
  onMessage(frame: ArrayBuffer): void;
  onClose(): void;
}

/** Как открыть соединение. Внедряется, чтобы тесты обходились без сети. */
export type OpenSocket = (url: string, handlers: SocketHandlers) => BotSocket;

export interface ParticipantOptions {
  readonly wsUrl: string;
  readonly ticket: string;
  /** Seed мира: из него выводится и seed решений. */
  readonly seed: number;
  readonly side: number;
  readonly openSocket: OpenSocket;
  readonly onOutcome?: (outcome: GuestOutcome) => void;
  readonly log?: (message: string) => void;
}

export interface Participant {
  stop(): void;
  readonly finished: boolean;
}

/**
 * Seed решений выводится из seed мира и стороны.
 *
 * Те же числа, что в арене, и это не совпадение: матч компьютера против
 * компьютера должен воспроизводиться одинаково независимо от того, где
 * он идёт — в безголовом прогоне или через сервер. Разные слагаемые
 * у сторон нужны, чтобы два компьютера в одном матче не играли зеркально
 * одно и то же.
 */
export const aiSeedOf = (seed: number, side: number): number =>
  side === 0 ? (seed ^ 0x5bf03635) >>> 0 : (seed ^ 0x2f6e1a77) >>> 0;

/**
 * Чем компьютер думает на этой стороне.
 *
 * Спрашивать об этом надо здесь, а не выводить у себя. Записи матча нужно
 * знать профиль и seed решений, чтобы воспроизведение собрало того же
 * противника, и любой второй источник этих сведений рано или поздно
 * разойдётся с настоящим. Ровно так клиент писал `profiles: []`
 * и `aiSeeds: [0, 0]` — правдоподобную неправду.
 *
 * Тем же значением пользуется и `joinMatch` ниже: у ответа и у дела один
 * источник.
 */
export const computerMindOf = (worldSeed: number, side: number): ComputerSide => ({
  who: 'computer',
  profile: DEFAULT_PROFILE_ID,
  seed: aiSeedOf(worldSeed, side),
});

/** Команда, отданная противником, — это намерение: тик и сторону проставят за него. */
const intentOf = (command: Command): CommandIntent => {
  const { player: _player, tick: _tick, ...intent } = command;
  return intent as CommandIntent;
};

export const joinMatch = (options: ParticipantOptions): Participant => {
  const me = asPlayerId(options.side);
  // Профиль и seed берутся оттуда же, откуда о них узнаёт запись матча.
  // Разойтись они не могут по построению.
  const mind = computerMindOf(options.seed, options.side);
  const opponent = createOpponent(me, mind.seed, profileByName(mind.profile));

  let socket: BotSocket | undefined;
  let finished = false;

  const guest = createMatchGuest({
    send: (message) => socket?.send(encode(message)),

    onFrame: () => {
      // Решения принимаются по подтверждённому состоянию — тому самому,
      // которое видит соперник-человек в своей подтверждённой копии.
      // Предсказанная копия здесь не нужна вовсе: рисовать нечего,
      // а заглядывать в собственное предсказание значило бы принимать
      // решения по миру, которого ещё нет.
      if (guest.status !== 'playing') return;

      const world = guest.confirmed;
      if (world === null) return;

      for (const command of opponent.decide(world)) {
        guest.issue(intentOf(command));
      }
    },

    onOutcome: (outcome) => {
      finished = true;
      options.onOutcome?.(outcome);
    },

    onDesync: (tick, recovering) => {
      options.log?.(
        recovering
          ? `Компьютер разошёлся с сервером на тике ${String(tick)}, пересобираю`
          : `Компьютер не сошёлся с сервером после пересборки, тик ${String(tick)}`,
      );
    },
  });

  socket = options.openSocket(options.wsUrl, {
    onOpen: () => {
      // Билет — первое, что уходит в матч: до него сервер не знает,
      // чьё это соединение, и адресовать команды ему некому.
      socket?.send(encode({ type: MessageType.Join, ticket: options.ticket }));
    },
    onMessage: (frame) => {
      const result = decode(frame);
      if (!result.ok) {
        options.log?.(`Компьютер отклонил кадр: ${result.error}`);
        return;
      }

      if (!isFromServer(result.message)) return;
      guest.receive(result.message);
    },
    onClose: () => {
      finished = true;
    },
  });

  return {
    stop() {
      socket?.close();
      socket = undefined;
      finished = true;
    },
    get finished() {
      return finished;
    },
  };
};
