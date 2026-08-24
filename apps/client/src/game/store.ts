import { AttackStance } from '@td/shared';
import { create } from 'zustand';
import type { Notice } from './rejections.js';
import { DEFAULT_SOUND_SETTINGS } from '../audio/settings.js';
import type { SoundSettings } from '../audio/settings.js';

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

/**
 * Строка характеристики под плиткой тулбара.
 *
 * Здесь ДЕЙСТВУЮЩЕЕ значение, а не номер уровня, и это главная разница
 * с прежней панелью прокачки. «Ур. 7» не отвечает на вопрос, ради которого
 * игрок смотрит на строку: решая, покупать ли восьмой, он сравнивает силу.
 *
 * Величина уже переведена в те единицы, в которых характеристику читают:
 * скорострельность — выстрелами в секунду, дальность — клетками, время
 * возрождения — секундами. Переводить это в компонентах значило бы
 * размазать знание о внутреннем представлении по всему интерфейсу.
 *
 * Подпись здесь не хранится: она берётся из таблицы веток по индексу.
 * Две копии одного названия неизбежно разойдутся.
 */
export interface StatRow {
  /** Индекс ветки в `UPGRADE_BRANCHES` — с ним уходит команда покупки. */
  readonly branch: number;
  readonly value: number;
  /** Сколько знаков после запятой показывать. */
  readonly fraction: number;
  /** Цена следующего уровня, в «видимых» единицах. */
  readonly cost: number;
  readonly affordable: boolean;
}

/**
 * Положение дел одной стороны матча — своей или чужой.
 *
 * Чужая сторона показывается наравне со своей, и это не поблажка,
 * а следствие уже принятого решения: тумана войны в игре нет. Всё
 * перечисленное игрок и так видит на поле, разница только в том, что
 * считать вручную ему больше не нужно.
 *
 * Имени участника здесь нет намеренно. Имя приходит из комнаты, а не
 * из мира, и живёт в `session-store`; игровой цикл о нём не знает.
 * Класть его сюда значило бы поставить снимок матча в зависимость
 * от лобби — и снабжать поддельным именем матч, запущенный без комнаты.
 */
export interface SideView {
  /** Прочность командного центра. Ноль, если он уже разрушен. */
  readonly baseHealth: number;
  readonly baseMaxHealth: number;
  readonly generalAlive: boolean;
  /** Секунд до возрождения генерала. Ноль, пока он в строю. */
  readonly respawnInSeconds: number;
  /** Число живых юнитов по типу. Индекс — значение `UnitType`. */
  readonly unitCounts: readonly number[];
  /**
   * Число построек по виду. Индекс — значение `StructureKind`.
   *
   * База считается наравне с остальными: отдельная ветка в цикле стоила бы
   * дороже лишнего числа в массиве. Показывается она не отсюда, а полосой
   * прочности — у неё своя роль, и в ряду «сколько чего построено» единица
   * не значит ничего.
   */
  readonly structureCounts: readonly number[];
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
  readonly unitCap: number;
  /**
   * Положение дел по каждой стороне, по индексу стороны.
   *
   * Именно здесь живут числа, которые прежде были только своими: войска,
   * постройки, прочность базы, состояние генерала. Верхняя полоса
   * показывает обе стороны, и держать свою сторону отдельным набором
   * полей значило бы описывать одно и то же дважды.
   */
  readonly sides: readonly SideView[];
  /** Цены юнитов по типу, с учётом подорожания от прокачки. */
  readonly unitCosts: readonly number[];
  /** Цены построек по виду. */
  readonly structureCosts: readonly number[];
  /**
   * Цена пуска и радиус поражения — с учётом прокачки радиуса.
   * Цена выводится из радиуса: платят за накрытую площадь.
   */
  readonly nukeCost: number;
  readonly nukeRadiusCells: number;
  /**
   * Строки характеристик по целям прокачки: индекс — значение
   * `UpgradeTarget`. Пустой список означает, что качать у этой цели нечего.
   */
  readonly stats: readonly (readonly StatRow[])[];
  readonly targetLabel: string;
  readonly matchSeconds: number;
  /** Номер победившего игрока, либо null, пока матч идёт. */
  readonly winner: number | null;
  /** Включён режим строительства — даже если вид ещё не выбран. */
  readonly building: boolean;
  /** Вид постройки, выбранный для размещения, либо null. */
  readonly buildKind: number | null;
  readonly aimingNuke: boolean;
  /**
   * Игрок наводит цель атаки.
   *
   * Существует ради касания: цель ставит правая кнопка мыши,
   * а у пальца кнопок нет вовсе.
   */
  readonly aimingTarget: boolean;
  /** Режим атаки войска: приказ отдаётся всему войску сразу. */
  readonly stance: AttackStance;
}

/** Сторона, о которой ещё ничего не известно: матч не начался. */
export const EMPTY_SIDE: SideView = {
  baseHealth: 0,
  baseMaxHealth: 0,
  generalAlive: true,
  respawnInSeconds: 0,
  unitCounts: [],
  structureCounts: [],
};

const EMPTY_MATCH: MatchSnapshot = {
  localPlayer: 0,
  energy: 0,
  incomePerSecond: 0,
  unitCap: 0,
  sides: [],
  unitCosts: [],
  structureCosts: [],
  nukeCost: 0,
  nukeRadiusCells: 0,
  stats: [],
  targetLabel: '—',
  matchSeconds: 0,
  winner: null,
  building: false,
  buildKind: null,
  aimingNuke: false,
  aimingTarget: false,
  stance: AttackStance.Breakthrough,
};

/**
 * Сведения о выделенной постройке.
 *
 * Всё уже переведено в «видимые» величины: React ничего не считает
 * и в состояние мира не заглядывает.
 *
 * Личный рост показывается обязательно. Башня растёт убийствами и вместе
 * с ними гибнет; без этого числа игрок не может узнать, какая из его
 * башен выросла вдвое, а значит не может решить, какую защищать.
 *
 * Чужие постройки показываются наравне со своими: тумана войны в игре
 * нет намеренно, уровни соперника видны обоим, и прятать здесь нечего.
 */
export interface SelectionView {
  readonly cell: number;
  readonly label: string;
  readonly own: boolean;
  readonly health: number;
  readonly maxHealth: number;
  /**
   * Постройка вообще способна набирать ранг. У базы и стены — нет,
   * и строки ранга им показывать не надо: «Ранг 0» читалось бы как
   * «ещё не набран», хотя набрать его здесь нельзя.
   */
  readonly ranked: boolean;
  /** Ветеранский ранг: от нуля до пяти. */
  readonly rank: number;
  /** Сколько убийств набрано. Растёт и после того, как ранг упёрся. */
  readonly kills: number;
  /** Сколько убийств до следующего ранга. Ноль — ранг высший. */
  readonly killsToNextRank: number;
  readonly attack: number;
  /** Дальность в клетках. Ноль означает, что постройка не стреляет. */
  readonly rangeCells: number;
  /** Секунд до конца возведения. Ноль — уже готова. */
  readonly buildingSeconds: number;
  /** Секунд до исчезновения при сносе. Ноль — снос не идёт. */
  readonly demolishSeconds: number;
  /** Снос возможен. Иначе причина в `demolishBlocked`. */
  readonly canDemolish: boolean;
  /** Почему снести нельзя. Пусто, когда можно. */
  readonly demolishBlocked: string;
}
/**
 * Показания плавности — то, чем частота кадров заменяется по существу.
 *
 * Собраны в один вид потому, что и снимаются, и читаются вместе:
 * поодиночке ни одно из этих чисел на вопрос «дёргается ли» не отвечает.
 */
export interface SmoothnessView {
  readonly frameP50: number;
  readonly frameP95: number;
  readonly frameMax: number;
  /** Сколько кадров вышло длиннее тика. Точное число, а не оценка. */
  readonly frameLong: number;
  readonly netGapP95: number;
  readonly netGapMax: number;
}

interface HudState {
  readonly status: ConnectionStatus;
  readonly tick: number;
  /** Сколько раз сервер ответил на ping. Признак живого канала. */
  readonly pongCount: number;
  /** Время оборота пакета в миллисекундах. */
  readonly latencyMs: number;
  /** Кадров в секунду, усреднённо. */
  readonly fps: number;
  /**
   * Плавность: распределение промежутка между кадрами, миллисекунды.
   *
   * Хранится рядом с `fps`, но заменяет его по смыслу. Частота кадров
   * усредняет, а рывок живёт в хвосте: один кадр длиной в двести
   * миллисекунд опускает шестьдесят кадров в секунду до пятидесяти
   * пяти, и в это число не попадает.
   *
   * `frameLong` — сколько кадров вышло длиннее тика. Точное число,
   * а не оценка по корзинам: именно на него и смотрят.
   */
  readonly frameP50: number;
  readonly frameP95: number;
  readonly frameMax: number;
  readonly frameLong: number;
  /**
   * Разброс промежутков между приходами кадров команд от сервера.
   *
   * Ожидается длительность тика. Несколько промежутков около нуля
   * подряд означают, что сервер прислал пачку после заминки, — и это
   * единственный способ отличить дрожание сервера от дрожания
   * браузера, не имея показаний с обеих сторон разом.
   */
  readonly netGapP95: number;
  readonly netGapMax: number;
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
  /** Выделенная постройка, либо null. Состояние интерфейса, не мира. */
  readonly selection: SelectionView | null;
  /**
   * Открыто ли меню матча.
   *
   * Состояние интерфейса одного игрока, как и выделение: по сети
   * не передаётся, в состояние мира не попадает, в контрольную сумму
   * не входит. Владеет им управление — от него зависит, разбирать ли
   * нажатия, — а сюда оно попадает затем, чтобы HUD знал, что рисовать.
   */
  readonly menuOpen: boolean;
  /**
   * Развёрнуты ли столбцы характеристик в нижнем тулбаре.
   *
   * Переживает перезапуск матча: игрок настраивает это под себя один раз,
   * и возвращать ему каждый матч чужое умолчание незачем.
   */
  readonly statsOpen: boolean;
  /**
   * Громкости и выключатель звука.
   *
   * Состояние интерфейса того же рода, что `selection`: мира оно
   * не касается, на сервер не уезжает и переживает перезагрузку
   * страницы своими силами (`audio/settings.ts`).
   */
  readonly sound: SoundSettings;

  setStatus(status: ConnectionStatus): void;
  setTick(tick: number): void;
  registerPong(latencyMs: number): void;
  setFps(fps: number): void;
  /** Показания плавности разом: они меняются вместе и читаются вместе. */
  setSmoothness(smoothness: SmoothnessView): void;
  setMapInfo(seed: number, visiblePercent: number, rockPercent: number): void;
  setMatch(match: MatchSnapshot): void;
  setNotices(notices: readonly Notice[]): void;
  setPhase(phase: MatchPhaseView): void;
  setNetwork(delayTicks: number, pending: number, catchUpProgress: number): void;
  setSync(tick: number, checksum: number): void;
  setOutcome(outcome: MatchOutcomeView | null): void;
  setSelection(selection: SelectionView | null): void;
  setMenuOpen(open: boolean): void;
  toggleStats(): void;
  setSound(sound: SoundSettings): void;
}

/**
 * Где хранится выбор игрока «показывать характеристики или нет».
 *
 * localStorage, а не состояние матча: это настройка интерфейса, она
 * не имеет отношения ни к миру, ни к сессии и должна пережить и новый
 * матч, и перезагрузку страницы.
 *
 * Чтение обёрнуто в try: в приватном режиме некоторых браузеров обращение
 * к хранилищу бросает исключение, и падать из-за настройки внешнего вида
 * было бы нелепо.
 */
const STATS_OPEN_KEY = 'td:toolbar-stats';

const readStatsOpen = (): boolean => {
  try {
    return localStorage.getItem(STATS_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
};

const writeStatsOpen = (open: boolean): void => {
  try {
    localStorage.setItem(STATS_OPEN_KEY, open ? '1' : '0');
  } catch {
    // Не сохранилось — не беда: настройка вернётся к умолчанию, и только.
  }
};

export const useHudStore = create<HudState>((set) => ({
  status: 'offline',
  tick: 0,
  pongCount: 0,
  latencyMs: 0,
  fps: 0,
  frameP50: 0,
  frameP95: 0,
  frameMax: 0,
  frameLong: 0,
  netGapP95: 0,
  netGapMax: 0,
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
  selection: null,
  menuOpen: false,
  statsOpen: readStatsOpen(),
  sound: DEFAULT_SOUND_SETTINGS,

  setStatus: (status) => set({ status }),
  setTick: (tick) => set({ tick }),
  registerPong: (latencyMs) => set((state) => ({ pongCount: state.pongCount + 1, latencyMs })),
  setFps: (fps) => set({ fps }),

  // Одним изменением состояния, а не шестью: величины меняются вместе
  // и читаются вместе, а шесть отдельных вызовов означали бы шесть
  // перерисовок панели на каждое обновление.
  setSmoothness: (smoothness) =>
    set((state) =>
      state.frameP50 === smoothness.frameP50 &&
      state.frameP95 === smoothness.frameP95 &&
      state.frameMax === smoothness.frameMax &&
      state.frameLong === smoothness.frameLong &&
      state.netGapP95 === smoothness.netGapP95 &&
      state.netGapMax === smoothness.netGapMax
        ? state
        : smoothness,
    ),
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
  setSelection: (selection) => set({ selection }),
  setMenuOpen: (menuOpen) => set({ menuOpen }),

  toggleStats: () =>
    set((state) => {
      const statsOpen = !state.statsOpen;
      writeStatsOpen(statsOpen);
      return { statsOpen };
    }),
  setSound: (sound) => set({ sound }),
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
  setSmoothness: (smoothness: SmoothnessView) => useHudStore.getState().setSmoothness(smoothness),
  setMapInfo: (seed: number, visiblePercent: number, rockPercent: number) =>
    useHudStore.getState().setMapInfo(seed, visiblePercent, rockPercent),
  setMatch: (match: MatchSnapshot) => useHudStore.getState().setMatch(match),
  setNotices: (notices: readonly Notice[]) => useHudStore.getState().setNotices(notices),
  setPhase: (phase: MatchPhaseView) => useHudStore.getState().setPhase(phase),
  setNetwork: (delayTicks: number, pending: number, catchUpProgress: number) =>
    useHudStore.getState().setNetwork(delayTicks, pending, catchUpProgress),
  setSync: (tick: number, checksum: number) => useHudStore.getState().setSync(tick, checksum),
  setOutcome: (outcome: MatchOutcomeView | null) => useHudStore.getState().setOutcome(outcome),
  setSelection: (selection: SelectionView | null) => useHudStore.getState().setSelection(selection),
  setMenuOpen: (open: boolean) => useHudStore.getState().setMenuOpen(open),
  toggleStats: () => useHudStore.getState().toggleStats(),
  setSound: (sound: SoundSettings) => useHudStore.getState().setSound(sound),
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
  /** Включить или выключить наведение цели атаки. */
  toggleTargetAim(): void;
  /** Сменить режим атаки войска. */
  setStance(stance: number): void;
  buyUpgrade(branch: number): void;
  /** Снести выделенную постройку. */
  demolish(cell: number): void;
  /**
   * Открыть или закрыть меню матча.
   *
   * Идёт через управление, а не прямо в store: меню гасит разбор нажатий,
   * и два источника правды здесь означали бы открытое меню при живой
   * клавиатуре.
   */
  setMenuOpen(open: boolean): void;
  /** Свернуть или развернуть характеристики в тулбаре. */
  toggleStats(): void;
  /** Перенести камеру к своему генералу либо к своей базе. */
  focusOwn(what: 'general' | 'base'): void;
  restart(): void;
}

const NO_COMMANDS: MatchCommands = {
  train: () => undefined,
  setBuildKind: () => undefined,
  toggleNukeAim: () => undefined,
  toggleTargetAim: () => undefined,
  setStance: () => undefined,
  buyUpgrade: () => undefined,
  demolish: () => undefined,
  setMenuOpen: () => undefined,
  toggleStats: () => undefined,
  focusOwn: () => undefined,
  restart: () => undefined,
};

let commands: MatchCommands = NO_COMMANDS;

export const setMatchCommands = (next: MatchCommands | null): void => {
  commands = next ?? NO_COMMANDS;
};

export const matchCommands = (): MatchCommands => commands;

/**
 * Тот же обратный канал, но для звука.
 *
 * Отдельно от `MatchCommands` потому, что живёт по другим правилам:
 * команды матча уезжают на сервер и осмысленны только в матче,
 * а громкость — настройка клиента, и менять её игрок вправе когда
 * угодно.
 */
export interface SoundCommands {
  apply(settings: SoundSettings): void;
}

const NO_SOUND_COMMANDS: SoundCommands = { apply: () => undefined };

let sound: SoundCommands = NO_SOUND_COMMANDS;

export const setSoundCommands = (next: SoundCommands | null): void => {
  sound = next ?? NO_SOUND_COMMANDS;
};

export const soundCommands = (): SoundCommands => sound;
