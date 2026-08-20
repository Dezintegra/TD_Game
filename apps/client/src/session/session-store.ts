import { create } from 'zustand';
import type { PlayerView } from '@td/protocol';
import type { Profile } from './profile.js';
import type { ActionError } from './lobby-client.js';

/**
 * Состояние меню: кто играет, какие есть комнаты, в какой из них он сам
 * и не начался ли матч.
 *
 * Отдельно от `game/store.ts` намеренно. Тот обслуживает матч
 * и обновляется игровым циклом до пяти раз в секунду; этот меняется
 * единицы раз в минуту и живёт, пока матча нет. Сложи их вместе —
 * и перерисовка HUD начала бы зависеть от списка комнат.
 */
const EMPTY_VIEW: PlayerView = { lobbies: [], lobby: null, match: null };

export interface SessionState {
  readonly profile: Profile | null;
  /** Открыт ли поток состояния. Ложь — сервер не отвечает. */
  readonly connected: boolean;
  readonly view: PlayerView;
  /**
   * Идёт ли переход в матч с компьютером.
   *
   * Прежде здесь лежал seed тренировочного матча: тот матч шёл целиком
   * в браузере, и клиенту достаточно было выдумать себе карту. Теперь
   * матч с компьютером ничем не отличается от матча с человеком — он
   * идёт через сервер, через комнату и через готовность, — и от прежнего
   * поля осталось лишь «мы сейчас в процессе входа», чтобы кнопка
   * не отвечала молчанием.
   */
  readonly joiningComputer: boolean;
  readonly error: ActionError | null;
  /**
   * Готовность, показанная до ответа сервера.
   *
   * Существует ради отклика в том же кадре: нажатие обязано перекрасить
   * кнопку немедленно, а не через оборот пакета. Снимается, когда
   * пришедшее состояние подтвердит показанное, — не раньше, иначе
   * чужое действие, доехавшее в промежутке, вернуло бы кнопку назад
   * и она мигнула бы на ровном месте.
   */
  readonly optimisticReady: boolean | null;

  setProfile(profile: Profile | null): void;
  setConnected(connected: boolean): void;
  setView(view: PlayerView): void;
  setJoiningComputer(joining: boolean): void;
  setError(error: ActionError | null): void;
  setOptimisticReady(ready: boolean | null): void;
}

export const useSessionStore = create<SessionState>((set) => ({
  profile: null,
  connected: false,
  view: EMPTY_VIEW,
  joiningComputer: false,
  error: null,
  optimisticReady: null,

  setProfile: (profile) => set({ profile, view: EMPTY_VIEW, error: null }),
  setConnected: (connected) => set({ connected }),

  setView: (view) =>
    set((state) => {
      if (state.optimisticReady === null) return { view };

      const mine = view.lobby?.slots.find((slot) => slot.you);
      const settled = mine === undefined || mine.ready === state.optimisticReady;

      return { view, optimisticReady: settled ? null : state.optimisticReady };
    }),

  setJoiningComputer: (joiningComputer) => set({ joiningComputer }),
  setError: (error) => set({ error }),
  setOptimisticReady: (optimisticReady) => set({ optimisticReady }),
}));

export type Screen = 'profile' | 'lobbies' | 'room' | 'match';

/**
 * Экран не хранится, а выводится из состояния.
 *
 * Хранимый экран пришлось бы держать согласованным с профилем, комнатой
 * и матчем, и рассогласование дало бы невозможные положения — вроде
 * экрана комнаты у игрока, которого из неё уже выгнали. Выведенный
 * экран невозможных положений не имеет по построению.
 */
export const screenOf = (state: SessionState): Screen => {
  if (state.profile === null) return 'profile';
  if (state.view.match !== null) return 'match';
  if (state.view.lobby !== null) return 'room';
  return 'lobbies';
};

export interface ActiveMatch {
  /** Противоположной стороной управляет компьютер. */
  readonly computer: boolean;
  readonly seed: number;
  readonly side: number;
  readonly opponentName: string;
  /** Билет на вход в матч. Без него сервер не знает, чьё это соединение. */
  readonly ticket: string;
  /**
   * По смене этого ключа контроллер понимает, что матч другой и сцену
   * надо поднять заново. Внутри одного матча ключ не меняется, поэтому
   * перерисовка меню игру не трогает.
   */
  readonly key: string;
}

/**
 * Описание идущего матча.
 *
 * Собирает новый объект на каждый вызов, поэтому годится контроллеру,
 * который зовёт её по подписке, и НЕ годится в качестве селектора
 * React-компонента: для zustand новая ссылка означает «состояние
 * изменилось», и компонент перерисовывался бы бесконечно. В компонентах
 * выбирайте существующие поля по отдельности.
 */
export const activeMatchOf = (state: SessionState): ActiveMatch | null => {
  if (state.profile === null) return null;

  const match = state.view.match;
  if (match === null) return null;

  return {
    computer: match.opponentIsComputer,
    seed: match.seed,
    side: match.side,
    opponentName: match.opponentName,
    ticket: match.ticket,
    key: `match:${match.matchId}`,
  };
};

/** Готовность, которую надо показать: обещанная, пока не подтверждена. */
export const readyOf = (state: SessionState): boolean => {
  if (state.optimisticReady !== null) return state.optimisticReady;
  return state.view.lobby?.slots.find((slot) => slot.you)?.ready ?? false;
};
