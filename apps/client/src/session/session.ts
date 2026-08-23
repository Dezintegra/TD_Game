import { checkName } from '@td/shared';
import type { NameError } from '@td/shared';
import { startGame } from '../game/bootstrap.js';
import type { Game } from '../game/bootstrap.js';
import { createLobbyClient } from './lobby-client.js';
import type { ActionError } from './lobby-client.js';
import { clearProfile, createProfileId, readProfile, writeProfile } from './profile.js';
import { activeMatchOf, useSessionStore } from './session-store.js';
import type { SessionState } from './session-store.js';

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

let sceneHost: HTMLElement | undefined;
let game: Game | undefined;

/**
 * Манера, выбранная игроком в последний раз, — чтобы «Новый матч» вёл
 * к тому же сопернику.
 *
 * Живёт здесь, а не в store: это память контроллера о действии игрока,
 * а не состояние, которое кто-то рисует. Из снимка матча её не достать —
 * там лежит имя дежурного («Компьютер-стратег 2»), а манера
 * опознаётся названием комнаты.
 *
 * `undefined` означает «любая», и это верно для того, кто нажал общую
 * кнопку: переигрывать он хотел с кем угодно.
 */
let lastManner: string | undefined;

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
  sceneHost?.remove();
  sceneHost = undefined;
};

const syncMatch = (state: SessionState): void => {
  const desired = activeMatchOf(state);
  const key = desired?.key ?? null;
  if (key === activeKey) return;

  activeKey = key;
  generation += 1;
  const mine = generation;

  teardown();
  if (desired === null) return;

  const host = document.createElement('div');
  host.id = 'scene';
  document.body.appendChild(host);
  sceneHost = host;

  void startGame(host, {
    seed: desired.seed,
    localPlayer: desired.side,
    ticket: desired.ticket,
    // «Начать заново» осмысленно только против компьютера: уйти с общей
    // карты в общем матче нельзя, а начать новый матч с тем же соперником
    // без его согласия — тем более.
    // Манера передаётся, чтобы «начать заново» вело к тому же сопернику,
    // с которым игрок только что играл. Без неё матч начинался бы
    // с кем придётся, и кнопка «Новый матч» тихо меняла бы противника
    // посреди знакомства с ним.
    onRestart: desired.computer
      ? () => void sessionActions.playAgainstComputer(lastManner)
      : undefined,
    onRejected: (code) => {
      console.warn(`Сервер отклонил соединение, код ${String(code)}`);
    },
  }).then((started) => {
    if (mine !== generation) {
      // Пока сцена поднималась, матч успел смениться или закончиться.
      // Гасим то, что подняли, и уходим: актуальным занят другой вызов.
      started.stop();
      host.remove();
      return;
    }
    game = started;
  });
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

  async createLobby(title: string): Promise<ActionError | null> {
    const { profile, setError } = store.getState();
    if (profile === null) return null;

    const error = await lobby.create(profile.id, profile.name, title);
    setError(error);
    return error;
  },

  async joinLobby(lobbyId: string): Promise<ActionError | null> {
    const { profile, setError } = store.getState();
    if (profile === null) return null;

    const error = await lobby.join(profile.id, profile.name, lobbyId);
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
   * Играть с компьютером.
   *
   * Никакого особого пути в матч у компьютера нет: он держит открытую
   * комнату наравне с людьми, и «играть с компьютером» — это войти
   * в неё и подтвердить готовность. Одно нажатие вместо трёх, но дорога
   * та же самая, и потому она одна на всю игру, а не две расходящиеся.
   *
   * Повторная попытка нужна из-за гонки: двое, нажавшие одновременно,
   * иначе получили бы один отказ «комната занята» на двоих. Служба
   * компьютера открывает следующую комнату сразу по входу гостя,
   * поэтому вторая попытка почти всегда удаётся.
   *
   * `manner` — НАЗВАНИЕ дежурной комнаты («Матч со стратегом»), а не имя
   * дежурного и не идентификатор профиля.
   *
   * Имя дежурного не годится, и это выяснилось живой проверкой: служба
   * держит несколько комнат разом, а её агентов зовёт «Компьютер»,
   * «Компьютер 2», «Компьютер 3» (`service.ts`). Имя опознаёт агента,
   * а не манеру, и выбор из трёх манер превратился в выбор из девяти
   * дежурных. Название комнаты у всех комнат одной службы одно и то же —
   * оно и есть манера.
   *
   * Идентификатор профиля не годится по другой причине: его нельзя
   * показывать игроку, а значит, пришлось бы завести в клиенте второй
   * словарь «идентификатор → человеческое название».
   *
   * Без названия годится любая манера, и это умолчание: кнопка «Играть
   * с компьютером» заведена для того, кто просто хочет сыграть,
   * а не выбирать соперника.
   */
  async playAgainstComputer(manner?: string): Promise<ActionError | null> {
    const state = store.getState();
    const { profile } = state;
    if (profile === null) return null;

    state.setJoiningComputer(true);
    state.setError(null);
    lastManner = manner;

    try {
      const tried = new Set<string>();

      for (let attempt = 0; attempt < 4; attempt += 1) {
        // Из всех дежурных комнат берётся первая, в которую мы ещё
        // не стучались. Служба держит их несколько именно ради этого:
        // двое, нажавшие одновременно, расходятся по разным, а не
        // дерутся за единственную.
        //
        // Названа манера — перебор сужается до её комнат. Молчаливо
        // подсунуть другую нельзя: игрок, выбравший стратега, ждёт
        // стратега, и «зато сыграл» тут не оправдание.
        const room = store
          .getState()
          .view.lobbies.find(
            (lobby) =>
              lobby.computer &&
              !tried.has(lobby.id) &&
              (manner === undefined || lobby.title === manner),
          );

        if (room === undefined) {
          // Дежурной комнаты нет: служба компьютера не запущена, её
          // места заняты или мы уже перебрали все. Молчаливая кнопка
          // хуже отсутствующей, поэтому отказ доезжает до игрока.
          //
          // Прежде чем сдаться, ждём обновления списка: следующая
          // дежурная комната уже открыта, но её состояние ещё летит.
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            continue;
          }

          const error = 'not-found' as ActionError;
          store.getState().setError(error);
          return error;
        }

        tried.add(room.id);

        // Выход из прежней комнаты не нужен: сервер выводит из неё сам
        // при входе в другую.
        const joinError = await lobby.join(profile.id, profile.name, room.id);
        if (joinError === null) {
          await this.toggleReady(true);
          return null;
        }
      }

      const error = 'full' as ActionError;
      store.getState().setError(error);
      return error;
    } finally {
      store.getState().setJoiningComputer(false);
    }
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
