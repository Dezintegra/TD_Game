import { LOBBY_CAPACITY, LobbyError } from '@td/protocol';
import { checkName } from '@td/shared';
import type {
  LobbySummary,
  LobbyView,
  MatchView,
  PlayerView,
} from '@td/protocol';

/**
 * Комнаты ожидания: где двое находят друг друга и договариваются начать.
 *
 * Модуль намеренно ничего не знает ни про HTTP, ни про SSE, ни про
 * Fastify. Он хранит состояние и отвечает на вопросы «что изменилось»
 * и «как это выглядит для игрока X». Транспорт живёт отдельно
 * в `lobby-routes.ts` и просто рассылает то, что здесь посчитано.
 *
 * Разделение не ради красоты. Правила тут неочевидные — сброс
 * готовности при смене состава, отсрочка при потере связи, — и
 * проверять их гонянием настоящих HTTP-запросов было бы долго и мутно.
 *
 * Комнаты живут в памяти и умирают вместе с процессом. Комната
 * существует минуты; переживать перезапуск ей незачем.
 */

/**
 * Сколько игрок сохраняет место в комнате после обрыва связи.
 *
 * Пятнадцать секунд — с запасом на перезагрузку страницы, которая
 * иначе стоила бы места. Верхняя граница задана терпением соперника:
 * ждать дольше, глядя на «связь потеряна», уже обидно.
 */
export const DISCONNECT_GRACE_MS = 15_000;

export type LobbyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LobbyError };

interface Slot {
  readonly id: string;
  name: string;
  ready: boolean;
  /**
   * Когда закрылся последний поток игрока, либо null, если поток открыт.
   * По нему считается и отметка «связь потеряна», и срок отсрочки.
   */
  lostAtMs: number | null;
}

interface MatchRecord {
  readonly id: string;
  readonly seed: number;
  /**
   * Стороны заморожены в момент старта, а не вычисляются из позиции
   * в списке слотов. Разница существенна: уйди соперник из матча,
   * список сожмётся, и оставшийся незаметно сменил бы сторону
   * с первой на нулевую посреди партии.
   */
  readonly sides: ReadonlyMap<string, number>;
  readonly names: ReadonlyMap<string, string>;
}

interface LobbyRecord {
  readonly id: string;
  readonly title: string;
  readonly slots: Slot[];
  match: MatchRecord | null;
}

export interface LobbyStoreOptions {
  /**
   * Часы. Внедрены, а не взяты из `Date.now()` напрямую: иначе проверка
   * отсрочки потребовала бы в тесте настоящих пятнадцати секунд.
   */
  readonly now: () => number;
  /** Seed карты. Внедрён по той же причине — ради воспроизводимых тестов. */
  readonly randomSeed: () => number;
  readonly graceMs?: number;
}

export interface LobbyStore {
  create(playerId: string, name: string, title: string): LobbyResult<LobbyView>;
  join(playerId: string, name: string, lobbyId: string): LobbyResult<LobbyView>;
  /** Возвращает true, если состояние изменилось и его стоит разослать. */
  leave(playerId: string): boolean;
  setReady(playerId: string, ready: boolean): LobbyResult<LobbyView>;
  /** Открылся поток состояния игрока. */
  connect(playerId: string): boolean;
  /** Закрылся поток состояния игрока. */
  disconnect(playerId: string): boolean;
  /** Убирает просрочивших отсрочку и опустевшие комнаты. */
  sweep(): boolean;
  view(playerId: string): PlayerView;
}

export const createLobbyStore = (options: LobbyStoreOptions): LobbyStore => {
  const graceMs = options.graceMs ?? DISCONNECT_GRACE_MS;

  const lobbies = new Map<string, LobbyRecord>();

  /**
   * Сколько потоков открыто у игрока. Именно счётчик, а не флаг: игрок
   * может открыть игру во второй вкладке, и закрытие одной из них
   * не означает, что он ушёл.
   */
  const streams = new Map<string, number>();

  let nextId = 1;
  const makeId = (prefix: string): string => {
    const id = `${prefix}${String(nextId)}`;
    nextId += 1;
    return id;
  };

  /**
   * Поиск комнаты игрока перебором, без отдельного указателя
   * «игрок → комната». Указатель был бы быстрее, но требовал бы
   * синхронного обновления в шести местах, а рассогласование двух
   * хранилищ — классический источник тихих ошибок. Комнат единицы,
   * слотов в каждой два: перебор здесь дешевле правильности.
   */
  const lobbyOf = (playerId: string): LobbyRecord | undefined => {
    for (const lobby of lobbies.values()) {
      if (lobby.slots.some((slot) => slot.id === playerId)) return lobby;
    }
    return undefined;
  };

  /**
   * Согласие дают на конкретный состав, а не вообще. Поэтому любое
   * изменение состава — вход, выход, потеря связи, возвращение —
   * снимает готовность со всех, кто остался.
   *
   * Без этого правила возможен неприятный случай: двое готовы, один
   * вышел, вошёл третий — и матч начинается его первым нажатием, хотя
   * он не успел даже увидеть, с кем играет.
   */
  const resetReady = (lobby: LobbyRecord): void => {
    for (const slot of lobby.slots) slot.ready = false;
  };

  const dropEmpty = (lobby: LobbyRecord): void => {
    if (lobby.slots.length === 0) lobbies.delete(lobby.id);
  };

  const removeFrom = (lobby: LobbyRecord, playerId: string): boolean => {
    const index = lobby.slots.findIndex((slot) => slot.id === playerId);
    if (index === -1) return false;

    lobby.slots.splice(index, 1);
    resetReady(lobby);
    dropEmpty(lobby);
    return true;
  };

  const leaveAny = (playerId: string): boolean => {
    const lobby = lobbyOf(playerId);
    if (lobby === undefined) return false;
    return removeFrom(lobby, playerId);
  };

  const isPresent = (playerId: string): boolean => (streams.get(playerId) ?? 0) > 0;

  const newSlot = (playerId: string, name: string): Slot => ({
    id: playerId,
    name,
    ready: false,
    // Игрок, только что открывший комнату без потока состояния, получает
    // ту же отсрочку, что и потерявший связь. Так случай «поток
    // не открылся вовсе» не оставляет вечного постояльца в комнате.
    lostAtMs: isPresent(playerId) ? null : options.now(),
  });

  /**
   * Матч начинается сам, как только выполнены все условия. Отдельной
   * команды «начать» нет и быть не должно: подтверждением была готовность,
   * и требовать сверх неё ещё одного нажатия значило бы спросить дважды.
   */
  const tryStart = (lobby: LobbyRecord): void => {
    if (lobby.match !== null) return;
    if (lobby.slots.length !== LOBBY_CAPACITY) return;
    if (!lobby.slots.every((slot) => slot.ready)) return;
    // Матч не начинается, пока кто-то отмечен потерявшим связь: он
    // не увидит старта и окажется в партии с опозданием.
    if (!lobby.slots.every((slot) => slot.lostAtMs === null)) return;

    const sides = new Map<string, number>();
    const names = new Map<string, string>();
    lobby.slots.forEach((slot, index) => {
      sides.set(slot.id, index);
      names.set(slot.id, slot.name);
    });

    lobby.match = { id: makeId('m'), seed: options.randomSeed(), sides, names };
  };

  const lobbyView = (lobby: LobbyRecord, playerId: string): LobbyView => ({
    id: lobby.id,
    title: lobby.title,
    capacity: LOBBY_CAPACITY,
    slots: lobby.slots.map((slot) => ({
      name: slot.name,
      ready: slot.ready,
      connected: slot.lostAtMs === null,
      you: slot.id === playerId,
    })),
  });

  const matchView = (lobby: LobbyRecord, playerId: string): MatchView | null => {
    const { match } = lobby;
    if (match === null) return null;

    const side = match.sides.get(playerId);
    if (side === undefined) return null;

    let opponentName = '';
    for (const [id, name] of match.names) {
      if (id !== playerId) opponentName = name;
    }

    return { matchId: match.id, seed: match.seed, side, opponentName };
  };

  return {
    create(playerId, name, title) {
      const checkedName = checkName(name);
      if (!checkedName.ok) return { ok: false, error: LobbyError.BadName };

      const checkedTitle = checkName(title);
      if (!checkedTitle.ok) return { ok: false, error: LobbyError.BadTitle };

      // Создать комнату и остаться в прежней — состояние, которого игрок
      // не желал ни в одном сценарии.
      leaveAny(playerId);

      const lobby: LobbyRecord = {
        id: makeId('l'),
        title: checkedTitle.name,
        slots: [newSlot(playerId, checkedName.name)],
        match: null,
      };
      lobbies.set(lobby.id, lobby);

      return { ok: true, value: lobbyView(lobby, playerId) };
    },

    join(playerId, name, lobbyId) {
      const checkedName = checkName(name);
      if (!checkedName.ok) return { ok: false, error: LobbyError.BadName };

      const lobby = lobbies.get(lobbyId);
      if (lobby === undefined) return { ok: false, error: LobbyError.NotFound };
      if (lobby.match !== null) return { ok: false, error: LobbyError.AlreadyStarted };

      const existing = lobby.slots.find((slot) => slot.id === playerId);
      if (existing !== undefined) {
        // Повторный вход в свою же комнату — не ошибка, а обычный исход
        // двойного нажатия. Имя при этом обновляем: игрок мог его сменить.
        existing.name = checkedName.name;
        return { ok: true, value: lobbyView(lobby, playerId) };
      }

      if (lobby.slots.length >= LOBBY_CAPACITY) return { ok: false, error: LobbyError.Full };

      leaveAny(playerId);
      lobby.slots.push(newSlot(playerId, checkedName.name));
      resetReady(lobby);

      return { ok: true, value: lobbyView(lobby, playerId) };
    },

    leave(playerId) {
      return leaveAny(playerId);
    },

    setReady(playerId, ready) {
      const lobby = lobbyOf(playerId);
      if (lobby === undefined) return { ok: false, error: LobbyError.NotInLobby };
      if (lobby.match !== null) return { ok: false, error: LobbyError.AlreadyStarted };

      const slot = lobby.slots.find((entry) => entry.id === playerId);
      if (slot === undefined) return { ok: false, error: LobbyError.NotInLobby };

      if (ready && lobby.slots.length < LOBBY_CAPACITY) {
        return { ok: false, error: LobbyError.NeedOpponent };
      }

      slot.ready = ready;
      tryStart(lobby);

      return { ok: true, value: lobbyView(lobby, playerId) };
    },

    connect(playerId) {
      const count = (streams.get(playerId) ?? 0) + 1;
      streams.set(playerId, count);
      if (count > 1) return false;

      const lobby = lobbyOf(playerId);
      if (lobby === undefined) return false;

      const slot = lobby.slots.find((entry) => entry.id === playerId);
      if (slot === undefined || slot.lostAtMs === null) return false;

      slot.lostAtMs = null;
      resetReady(lobby);
      return true;
    },

    disconnect(playerId) {
      const count = (streams.get(playerId) ?? 0) - 1;
      if (count > 0) {
        streams.set(playerId, count);
        return false;
      }
      streams.delete(playerId);

      const lobby = lobbyOf(playerId);
      if (lobby === undefined) return false;

      const slot = lobby.slots.find((entry) => entry.id === playerId);
      if (slot === undefined || slot.lostAtMs !== null) return false;

      slot.lostAtMs = options.now();
      resetReady(lobby);
      return true;
    },

    sweep() {
      const deadline = options.now() - graceMs;
      let changed = false;

      for (const lobby of [...lobbies.values()]) {
        const expired = lobby.slots.filter(
          (slot) => slot.lostAtMs !== null && slot.lostAtMs <= deadline,
        );

        for (const slot of expired) {
          removeFrom(lobby, slot.id);
          changed = true;
        }
      }

      return changed;
    },

    view(playerId) {
      const own = lobbyOf(playerId);

      const summaries: LobbySummary[] = [];
      for (const lobby of lobbies.values()) {
        // Комната, в которой начался матч, из списка исчезает: войти
        // в неё нельзя, и строка обещала бы невозможное.
        if (lobby.match !== null) continue;

        summaries.push({
          id: lobby.id,
          title: lobby.title,
          hostName: lobby.slots[0]?.name ?? '',
          players: lobby.slots.length,
          capacity: LOBBY_CAPACITY,
        });
      }

      return {
        lobbies: summaries,
        lobby: own === undefined ? null : lobbyView(own, playerId),
        match: own === undefined ? null : matchView(own, playerId),
      };
    },
  };
};
