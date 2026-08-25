import { asPlayerId } from '@td/shared';
import { createMatchGuest } from '@td/netplay';
import { DEFAULT_PROFILE_ID, createOpponent, profileByName } from '@td/ai';
import { MessageType, decode, encode, isFromServer } from '@td/protocol';
import { computerMindOf } from '@td/shared';
import type { Command, CommandIntent } from '@td/shared';
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
  /** Какой манерой играть. Не указана — умолчание библиотеки. */
  readonly profile?: string;
  readonly openSocket: OpenSocket;
  readonly onOutcome?: (outcome: GuestOutcome) => void;
  readonly log?: (message: string) => void;
  /** Приборы. Отсутствуют — не меряется ничего и не тратится ничего. */
  readonly measure?: ParticipantMeasure | undefined;
}

/**
 * Прибор для раздумий компьютера.
 *
 * Часов здесь нет, и это то же решение, что у ведущего: пакет отдаёт
 * работу обёртке, а чем её засечь — решает тот, кто прибор поставил.
 * Так `packages/bot` остаётся без платформенных вызовов, а замер
 * можно проверить, не подменяя `performance`.
 *
 * Обёртка получает не длительность, а само решение целиком, и потому
 * знает обе величины сразу — сколько заняло и сколько команд дало.
 * Два отдельных вызова однажды разошлись бы: один остался бы
 * в ветке, из которой второй убрали.
 */
export interface ParticipantMeasure {
  /**
   * Обернуть одно решение замером. Обязана вызвать `run` ровно один
   * раз и вернуть его результат нетронутым: решения компьютера
   * прибором не правятся.
   */
  readonly decision: (run: () => readonly Command[]) => readonly Command[];
}

export interface Participant {
  stop(): void;
  readonly finished: boolean;
}

/**
 * Seed решений и манера компьютерной стороны выводятся в `@td/shared`.
 *
 * Вывод там, а не здесь, потому что нужен он двоим сразу: и компьютеру,
 * который собирает противника, и серверу, который пишет состав сторон
 * в запись матча. Любой второй источник этих сведений рано или поздно
 * разойдётся с настоящим — ровно так клиент писал `profiles: []`
 * и `aiSeeds: [0, 0]`, правдоподобную неправду.
 *
 * Здесь они переизданы затем, чтобы вызывающим не пришлось знать, что
 * вывод переехал: `joinMatch` ниже пользуется тем же значением, что
 * и ответ на вопрос «какой манерой играет эта сторона».
 */
export { aiSeedOf, computerMindOf } from '@td/shared';

/** Команда, отданная противником, — это намерение: тик и сторону проставят за него. */
const intentOf = (command: Command): CommandIntent => {
  const { player: _player, tick: _tick, ...intent } = command;
  return intent as CommandIntent;
};

export const joinMatch = (options: ParticipantOptions): Participant => {
  const me = asPlayerId(options.side);
  // Профиль и seed берутся оттуда же, откуда о них узнаёт запись матча.
  // Разойтись они не могут по построению.
  const mind = computerMindOf(options.seed, options.side, options.profile ?? DEFAULT_PROFILE_ID);
  const opponent = createOpponent(me, mind.seed, profileByName(mind.profile));

  let socket: BotSocket | undefined;
  let finished = false;

  const guest = createMatchGuest({
    send: (message) => socket?.send(encode(message)),

    // Предсказанная копия здесь не нужна вовсе: рисовать нечего,
    // а заглядывать в собственное предсказание значило бы принимать
    // решения по миру, которого ещё нет.
    //
    // Раньше это было объяснением, почему её не читают, — и она всё
    // равно считалась: горизонт пересобирался на каждый пришедший кадр
    // и на каждую отданную команду. За три минуты матча это 5622
    // пересборки и 16 866 напрасных шагов мира. Теперь это описание
    // поведения: не читаем, потому что не считаем.
    //
    // Компьютер живёт в том же процессе, что рассылка кадров, поэтому
    // лишний счёт здесь задевал не только его.
    predict: false,

    onFrame: () => {
      // Решения принимаются по подтверждённому состоянию — тому самому,
      // которое видит соперник-человек в своей подтверждённой копии.
      if (guest.status !== 'playing') return;

      const world = guest.confirmed;
      if (world === null) return;

      // Замер обнимает ровно решение и ничего сверх: отправка команд
      // ниже — это уже сеть, и мешать её в одну величину с раздумьями
      // значило бы получить число, из которого ничего не следует.
      //
      // Меряется при этом не всякий вызов, а только тот, в котором
      // противник правда думает. `decide` зовётся каждый тик и в
      // четырнадцати случаях из пятнадцати возвращается сразу; замер,
      // их не различающий, показал бы среднее решения с четырнадцатью
      // пустыми возвратами — то есть занизил бы цену раздумий
      // и завысил бы их частоту. Проверено на живом матче: 4165 вызовов
      // против 240 настоящих решений.
      const measure = options.measure;
      const thinking = world.tick >= opponent.nextDecisionTick;
      const commands =
        measure === undefined || !thinking
          ? opponent.decide(world)
          : measure.decision(() => opponent.decide(world));

      for (const command of commands) {
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
