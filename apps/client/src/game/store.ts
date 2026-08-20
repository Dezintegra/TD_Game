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

/**
 * Положение дел в сетевом матче — то, чего не выразить состоянием мира.
 *
 * «Ждём соперника» и «восстанавливаемся» выглядят на поле одинаково:
 * мир стоит. Разница для игрока огромная, и молчать о ней нельзя —
 * неподвижная картинка без объяснения читается как поломка.
 */
export type MatchPhaseView =
  /** Соединение открыто, приветствие ещё не пришло. */
  | 'connecting'
  /** Матч заведён, но второй участник ещё не подключился. */
  | 'awaiting-opponent'
  /** Мир восстанавливается из истории команд. */
  | 'catching-up'
  | 'playing'
  /** Расхождение с сервером: идёт пересборка. */
  | 'desynced'
  /** Пересборка не помогла: играть дальше нельзя. */
  | 'stopped'
  | 'finished';

/** Чем кончился матч. Причина приходит от сервера вместе с победителем. */
export interface MatchOutcomeView {
  readonly winner: number | null;
  readonly reason: number;
}

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
  /**
   * За какую сторону играет человек.
   *
   * Нужна HUD, чтобы отличить победу от поражения. Раньше сторона была
   * зашита нулём и в снимке не значилась; с приходом комнат вошедшему
   * достаётся сторона 1, и зашитый ноль показал бы ему «ПОБЕДА»
   * при собственном поражении.
   */
  readonly localPlayer: number;
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
  localPlayer: 0,
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
  /** Что сейчас происходит с сетевым матчем. */
  readonly phase: MatchPhaseView;
  /**
   * Задержка ввода в тиках: через сколько тиков команда попадёт в мир.
   *
   * Величину назначает сервер по худшему из каналов, одну на обоих.
   * Игрок вправе знать, почему постройка появляется не мгновенно.
   */
  readonly inputDelayTicks: number;
  /** Сколько своих команд ещё летит к серверу и обратно. */
  readonly pendingCommands: number;
  /**
   * Доля восстановленного мира при догоне, от нуля до единицы.
   *
   * Догон занимает секунды, и молчаливое ожидание неотличимо от зависания.
   * Полоса прогресса отвечает на единственный вопрос, который в этот
   * момент есть у игрока: это надолго?
   */
  readonly catchUpProgress: number;
  /**
   * Последняя сверка: тик подтверждённого мира и его контрольная сумма.
   *
   * Величина диагностическая и текстом не показывается. Нужна она затем,
   * что «миры сошлись» — единственное настоящее свидетельство общего
   * матча, и проверять его косвенно, по картинке, значит не проверять
   * вовсе.
   */
  readonly syncTick: number;
  readonly syncChecksum: number;
  /** Исход матча от сервера. До конца матча — null. */
  readonly outcome: MatchOutcomeView | null;

  setStatus(status: ConnectionStatus): void;
  setTick(tick: number): void;
  registerPong(latencyMs: number): void;
  setFps(fps: number): void;
  setMapInfo(seed: number, visiblePercent: number, rockPercent: number): void;
  setMatch(match: MatchSnapshot): void;
  setNotices(notices: readonly Notice[]): void;
  setPhase(phase: MatchPhaseView): void;
  setNetwork(delayTicks: number, pending: number, catchUpProgress: number): void;
  setSync(tick: number, checksum: number): void;
  setOutcome(outcome: MatchOutcomeView | null): void;
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
  phase: 'connecting',
  inputDelayTicks: 0,
  pendingCommands: 0,
  catchUpProgress: 0,
  syncTick: 0,
  syncChecksum: 0,
  outcome: null,

  setStatus: (status) => set({ status }),
  setTick: (tick) => set({ tick }),
  registerPong: (latencyMs) => set((state) => ({ pongCount: state.pongCount + 1, latencyMs })),
  setFps: (fps) => set({ fps }),
  setMapInfo: (seed, visiblePercent, rockPercent) => set({ seed, visiblePercent, rockPercent }),
  setMatch: (match) => set({ match }),
  setNotices: (notices) => set({ notices }),
  setPhase: (phase) => set({ phase }),

  // Три величины разом, одним изменением состояния: они меняются вместе
  // и читаются вместе, а три отдельных вызова означали бы три перерисовки
  // панели на каждый кадр.
  setNetwork: (inputDelayTicks, pendingCommands, catchUpProgress) =>
    set((state) =>
      state.inputDelayTicks === inputDelayTicks &&
      state.pendingCommands === pendingCommands &&
      state.catchUpProgress === catchUpProgress
        ? state
        : { inputDelayTicks, pendingCommands, catchUpProgress },
    ),

  setSync: (syncTick, syncChecksum) => set({ syncTick, syncChecksum }),
  setOutcome: (outcome) => set({ outcome }),
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
  setPhase: (phase: MatchPhaseView) => useHudStore.getState().setPhase(phase),
  setNetwork: (delayTicks: number, pending: number, catchUpProgress: number) =>
    useHudStore.getState().setNetwork(delayTicks, pending, catchUpProgress),
  setSync: (tick: number, checksum: number) => useHudStore.getState().setSync(tick, checksum),
  setOutcome: (outcome: MatchOutcomeView | null) => useHudStore.getState().setOutcome(outcome),
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
