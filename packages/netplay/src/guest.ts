import {
  CHECKSUM_INTERVAL_TICKS,
  COMMAND_CARRY_LIMIT_TICKS,
  DISPLAY_LEAD_TICKS,
  MS_PER_TICK,
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
  /**
   * Часы показа в миллисекундах.
   *
   * Отсутствуют — показываемая копия двигается только приходом кадров,
   * ровно как раньше. Это режим всякого, кто мира не рисует: компьютера
   * и проверок.
   *
   * Внедряются, а не читаются изнутри: `packages/netplay` обязан
   * оставаться без платформенных вызовов, и ведущий решает ту же задачу
   * тем же способом.
   */
  readonly now?: () => number;
  /**
   * Своя команда вернулась кадром, и вот на сколько тактов её сдвинули.
   *
   * Ноль — исполнена там, где её ждали. Больше нуля — опоздала: такт
   * назначения сервер уже сыграл и передвинул команду вперёд. Это
   * прямая причина скачка картинки, потому что показать её действие
   * клиент успел ещё на назначенном такте.
   *
   * Обработчика нет — очередь отданных команд не ведётся вовсе,
   * и участник не платит за диагностику ни памятью, ни временем.
   */
  readonly onCommandShift?: (ticks: number) => void;
}

export interface MatchGuest {
  receive(message: ServerMessage): void;
  /**
   * Продвинуть показываемый мир по местным часам.
   *
   * Зовётся из цикла отрисовки, один раз на кадр, и только там: кадр
   * отрисовки — естественный момент спросить, который час, потому что
   * именно к нему готовится картинка.
   *
   * Без часов в настройках не делает ничего.
   */
  advance(): void;
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

  /**
   * Якорь часов показа: тик и время, когда часы на него встали.
   *
   * Время `NaN` означает, что часы не заведены, — так бывает до первого
   * кадра и после всякой смены состояния. Заводятся они сами, при первом
   * же вопросе о целевом тике.
   */
  let anchorTick = 0;
  let anchorAtMs = Number.NaN;

  /**
   * Такты, на которые назначались свои команды, в порядке отправки.
   *
   * Сопоставление идёт по порядку, а не по содержимому, и это не лень.
   * Сервер складывает команды игрока в порядке получения и двигает
   * опоздавшую только вперёд — значит порядок на выходе тот же, что
   * на входе. Две же одинаковые команды подряд по содержимому
   * неразличимы, и сравнение выбрало бы не ту.
   */
  const issuedTicks: number[] = [];

  /**
   * Собственные команды, ещё не пришедшие обратно кадром.
   *
   * Ключ — тик, на котором команду **ждут**, а поле `tick` самой команды
   * остаётся тем, на который её назначили при отправке. Расходятся эти
   * два числа намеренно: команду, не увиденную в кадре своего тика,
   * клиент переставляет вперёд (см. `settle`), и тогда ключ говорит
   * «где ждём», а `tick` — «на что назначали». Второе нужно, чтобы
   * знать, давно ли команда в пути.
   *
   * Никого это не обманывает: `step` поля `tick` не читает вовсе,
   * а на сервер команда ушла в исходном виде ещё при отправке.
   */
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
    // Часы сбрасываются при всякой смене состояния, и это не осторожность
    // впрок. Пока шёл догон по истории, часы стояли, а якорь остался
    // в прошлом; не сбрось его — на выходе из догона накопившееся время
    // разом швырнуло бы показ в потолок.
    anchorAtMs = Number.NaN;
    options.onStatus?.(next);
  };

  /** Забыть контрольные суммы, которые сверять уже не с чем. */
  const forgetChecksums = (upToTick: number): void => {
    for (const tick of mine.keys()) {
      if (tick < upToTick - CHECKSUM_MEMORY * CHECKSUM_INTERVAL_TICKS) mine.delete(tick);
    }
  };

  /**
   * Уладить очередь своих команд после того, как мир продвинулся.
   *
   * `played` — сколько своих команд было в проигранных кадрах. Столько
   * самых старых записей снимается с очереди: они подтверждены. Всё
   * остальное, что осталось на тиках ниже подтверждённого, **не теряется,
   * а переставляется** на `confirmed.tick`.
   *
   * Почему переставляется. Сервер отдать команду назад не умеет:
   * опоздавшую он двигает вперёд (`clamp` в `host.ts`), а отданную
   * до начала матча ставит в очередь. Значит своя команда, не пришедшая
   * кадром, — ещё летящая, и удалять её из предсказания значит показать
   * игроку исчезновение действия, которое через долю секунды вернётся.
   * Ровно это и мигало: заказанная пачка на доли секунды худела вдвое.
   *
   * Почему именно на `confirmed.tick`. Куда сервер положил команду,
   * клиент узнаёт только из кадра. Честная догадка одна — «на ближайший,
   * который сервер ещё не сыграл». Догадка может оказаться короткой,
   * тогда следующий кадр придёт снова без команды и она переедет ещё
   * на тик. На экране при этом не меняется ничего: команда каждый раз
   * применяется первым же шагом пересборки, то есть её действие видно
   * непрерывно.
   *
   * Оставить команду лежать на сыгранном тике было бы не легче, а хуже:
   * `rebuild` ключи ниже `confirmed.tick` не читает никогда, так что
   * картинка просела бы точно так же, а карта росла бы вечно.
   *
   * Сопоставление по порядку, а не по содержимому, — по той же причине,
   * что и в `issuedTicks`: две одинаковые команды подряд по полям
   * неразличимы.
   *
   * Отвергнутая ядром команда считается пришедшей. Кадр перечисляет
   * команды, **исполнявшиеся** на тике, независимо от того, приняло их
   * ядро или нет, — значит отказ виден, и предсказание поправляется
   * один раз, законной поправкой.
   */
  const settle = (played: number): void => {
    if (confirmed === null) return;

    const boundary = confirmed.tick;
    const stale = [...own.keys()].filter((tick) => tick < boundary).sort((a, b) => a - b);
    if (stale.length === 0) return;

    let left = played;
    const carried: UnownedCommand[] = [];

    for (const tick of stale) {
      const list = own.get(tick) ?? [];
      own.delete(tick);

      for (const command of list) {
        // Подтверждена кадром: снимаем с очереди.
        if (left > 0) {
          left -= 1;
          continue;
        }

        // Несём слишком долго. Дальше нести — врать дольше, чем стоит
        // любая просадка: команда, которой нет в кадрах вторую секунду,
        // скорее всего не долетела вовсе.
        if (boundary - command.tick > COMMAND_CARRY_LIMIT_TICKS) continue;

        carried.push(command);
      }
    }

    if (carried.length === 0) return;

    // Перенесённые старше всего, что могло бы лежать на границе, поэтому
    // встают перед ним. В сегодняшнем коде ячейка границы всегда пуста:
    // свежая команда получает тик `подтверждённый + задержка`, а задержка
    // не меньше INPUT_DELAY_MIN_TICKS. Порядок здесь на случай, если
    // это перестанет быть правдой.
    own.set(boundary, [...carried, ...(own.get(boundary) ?? [])]);
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
   * Без часов — ровно пол: показ двигается приходом кадров, как было
   * всегда. С часами картинка идёт своим ходом, и правил у неё три.
   *
   * **Пол.** Ниже нельзя никогда: там остались бы собственные команды.
   * Провалившись под пол, часы встают на него заново — с запасом,
   * чтобы не проваливаться обратно на следующем же кадре.
   *
   * **Потолок** — подтверждённый плюс предохранитель. Дальше врать
   * нельзя: на длинной заминке картинка обязана честно остановиться,
   * а не уехать в выдуманное будущее. Остановка эта не молчаливая —
   * её ловит прибор промежутков показа на клиенте.
   *
   * **Ход.** Между полом и потолком тик прибавляется каждые
   * `MS_PER_TICK` местного времени, и ни приход кадра, ни его опоздание
   * на это не влияют. В этом весь смысл затеи.
   *
   * Функция не только считает, но и ведёт якорь часов, то есть имеет
   * последствия. Звать её можно сколько угодно раз за кадр: часы
   * монотонны, и цель от повторного вопроса только растёт.
   */
  const displayTarget = (): number => {
    const floor = displayFloor();
    const clock = options.now;
    if (clock === undefined || confirmed === null || status !== 'playing') return floor;

    const nowMs = clock();
    if (Number.isNaN(anchorAtMs)) {
      anchorTick = floor + DISPLAY_LEAD_TICKS;
      anchorAtMs = nowMs;
    }

    let target = anchorTick + Math.floor((nowMs - anchorAtMs) / MS_PER_TICK);
    if (target < floor) {
      anchorTick = floor + DISPLAY_LEAD_TICKS;
      anchorAtMs = nowMs;
      target = anchorTick;
    }

    return Math.min(target, confirmed.tick + PREDICTION_REPLAY_LIMIT_TICKS);
  };

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

  /**
   * Продлить показ шагом от него самого, не пересобирая от основы.
   *
   * Когда двинулись только часы, а новых данных нет, тот же результат
   * получается одним шагом вместо `задержка + 2`:
   *
   * ```
   * step(показанный, свои команды на его тике) ≡ rebuild(горизонт + 1)
   * ```
   *
   * Тождество держится на чистоте `step` — той самой, которой требует
   * спецификация ядра, — и не оставлено рассуждением: его сличает тест.
   * Разойдись эти два пути, показываемый мир зависел бы от того, каким
   * путём его посчитали.
   *
   * Дешевизна важна именно там, где всё затевалось: во время заминки
   * канала часы двигают показ каждый тик, а пересобирать нечего —
   * основа не менялась.
   */
  const extend = (target: number): void => {
    if (confirmed === null || predicted === null) return;

    // Потолок здесь второй раз, и это не перестраховка впрок: цель
    // приходит уже обрезанной, но `extend` обязан оставаться безопасным
    // сам по себе — иначе первый же будущий вызов с непроверенной целью
    // увёл бы клиент в многосекундный пересчёт внутри кадра.
    const ceiling = confirmed.tick + PREDICTION_REPLAY_LIMIT_TICKS;
    let world = predicted;

    // Шаги идут без команд, и это не упущение. Собственная команда
    // назначается на `подтверждённый + задержка`, то есть ровно на тик
    // ниже пола, а показываемый тик пола не ниже никогда. Значит всё
    // своё уже применено пересборкой к моменту, когда часы попросят
    // следующий тик, и подмешивать здесь нечего.
    //
    // Утверждение это не рассуждение на полях: его пиннит тест
    // «собственная команда всегда ниже показываемого тика». Сломайся
    // правило пола — упадёт он, и упадёт здесь, а не в жалобе игрока
    // на пропавшее нажатие.
    while (world.tick < target && world.tick < ceiling) {
      world = step(world, []);
    }

    if (world === predicted) return;

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
    issuedTicks.length = 0;
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

  /** Сколько в списке команд нашей стороны. */
  const countMine = (commands: readonly Command[]): number => {
    if (side === null) return 0;

    let total = 0;
    for (const command of commands) if (command.player === side) total += 1;

    return total;
  };

  /**
   * Отметить, на сколько сервер сдвинул вернувшиеся свои команды.
   *
   * Пустая очередь — не ошибка: так бывает после пересборки, когда
   * история приносит команды, отданные ещё до неё. Сказать про них
   * нечего, и выдумывать нечего.
   */
  const noteShifts = (tick: number, commands: readonly Command[]): void => {
    const report = options.onCommandShift;
    if (report === undefined || side === null) return;

    for (const command of commands) {
      if (command.player !== side) continue;

      const issuedAt = issuedTicks.shift();
      if (issuedAt === undefined) continue;

      report(tick - issuedAt);
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

      settle(countMine(commands));
      forgetChecksums(tick);
      remember(confirmed);
      noteShifts(tick, commands);
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
          issuedTicks.length = 0;
          buffered.clear();
          mine.clear();
          expected.clear();
          pendingDelay = null;
          recoveredOnce = false;
          anchorAtMs = Number.NaN;

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
            let played = 0;

            while (world.tick <= target) {
              const commands = map.get(world.tick) ?? [];
              const tick = world.tick;
              played += countMine(commands);
              world = step(world, commands);
              remember(world);
              options.onFrame?.(tick, commands);
            }

            confirmed = world;

            // Правило то же, что после обычного кадра: сколько своих
            // проиграно, столько записей снято, остальное перенесено.
            // Пустая очередь здесь обычное дело — после рассинхрона её
            // чистит `verify`, и снимать бывает нечего.
            settle(played);
            forgetChecksums(confirmed.tick - 1);
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

    advance() {
      // Без часов, без предсказания и вне обычной игры делать нечего:
      // показ в этих случаях двигается приходом кадров либо не двигается
      // вовсе, потому что подтверждённая копия перестраивается.
      if (options.now === undefined || !predicting) return;
      if (confirmed === null || side === null || status !== 'playing') return;

      const target = displayTarget();
      if (predicted !== null && predicted.tick >= target) return;

      // Продление, а не пересборка: основа не менялась, менялись часы.
      extend(target);
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

      if (options.onCommandShift !== undefined) issuedTicks.push(tick);

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
