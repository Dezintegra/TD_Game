import {
  CHECKSUM_INTERVAL_TICKS,
  PREDICTION_REPLAY_LIMIT_TICKS,
  asPlayerId,
  asTickNumber,
  atTick,
  withPlayer,
} from '@td/shared';
import { checksum, createWorld, step } from '@td/sim';
import { MessageType } from '@td/protocol';
import type { Command, CommandIntent, PlayerId, UnownedCommand } from '@td/shared';
import type { ClientMessage, OutcomeReason, ServerMessage } from '@td/protocol';
import type { WorldState } from '@td/sim';
import { byTick } from './replay.js';

/**
 * Сторона участника: то, чем матч выглядит изнутри клиента или компьютера.
 *
 * Здесь живут две копии мира, и различие между ними — самое важное
 * во всём пакете.
 *
 * **Подтверждённая** копия двигается строго кадрами от сервера. Это
 * истина. Она только растёт вперёд: переписывать её нечем, потому что
 * сыгранный тик сервер не пересылает.
 *
 * **Предсказанная** копия — подтверждённая плюс собственные ещё
 * не подтверждённые команды, продвинутая на задержку ввода вперёд.
 * Её и показывают игроку. Считается она тем же `step`, поэтому отдельной
 * реализации правил движения, стрельбы или постройки не существует —
 * а значит, и расходиться нечему.
 *
 * Команды соперника не предсказываются вовсе. Это не уступка, а следствие
 * устройства игры: команды здесь задают намерение («иду туда», «цель —
 * та башня»), а не мгновенный импульс, поэтому продолжение прежнего
 * намерения — верная догадка почти всегда.
 */

export type GuestStatus =
  /** Ещё не получено приветствие: матча нет. */
  | 'idle'
  /** Мир восстанавливается из истории команд. */
  | 'catching-up'
  /** Обычная игра. */
  | 'playing'
  /** Обнаружено расхождение, идёт пересборка. */
  | 'desynced'
  /** Пересборка не помогла: играть дальше нельзя. */
  | 'stopped'
  | 'finished';

export interface GuestOutcome {
  readonly winner: PlayerId | null;
  readonly reason: OutcomeReason;
}

export interface MatchGuestOptions {
  readonly send: (message: ClientMessage) => void;
  readonly onStatus?: (status: GuestStatus) => void;
  /** Кадр применён к подтверждённой копии: тик и его команды. */
  readonly onFrame?: (tick: number, commands: readonly Command[]) => void;
  /**
   * Предсказание пересобрано — то есть изменилось то, что видит игрок.
   *
   * Через этот вызов интерфейс узнаёт о новом состоянии мира, а не через
   * цикл отрисовки, и это принципиально: браузер замораживает отрисовку
   * в скрытой вкладке, а сеть продолжает идти. Показания, снятые
   * из отрисовки, в такой вкладке просто застывают.
   */
  readonly onPredicted?: (world: WorldState) => void;
  readonly onOutcome?: (outcome: GuestOutcome) => void;
  /** Расхождение на тике. Вызывается и когда пересборка не помогла. */
  readonly onDesync?: (tick: number, recovering: boolean) => void;
  /**
   * Считать ли предсказанную копию мира. По умолчанию — считать.
   *
   * Предсказание — возможность участника, а не его обязанность. Участие
   * в матче и отрисовка мира совпадают только у клиента человека:
   * компьютер играет полноправным участником, но не рисует ничего
   * и решает по подтверждённому состоянию, поэтому пересчёт горизонта
   * для него — работа, результата которой никто не читает.
   *
   * Признак сделан явным, а не выведен из отсутствия `onPredicted`,
   * и это не педантизм. `predicted` читается и без подписки — клиент
   * так и делает, — поэтому догадка «нет обработчика, значит не нужно»
   * связала бы две независимые вещи: способ узнать об обновлении
   * и потребность в самом значении. Первый же читатель, обошедшийся
   * без подписки, получил бы застывший мир. Молча.
   *
   * На ход матча выключение не влияет никак: предсказанная копия
   * на подтверждённую не влияет ни при каких условиях.
   */
  readonly predict?: boolean;
}

export interface MatchGuest {
  receive(message: ServerMessage): void;
  /**
   * Отдать своё действие: оно немедленно попадает в предсказание
   * и уходит на сервер. Возвращает отправленную команду или `null`,
   * если матч сейчас команд не принимает.
   */
  issue(intent: CommandIntent): UnownedCommand | null;
  readonly side: PlayerId | null;
  readonly confirmed: WorldState | null;
  readonly predicted: WorldState | null;
  readonly status: GuestStatus;
  readonly outcome: GuestOutcome | null;
  readonly delayTicks: number;
  /** Тик, на котором, по нашим сведениям, находится сервер. */
  readonly serverTick: number;
  /**
   * Сколько собственных команд ещё не вернулись кадром.
   *
   * Величина нужна интерфейсу: игрок вправе знать, что действие принято
   * и летит, а не пропало. Показывать её обязательно там, где мир меняется
   * не сразу.
   */
  readonly pendingCount: number;
}

/** Сколько своих контрольных сумм помним, ожидая серверные. */
const CHECKSUM_MEMORY = 16;

export const createMatchGuest = (options: MatchGuestOptions): MatchGuest => {
  // Умолчание — считать: предсказание нужно всем, кто мир показывает,
  // а не показывает его ровно один участник из трёх видов.
  const predicting = options.predict ?? true;

  let side: PlayerId | null = null;
  let seed = 0;
  let confirmed: WorldState | null = null;
  let predicted: WorldState | null = null;
  let status: GuestStatus = 'idle';
  let outcome: GuestOutcome | null = null;
  let delayTicks = 0;
  let serverTick = 0;

  /** Собственные команды, ещё не пришедшие обратно кадром. */
  const own = new Map<number, UnownedCommand[]>();
  /** Кадры, пришедшие раньше своей очереди. */
  const buffered = new Map<number, readonly Command[]>();
  /** Наши контрольные суммы и присланные сервером, ждущие встречи. */
  const mine = new Map<number, number>();
  const expected = new Map<number, number>();

  let pendingDelay: { readonly ticks: number; readonly fromTick: number } | null = null;
  let awaitingHistory = false;
  let recoveredOnce = false;

  const setStatus = (next: GuestStatus): void => {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
  };

  const forget = (upToTick: number): void => {
    for (const tick of own.keys()) {
      if (tick <= upToTick) own.delete(tick);
    }
    for (const tick of mine.keys()) {
      if (tick < upToTick - CHECKSUM_MEMORY * CHECKSUM_INTERVAL_TICKS) mine.delete(tick);
    }
  };

  /**
   * Пол показа: тик, ниже которого картинка опускаться не вправе.
   *
   * Собственная команда назначается на `подтверждённый + задержка`
   * (см. `issue`), и чтобы игрок увидел её действие немедленно, этот
   * тик обязан войти в показ — отсюда «плюс один». Опустись показ ниже,
   * нажатие перестало бы давать отклик в том же кадре, то есть
   * сломалось бы главное требование проекта.
   */
  const displayFloor = (): number => (confirmed === null ? 0 : confirmed.tick + delayTicks + 1);

  /**
   * Тик, который должен быть на экране.
   *
   * Сегодня это ровно пол. Отдельная функция существует затем, чтобы
   * место, где показ обгоняет подтверждённое состояние, было одно
   * и называлось вслух.
   */
  const displayTarget = (): number => displayFloor();

  /**
   * Пересобрать предсказание от подтверждённого состояния.
   *
   * Горизонт — расстояние от подтверждённого тика до целевого,
   * обрезанное предохранителем. Предохранитель не украшение: без него
   * долгая заминка обернулась бы многосекундным пересчётом внутри
   * одного кадра.
   *
   * Участник без предсказания уходит по первой же ветке: показываемое
   * состояние у него равно подтверждённому, и шагов симуляции здесь
   * не делается ни одного. Обработчик при этом вызывается по-прежнему —
   * он сообщает не о предсказании, а о том, что показываемое состояние
   * обновилось, и участнику без предсказания оно тоже обновляется.
   */
  const rebuild = (): void => {
    if (confirmed === null || side === null || !predicting) {
      predicted = confirmed;
      if (predicted !== null) options.onPredicted?.(predicted);
      return;
    }

    const horizon = Math.min(
      Math.max(displayTarget() - confirmed.tick, 0),
      PREDICTION_REPLAY_LIMIT_TICKS,
    );
    const me = side;
    let world = confirmed;

    for (let index = 0; index < horizon; index += 1) {
      const commands = own.get(world.tick);
      world = step(
        world,
        commands === undefined ? [] : commands.map((command) => withPlayer(command, me)),
      );
    }

    predicted = world;
    options.onPredicted?.(world);
  };

  const verify = (tick: number, value: number): void => {
    const ours = mine.get(tick);
    if (ours === undefined || ours === value) return;

    if (recoveredOnce) {
      // Пересборка из полной истории уже была и дала другой результат,
      // чем у сервера. Значит расходятся не данные, а код, и повторять
      // бессмысленно: играть дальше — играть в мир, которого нет.
      options.onDesync?.(tick, false);
      setStatus('stopped');
      return;
    }

    recoveredOnce = true;
    options.onDesync?.(tick, true);
    setStatus('desynced');

    confirmed = createWorld(seed);
    predicted = confirmed;
    own.clear();
    buffered.clear();
    mine.clear();
    expected.clear();
    awaitingHistory = true;
    options.send({ type: MessageType.HistoryFrom, tick: 0 });
  };

  const remember = (world: WorldState): void => {
    if (world.tick % CHECKSUM_INTERVAL_TICKS !== 0) return;

    const value = checksum(world);
    mine.set(world.tick, value);

    const promised = expected.get(world.tick);
    if (promised !== undefined) {
      expected.delete(world.tick);
      verify(world.tick, promised);
    }
  };

  /** Применить всё, что уже можно применить, не оставляя дыр. */
  const drain = (): void => {
    if (confirmed === null || status === 'stopped') return;

    for (;;) {
      const commands = buffered.get(confirmed.tick);
      if (commands === undefined) break;

      const tick = confirmed.tick;
      buffered.delete(tick);
      confirmed = step(confirmed, commands);

      forget(tick);
      remember(confirmed);
      options.onFrame?.(tick, commands);

      if (pendingDelay !== null && confirmed.tick >= pendingDelay.fromTick) {
        delayTicks = pendingDelay.ticks;
        pendingDelay = null;
      }
    }

    // В буфере есть кадры, но не тот, что нужен следующим: где-то потеряна
    // середина. Дыру нельзя ни перепрыгнуть, ни выдумать — только запросить.
    if (buffered.size > 0 && !awaitingHistory && status !== 'desynced') {
      awaitingHistory = true;
      options.send({ type: MessageType.HistoryFrom, tick: confirmed.tick });
    }

    if (status === 'catching-up' && buffered.size === 0 && !awaitingHistory) {
      setStatus('playing');
    }

    rebuild();
  };

  return {
    receive(message) {
      switch (message.type) {
        case MessageType.Welcome: {
          side = asPlayerId(message.side);
          seed = message.seed;
          delayTicks = message.delayTicks;
          serverTick = message.tick;

          confirmed = createWorld(seed);
          predicted = confirmed;
          own.clear();
          buffered.clear();
          mine.clear();
          expected.clear();
          pendingDelay = null;
          recoveredOnce = false;

          if (message.tick > 0) {
            // Матч уже идёт: мы либо вернулись после разрыва, либо
            // подключились с опозданием. Мир восстанавливается только
            // командами — снимков состояния в этом протоколе нет.
            awaitingHistory = true;
            setStatus('catching-up');
            options.send({ type: MessageType.HistoryFrom, tick: 0 });
          } else {
            awaitingHistory = false;
            setStatus('playing');
          }

          rebuild();
          break;
        }

        case MessageType.TickFrame: {
          serverTick = Math.max(serverTick, message.tick + 1);
          if (confirmed === null || message.tick < confirmed.tick) break;

          buffered.set(message.tick, message.commands);
          drain();
          break;
        }

        case MessageType.History: {
          if (confirmed === null) break;

          awaitingHistory = false;
          serverTick = Math.max(serverTick, message.throughTick + 1);

          const map = byTick(message.commands);
          if (message.throughTick >= confirmed.tick) {
            let world = confirmed;
            const target = message.throughTick;

            while (world.tick <= target) {
              const commands = map.get(world.tick) ?? [];
              const tick = world.tick;
              world = step(world, commands);
              remember(world);
              options.onFrame?.(tick, commands);
            }

            confirmed = world;
            forget(confirmed.tick - 1);
          }

          if (message.throughTick + 1 < serverTick && buffered.get(confirmed.tick) === undefined) {
            awaitingHistory = true;
            options.send({ type: MessageType.HistoryFrom, tick: confirmed.tick });
          }

          drain();
          break;
        }

        case MessageType.Checksum: {
          serverTick = Math.max(serverTick, message.tick);

          const ours = mine.get(message.tick);
          if (ours === undefined) {
            // Сумма пришла раньше, чем мы досчитали до этого тика.
            // Отложим и сверим, когда дойдём: сумма никуда не денется.
            expected.set(message.tick, message.value);
          } else {
            verify(message.tick, message.value);
          }
          break;
        }

        case MessageType.InputDelay: {
          pendingDelay = { ticks: message.delayTicks, fromTick: message.fromTick };
          if (confirmed !== null && confirmed.tick >= message.fromTick) {
            delayTicks = message.delayTicks;
            pendingDelay = null;
            rebuild();
          }
          break;
        }

        case MessageType.MatchOver: {
          outcome = {
            winner: message.winner === null ? null : asPlayerId(message.winner),
            reason: message.reason,
          };
          options.onOutcome?.(outcome);
          setStatus('finished');
          break;
        }

        case MessageType.Ping: {
          options.send({ type: MessageType.Pong, tick: message.tick, nonce: message.nonce });
          break;
        }

        case MessageType.Pong:
          break;
      }
    },

    issue(intent) {
      if (confirmed === null || side === null) return null;
      if (status !== 'playing') return null;

      const tick = confirmed.tick + delayTicks;
      const command = atTick(intent, asTickNumber(tick));

      const list = own.get(tick);
      if (list === undefined) {
        own.set(tick, [command]);
      } else {
        list.push(command);
      }

      options.send({ type: MessageType.Command, command });
      rebuild();

      return command;
    },

    get side() {
      return side;
    },
    get confirmed() {
      return confirmed;
    },
    // Участник без предсказания отдаёт подтверждённое состояние,
    // и отдаёт его отсюда, а не из переменной. Разница в том, что
    // здесь это верно всегда, а в переменной — лишь пока никто
    // не добавил ветку, из которой `rebuild` не вызывается. Второе
    // сломалось бы молча и выглядело бы исправным `WorldState`,
    // отстающим от матча.
    get predicted() {
      return predicting ? predicted : confirmed;
    },
    get status() {
      return status;
    },
    get outcome() {
      return outcome;
    },
    get delayTicks() {
      return delayTicks;
    },
    get serverTick() {
      return serverTick;
    },
    get pendingCount() {
      let total = 0;
      for (const list of own.values()) total += list.length;
      return total;
    },
  };
};
