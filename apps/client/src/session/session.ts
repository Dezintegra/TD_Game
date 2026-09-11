import { FRAME_WORK_BUDGET_MS, NAME_MAX_LENGTH, checkName } from '@td/shared';
import type { NameError } from '@td/shared';
import { startGame } from '../game/bootstrap.js';
import type { Game } from '../game/bootstrap.js';
import { createRendererHost } from '../game/scene.js';
import type { RendererHost } from '../game/scene.js';
import { createLobbyClient } from './lobby-client.js';
import type { ActionError } from './lobby-client.js';
import { clearProfile, createProfileId, readProfile, writeProfile } from './profile.js';
import { activeMatchOf, useSessionStore } from './session-store.js';
import type { SessionState } from './session-store.js';
import { createWarmPace } from './warm-pace.js';

/**
 * Контроллер сессии: связывает профиль, комнаты и запуск матча.
 *
 * Живёт обычным модулем, вне React-дерева, и это принципиально.
 * Соблазн запускать игру из `useEffect` на экране матча велик, но
 * в `StrictMode` React вызывает эффекты дважды при разработке,
 * а `startGame` асинхронна и создаёт приложение PixiJS. Два вызова
 * подряд дали бы две сцены и два игровых цикла, причём вторая ссылка
 * затёрла бы первую, и погасить первую было бы нечем.
 *
 * Поэтому React про матч знает ровно одно — идёт он или нет, — и берёт
 * это из store. А поднимает и гасит сцену вот этот модуль, по подписке
 * на тот же store.
 */

const store = useSessionStore;

const lobby = createLobbyClient({
  onView: (view) => {
    store.getState().setView(view);
  },
  onConnected: (connected) => {
    store.getState().setConnected(connected);
  },
});

let game: Game | undefined;

/**
 * Отрисовщик, живущий дольше матча.
 *
 * Поднимается один раз и лениво — при первом же обращении, то есть ещё
 * из меню. Хранится обещанием, а не значением: подъём асинхронный
 * (`app.init` ждёт контекста WebGL), а обратиться к нему могут раньше,
 * чем он готов, — например, если игрок нажал «играть» сразу.
 *
 * Живёт он затем, что кеши спрайтов принадлежат контексту WebGL и гибнут
 * вместе с ним. Пока приложение создавалось на каждый матч, никакой
 * прогрев не имел смысла: прогретое умирало бы вместе с прошлой партией.
 */
let rendererHost: Promise<RendererHost> | undefined;

const ensureRenderer = (): Promise<RendererHost> => {
  rendererHost ??= createRendererHost();

  return rendererHost;
};

/**
 * Прогрев кеша спрайтов, пока игрок в меню.
 *
 * Зачем. Спрайт машины печётся под предельное приближение, и одно
 * запекание стоит около тринадцати миллисекунд. Посреди боя это
 * пропущенный кадр, тем более что постановка стены перекрашивает
 * до четырёх соседей разом. В меню те же миллисекунды не стоят ничего:
 * игрок там читает список комнат.
 *
 * Почему по кадрам, а не одним циклом. Базовый набор — под две сотни
 * комбинаций, то есть пара секунд работы. Одним циклом это была бы
 * пара секунд замершего меню, а отзывчивость интерфейса — главное
 * требование проекта. Прогрев, ради которого подвисает список комнат,
 * хуже мыла, которое он лечит.
 *
 * Пока идёт матч, прогрев молчит: кадр нужен бою, а не заготовкам.
 * Дошло дело до матча раньше, чем кончился прогрев, — матч всё равно
 * начинается, недостающее допечётся по надобности. Прогрев здесь
 * ускорение, а не условие.
 *
 * И ровно поэтому он умеет отступать. Тринадцать миллисекунд —
 * это ПРОЕКТНАЯ цена запекания; там, где рисует процессор, она впятеро
 * выше, и двести восемь заготовок превращаются в десятки секунд
 * дёргающегося меню. Настоящую цену считает `warm-pace.ts`, и если
 * по ней очередь не укладывается в срок, прогрев прекращается совсем.
 */
let warming = false;

/**
 * Отложить шаг прогрева до простоя.
 *
 * `requestIdleCallback`, а не `requestAnimationFrame`, и это не мелочь.
 * Одно запекание неделимо и стоит больше кадрового бюджета, поэтому
 * покадровый прогрев занимал КАЖДЫЙ кадр целиком: на машине с видеокартой
 * это незаметно, а на слабой отнимало у меню всё, что у него было.
 * Поймалось сквозной проверкой на два браузера: она держится
 * в стодвадцати секундах, а с покадровым прогревом перестала.
 *
 * Простой — ровно то условие, при котором прогрев уместен: он ускорение,
 * а не обязанность, и уступить дорогу вводу, раскладке и сети обязан
 * без разговоров. Срока (`timeout`) намеренно нет: с ним браузер запустил
 * бы работу и на занятой странице, то есть вернул бы ту же беду.
 *
 * Запасной путь на кадр — для тех, кто `requestIdleCallback` не знает.
 */
const whenIdle = (run: (deadline?: IdleDeadline) => void): void => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run);
  else requestAnimationFrame(() => run());
};

/**
 * Прогрев выключен: `VITE_E2E_CHEAP_TEXTURES=1`.
 *
 * Заведено ради сквозных проверок, и польза тут односторонняя: прогрев
 * им только вредит. Смысл его — разложить запекание по простою МЕНЮ,
 * чтобы в бою не было пропущенных кадров; проверка же смотрит не на
 * плавность, а на разметку и на сходимость миров, и лишнюю плавность
 * ей зачесть некуда. Зато цену она платит полностью.
 *
 * Цена измерена 31.08.2026, прогон настоящих проверок лобби в режиме
 * runner'а (программная отрисовка, два работника) на своей машине:
 *
 * | проверка | с прогревом | без прогрева |
 * | -------- | ----------- | ------------ |
 * | `lobby:96` | 17,5 с | 2,5 с |
 * | `lobby:121` | 32,2 с | 2,8 с |
 * | `lobby:159` | 2,0 мин, упала | 1,1 мин |
 *
 * Отрисовщик при этом поднимается как обычно: замер отдельной версией
 * показал, что сам по себе он не стоит ничего — 2,5 с против 2,6 с,
 * когда его в меню нет вовсе. Виновато именно запекание впрок.
 *
 * Флаг снимает ЗАГОТОВКИ, а не отрисовку. Всё, что проверке нужно
 * увидеть на экране, печётся по надобности ровно как у игрока.
 */
const WARM_DISABLED = import.meta.env['VITE_E2E_CHEAP_TEXTURES'] === '1';

/**
 * Прогрев прекращён: машина его не тянет.
 *
 * Отступ липнет к сессии, а не к заходу в меню, и это осознанно. Машина
 * между матчами быстрее не становится, а попытка «а вдруг теперь» стоила
 * бы игроку ровно того же дёрганого меню, ради которого прогрев
 * и отменён.
 */
let warmGaveUp = false;

/** Мерка на всю сессию: наблюдение продолжается и после матча. */
const pace = createWarmPace();

/** Сколько заготовок оставалось в очереди. Только ради сообщения в консоль. */
let warmRest = 0;

/**
 * Кадровые часы прогрева.
 *
 * Крутятся ровно столько, сколько идёт прогрев, и только затем, чтобы
 * заметить дёрганое меню. Считать кадры без нужды не за чем: пустой
 * `requestAnimationFrame` дёшев, но не бесплатен, а после прогрева
 * наблюдать уже нечего.
 */
const watchFrames = (): void => {
  const tick = (timestamp: number): void => {
    if (!warming) return;

    // Матч идёт — кадры принадлежат бою. Прогрев в это время молчит,
    // и судить его по чужим кадрам не за что.
    if (activeKey !== null) {
      pace.pause();
      requestAnimationFrame(tick);

      return;
    }

    if (pace.frame(timestamp)) {
      requestAnimationFrame(tick);

      return;
    }

    warming = false;
    warmGaveUp = true;

    const frameMs = Math.round(pace.frameMs() ?? 0);
    console.warn(
      `Прогрев кеша спрайтов прекращён: с ним меню отдаёт кадр за ${String(frameMs)} мс, ` +
        `а в очереди оставалось ${String(warmRest)} заготовок. ` +
        'Спрайты будут печься по надобности.',
    );
  };

  requestAnimationFrame(tick);
};

const startWarming = (renderer: RendererHost): void => {
  // Два цикла прогрева разом печь одно и то же не должны: очередь у них
  // общая, и второй просто съедал бы простой.
  if (WARM_DISABLED || warmGaveUp || warming) return;
  warming = true;
  watchFrames();

  const step = (deadline?: IdleDeadline): void => {
    // Прогрев прекращён кадровыми часами: меню дороже заготовок.
    if (!warming) return;

    // Матч идёт — не трогаем ничего и ждём следующего простоя.
    if (activeKey !== null) {
      whenIdle(step);

      return;
    }

    // Браузер сам говорит, сколько времени у него есть. Запасной путь
    // такого не знает, и ему остаётся кадровый бюджет.
    const budget = deadline === undefined ? FRAME_WORK_BUDGET_MS : deadline.timeRemaining();

    warmRest = renderer.warm(budget).rest;

    if (warmRest > 0) {
      whenIdle(step);

      return;
    }

    warming = false;
    // Пара к сообщению об отступе. Без него в консоли видно только беду,
    // и «прогрев прошёл целиком» отличить от «прогрев не начинался»
    // нечем — а это разные вещи и лечатся по-разному.
    console.info('Прогрев кеша спрайтов закончен.');
  };

  whenIdle(step);
};

/**
 * Игрок вышел в меню: сбросить накопленное и прогреться заново.
 *
 * Сброс именно здесь, а не при каждом окончании матча: между матчами
 * подряд сочетания те же, и сбрасывать их значило бы начинать следующий
 * матч холодным. А вот выход в меню — и повод (следующий матч может
 * оказаться другим), и время.
 */
const rewarmInMenu = (): void => {
  void rendererHost?.then((renderer) => {
    if (activeKey !== null) return;

    renderer.reset();
    startWarming(renderer);
  });
};

/**
 * Манера, которую игрок позвал в последний раз, — чтобы «Новый матч»
 * вёл к тому же сопернику.
 *
 * Живёт здесь, а не в store: это память контроллера о действии игрока,
 * а не состояние, которое кто-то рисует. Из снимка матча её не достать —
 * там лежит имя дежурного («Компьютер-стратег 2»), а не манера.
 *
 * `undefined` означает, что компьютера не звали вовсе: соперник был
 * живой, и переигрывать с ним без его согласия нельзя.
 */
let lastProfile: string | undefined;

/**
 * Название комнаты по умолчанию.
 *
 * Тот же вид, что предлагает форма создания (`LobbyList`), и та же
 * причина двоеточия: родительный падеж требует склонения, а склонение
 * русских имён в общем виде не делается. Повторено здесь, а не вынесено
 * в общий модуль, потому что вынесенное потянуло бы за собой предел
 * длины и запасной путь при переполнении — ради одной строки на две
 * точки вызова.
 */
const defaultRoomTitle = (name: string): string => {
  const full = `Комната: ${name}`;
  return full.length <= NAME_MAX_LENGTH ? full : name;
};

/**
 * Ключ идущего матча и счётчик поколений.
 *
 * Ключ отвечает на вопрос «тот же это матч или другой»: перерисовка
 * меню не должна трогать игру. Счётчик страхует от гонки — сцена
 * поднимается асинхронно, и за это время матч может успеть смениться
 * или закончиться.
 */
let activeKey: string | null = null;
let generation = 0;

const teardown = (): void => {
  game?.stop();
  game = undefined;
  // Элемент `#scene` и приложение PixiJS здесь НЕ трогаются: они живут
  // дольше матча и уносят с собой прогретые спрайты. Матчевое снимает
  // `scene.destroy()` внутри `game.stop()`.
};

const syncMatch = (state: SessionState): void => {
  const desired = activeMatchOf(state);
  const key = desired?.key ?? null;
  if (key === activeKey) return;

  activeKey = key;
  generation += 1;
  const mine = generation;

  teardown();

  if (desired === null) {
    rewarmInMenu();

    return;
  }

  const start = async (): Promise<void> => {
    const renderer = await ensureRenderer();

    // Подъём отрисовщика асинхронный, и за это время матч мог смениться
    // или кончиться. Проверка здесь, до `startGame`, а не только после:
    // иначе мы подняли бы партию, которую тут же пришлось бы гасить.
    if (mine !== generation) return;

    const started = await startGame(renderer, {
      seed: desired.seed,
      localPlayer: desired.side,
      ticket: desired.ticket,
      // «Начать заново» осмысленно только против компьютера: уйти с общей
      // карты в общем матче нельзя, а начать новый матч с тем же соперником
      // без его согласия — тем более.
      //
      // Зовётся та же манера, которую игрок звал в прошлый раз: без неё
      // кнопка «Новый матч» тихо меняла бы противника посреди знакомства
      // с ним. Комната при этом заводится НОВАЯ — прежняя ушла вместе
      // с матчем.
      onRestart: desired.computer ? () => void sessionActions.restartWithComputer() : undefined,
      onRejected: (code) => {
        console.warn(`Сервер отклонил соединение, код ${String(code)}`);
      },
    });

    if (mine !== generation) {
      // Пока сцена поднималась, матч успел смениться или закончиться.
      // Гасим то, что подняли, и уходим: актуальным занят другой вызов.
      // Элемент `#scene` при этом остаётся — он не наш, а отрисовщика.
      started.stop();
      return;
    }

    game = started;
  };

  void start();
};

const unsubscribe = store.subscribe(syncMatch);

const currentPlayerId = (): string | null => store.getState().profile?.id ?? null;

/** Действия меню. Их вызывают React-компоненты, но выполняются они здесь. */
export const sessionActions = {
  /**
   * Прочитать профиль из куки и, если он есть, подписаться на комнаты.
   * Вызывается один раз при загрузке страницы.
   */
  start(): void {
    // Отрисовщик поднимается и греется СРАЗУ, до проверки профиля.
    // Экран представления — такое же меню, как и список комнат: игрок
    // там читает и печатает, а машина в это время свободна. Ждать
    // профиля значило бы подарить прогреву меньше времени ровно у тех,
    // кто заходит впервые.
    void ensureRenderer().then(startWarming);

    const profile = readProfile();
    if (profile === null) return;

    store.getState().setProfile(profile);
    lobby.listen(profile.id);
  },

  /** Представиться. Возвращает причину отказа либо null. */
  identify(rawName: string): NameError | null {
    const checked = checkName(rawName);
    if (!checked.ok) return checked.error;

    const profile = { id: createProfileId(), name: checked.name };
    writeProfile(profile);
    store.getState().setProfile(profile);
    lobby.listen(profile.id);

    return null;
  },

  /**
   * Удалить профиль и вернуться к представлению.
   *
   * Сначала выход из комнаты, потом стирание куки: после стирания
   * идентификатор потерян, и сказать серверу, кто именно ушёл, будет
   * уже нечем — место в комнате провисело бы всю отсрочку.
   */
  async forget(): Promise<void> {
    const playerId = currentPlayerId();
    if (playerId !== null) await lobby.leave(playerId);

    lobby.stop();
    clearProfile();
    store.getState().setProfile(null);
  },

  /** Пустой пароль означает открытую комнату — как было до паролей. */
  async createLobby(title: string, password = ''): Promise<ActionError | null> {
    const { profile, setError } = store.getState();
    if (profile === null) return null;

    const error = await lobby.create(profile.id, profile.name, title, password);
    setError(error);
    return error;
  },

  async joinLobby(lobbyId: string, password = ''): Promise<ActionError | null> {
    const { profile, setError } = store.getState();
    if (profile === null) return null;

    const error = await lobby.join(profile.id, profile.name, lobbyId, password);
    setError(error);
    return error;
  },

  async leaveLobby(): Promise<void> {
    const playerId = currentPlayerId();
    if (playerId === null) return;

    store.getState().setOptimisticReady(null);
    store.getState().setError(null);
    await lobby.leave(playerId);
  },

  /**
   * Переключить готовность.
   *
   * Кнопка перекрашивается немедленно, до ответа сервера: главное
   * нефункциональное требование проекта — отклик в том же кадре, и оно
   * не перестаёт действовать за пределами матча. Отказ возвращает
   * показанное на место.
   */
  async toggleReady(ready: boolean): Promise<void> {
    const { profile, setOptimisticReady, setError } = store.getState();
    if (profile === null) return;

    setOptimisticReady(ready);
    const error = await lobby.setReady(profile.id, ready);

    if (error !== null) {
      setOptimisticReady(null);
      setError(error);
    }
  },

  /**
   * Позвать компьютера в свою комнату.
   *
   * Никакого особого пути в матч у компьютера по-прежнему нет: сервер
   * помечает комнату приглашением, служба видит пометку в общем списке
   * комнат и входит обычным гостем — тем же запросом, что и человек.
   * Дорога в матч одна на всю игру, а не две расходящиеся.
   *
   * `profile` — идентификатор манеры из `view.computerProfiles`, а не
   * название комнаты, как было при дежурных. Название теперь приходит
   * рядом с идентификатором, и второй словарь в клиенте не нужен.
   */
  async inviteComputer(profile: string): Promise<ActionError | null> {
    const state = store.getState();
    if (state.profile === null) return null;

    // Кнопка гаснет немедленно, до ответа сервера: отклик в том же кадре
    // не перестаёт быть требованием за пределами матча. Дальше ожидание
    // видно уже по самой комнате, и это поле снимается.
    state.setJoiningComputer(true);
    state.setError(null);
    lastProfile = profile;

    try {
      const error = await lobby.inviteComputer(state.profile.id, profile);
      store.getState().setError(error);
      return error;
    } finally {
      store.getState().setJoiningComputer(false);
    }
  },

  /**
   * Начать заново с тем же соперником.
   *
   * Заводит НОВУЮ комнату и зовёт в неё ту же манеру: прежняя комната
   * ушла вместе с матчем, а звать соперника можно только в свою.
   * Готовность подтверждается сама, как только дежурный войдёт, —
   * это делает обработчик состояния ниже.
   */
  async restartWithComputer(): Promise<void> {
    const { profile } = store.getState();
    if (profile === null || lastProfile === undefined) return;

    const created = await this.createLobby(defaultRoomTitle(profile.name), '');
    if (created !== null) return;

    await this.inviteComputer(lastProfile);
  },

  /**
   * Выйти из матча в меню.
   *
   * Выход из идущего матча — это поражение, и предупреждает об этом
   * интерфейс, а не эта функция: она делает то, что уже подтверждено.
   * Выход из комнаты обязателен: иначе сервер продолжит считать игрока
   * в матче и первым же состоянием вернёт его обратно на поле.
   */
  async leaveMatch(): Promise<void> {
    await this.leaveLobby();
  },

  /**
   * Погасить всё: матч, поток состояния и подписку.
   *
   * Нужен только горячей перезагрузке при разработке. Без него замена
   * модуля оставила бы работать прежний игровой цикл, а подписки
   * накапливались бы с каждой правкой.
   */
  dispose(): void {
    unsubscribe();
    teardown();
    activeKey = null;
    lobby.stop();
  },
};
