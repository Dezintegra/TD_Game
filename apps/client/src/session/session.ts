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

/** Seed первого тренировочного матча. Тот же, что был зашит в игре до комнат. */
const FIRST_PRACTICE_SEED = 1337;

let nextPracticeSeed = FIRST_PRACTICE_SEED;

/**
 * Seed следующей тренировки.
 *
 * Линейный конгруэнтный шаг, тот же, что в `restart`. Качества
 * от него не требуется — только чтобы соседние тренировки шли
 * на разных картах, а первая была воспроизводимой.
 */
const takePracticeSeed = (): number => {
  const seed = nextPracticeSeed;
  nextPracticeSeed = (nextPracticeSeed * 1664525 + 1013904223) >>> 0;
  return seed;
};

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

  void startGame(host, { seed: desired.seed, localPlayer: desired.side }).then((started) => {
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
    store.getState().setPracticeSeed(null);
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

  /** Начать тренировочный матч против компьютера. */
  startPractice(): void {
    store.getState().setPracticeSeed(takePracticeSeed());
  },

  /**
   * Выйти из матча в меню.
   *
   * Тренировочный просто гасится. Матч из комнаты требует ещё и выхода
   * из самой комнаты: иначе сервер продолжит считать игрока в матче
   * и первым же состоянием вернёт его обратно на поле.
   */
  async leaveMatch(): Promise<void> {
    const { practiceSeed, setPracticeSeed } = store.getState();

    if (practiceSeed !== null) {
      setPracticeSeed(null);
      return;
    }

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
