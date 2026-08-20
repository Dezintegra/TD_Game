import { create } from 'zustand';
import type { Notice } from './rejections.js';

/**
 * Store — единственный канал связи между игровым циклом и React.
 *
 * Зачем такая строгость. Игровой цикл крутится 60 раз в секунду.
 * Если бы он дёргал setState на каждом кадре, React перерисовывал бы
 * дерево 60 раз в секунду и съел бы весь бюджет отзывчивости.
 *
 * Поэтому цикл пишет в store только то, что реально показывается
 * в HUD, и только когда значение изменилось. Всё остальное —
 * территория, позиции башен, юнитов, генералов — живёт в PixiJS
 * и до React вообще не доходит. Позиций сущностей здесь нет и быть
 * не должно: понадобилась позиция в React — значит, что-то рисуется
 * не там, где следует.
 */
export type ConnectionStatus = 'offline' | 'connecting' | 'online';

/** Строка панели прокачки. Ровно то, что видно игроку. */
export interface UpgradeRow {
  readonly level: number;
  readonly cost: number;
  readonly affordable: boolean;
}

/**
 * Снимок матча для HUD.
 *
 * Все величины уже приведены к виду, в котором показываются: энергия
 * в «видимых» единицах, время в секундах. Переводить их в компонентах
 * значило бы размазать знание о внутреннем представлении по всему HUD.
 */
export interface MatchSnapshot {
  readonly energy: number;
  readonly incomePerSecond: number;
  readonly unitCount: number;
  readonly unitCap: number;
  /** Типы юнитов в очереди производства, в порядке заказа. */
  readonly queue: readonly number[];
  /** Цены юнитов по типу, с учётом подорожания от прокачки. */
  readonly unitCosts: readonly number[];
  /** Цены построек по виду. */
  readonly structureCosts: readonly number[];
  readonly nukeCost: number;
  readonly upgrades: readonly UpgradeRow[];
  readonly targetLabel: string;
  readonly generalAlive: boolean;
  readonly respawnInSeconds: number;
  readonly matchSeconds: number;
  /** Номер победившего игрока, либо null, пока матч идёт. */
  readonly winner: number | null;
  /** Вид постройки, выбранный для размещения, либо null. */
  readonly buildKind: number | null;
  readonly aimingNuke: boolean;
}

const EMPTY_MATCH: MatchSnapshot = {
  energy: 0,
  incomePerSecond: 0,
  unitCount: 0,
  unitCap: 0,
  queue: [],
  unitCosts: [],
  structureCosts: [],
  nukeCost: 0,
  upgrades: [],
  targetLabel: '—',
  generalAlive: true,
  respawnInSeconds: 0,
  matchSeconds: 0,
  winner: null,
  buildKind: null,
  aimingNuke: false,
};

interface HudState {
  readonly status: ConnectionStatus;
  readonly tick: number;
  /** Сколько раз сервер ответил на ping. Признак живого канала. */
  readonly pongCount: number;
  /** Время оборота пакета в миллисекундах. */
  readonly latencyMs: number;
  /** Кадров в секунду, усреднённо. */
  readonly fps: number;
  /** Seed текущей карты. Карта восстанавливается из него целиком. */
  readonly seed: number;
  /** Какая доля карты помещается на экран, в процентах. */
  readonly visiblePercent: number;
  /** Доля непроходимых клеток на текущей карте, в процентах. */
  readonly rockPercent: number;
  readonly match: MatchSnapshot;
  /**
   * Сообщения об отклонённых командах игрока.
   *
   * Обновляются не вместе со снимком матча, а отдельно и на каждом тике.
   * Снимок снимается раз в несколько тиков — этого достаточно для чисел,
   * которые человек и так не считывает быстрее, — но отказ живёт ровно
   * один тик, и в снимок он попадал бы примерно в одном случае из шести.
   */
  readonly notices: readonly Notice[];

  setStatus(status: ConnectionStatus): void;
  setTick(tick: number): void;
  registerPong(latencyMs: number): void;
  setFps(fps: number): void;
  setMapInfo(seed: number, visiblePercent: number, rockPercent: number): void;
  setMatch(match: MatchSnapshot): void;
  setNotices(notices: readonly Notice[]): void;
}

export const useHudStore = create<HudState>((set) => ({
  status: 'offline',
  tick: 0,
  pongCount: 0,
  latencyMs: 0,
  fps: 0,
  seed: 0,
  visiblePercent: 0,
  rockPercent: 0,
  match: EMPTY_MATCH,
  notices: [],

  setStatus: (status) => set({ status }),
  setTick: (tick) => set({ tick }),
  registerPong: (latencyMs) => set((state) => ({ pongCount: state.pongCount + 1, latencyMs })),
  setFps: (fps) => set({ fps }),
  setMapInfo: (seed, visiblePercent, rockPercent) => set({ seed, visiblePercent, rockPercent }),
  setMatch: (match) => set({ match }),
  setNotices: (notices) => set({ notices }),
}));

/**
 * Прямой доступ к store в обход React-хуков.
 * Нужен игровому циклу: он живёт вне дерева компонентов.
 */
export const hudActions = {
  setStatus: (status: ConnectionStatus) => useHudStore.getState().setStatus(status),
  setTick: (tick: number) => useHudStore.getState().setTick(tick),
  registerPong: (latencyMs: number) => useHudStore.getState().registerPong(latencyMs),
  setFps: (fps: number) => useHudStore.getState().setFps(fps),
  setMapInfo: (seed: number, visiblePercent: number, rockPercent: number) =>
    useHudStore.getState().setMapInfo(seed, visiblePercent, rockPercent),
  setMatch: (match: MatchSnapshot) => useHudStore.getState().setMatch(match),
  setNotices: (notices: readonly Notice[]) => useHudStore.getState().setNotices(notices),
};

/**
 * Обратный канал: действия, которые HUD может запросить у игры.
 *
 * Store возит данные из игры в React, а это — единственная дорога
 * обратно. Она нужна потому, что кнопки живут в React, а команды
 * отдаёт игровой цикл, и связывать их напрямую значило бы протащить
 * ссылку на цикл через всё дерево компонентов.
 *
 * Реализация подставляется при старте игры и снимается при остановке.
 * До подстановки все вызовы молча ничего не делают — это правильно:
 * HUD успевает смонтироваться раньше, чем PixiJS закончит инициализацию.
 */
export interface MatchCommands {
  /** Заказ юнита. `count` больше единицы — пакет по Ctrl или Shift. */
  train(unitType: number, count: number): void;
  setBuildKind(kind: number | null): void;
  toggleNukeAim(): void;
  buyUpgrade(branch: number): void;
  restart(): void;
}

const NO_COMMANDS: MatchCommands = {
  train: () => undefined,
  setBuildKind: () => undefined,
  toggleNukeAim: () => undefined,
  buyUpgrade: () => undefined,
  restart: () => undefined,
};

let commands: MatchCommands = NO_COMMANDS;

export const setMatchCommands = (next: MatchCommands | null): void => {
  commands = next ?? NO_COMMANDS;
};

export const matchCommands = (): MatchCommands => commands;
