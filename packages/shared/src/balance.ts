import { TICKS_PER_SECOND } from './constants.js';
import { cellsToUnits } from './units.js';

/**
 * Числа баланса — все до единого.
 *
 * Правило: игровых чисел не должно быть ни в ядре симуляции, ни в
 * интерфейсе, ни у противника под управлением компьютера. Меняете
 * ощущение от игры — правите этот файл, и только его.
 *
 * Расчёт сделан на матч длиной 10–15 минут.
 *
 * Ниже почти всё выводится из восьми базовых величин через множители,
 * заданные игровым замыслом. Множители записаны прямо в комментариях
 * к каждому типу, чтобы связь с замыслом не потерялась.
 */

// ─────────────────────────────────────────────────────────────────────────
// Энергия
// ─────────────────────────────────────────────────────────────────────────

/**
 * Сколько внутренних единиц приходится на одну «видимую» единицу энергии.
 *
 * Масштаб равен числу тиков в секунде, и это не совпадение. Доход задан
 * в дизайне как «столько-то единиц в секунду», а начисляется он каждый тик.
 * При таком масштабе доход в N единиц в секунду превращается ровно в N
 * внутренних единиц за тик — без остатка и без накопителя дробной части,
 * который иначе пришлось бы хранить в состоянии мира и не забывать
 * откатывать вместе с ним.
 */
export const ENERGY_SCALE = TICKS_PER_SECOND;

/** Переводит «видимую» энергию во внутренние единицы. */
export const energy = (visible: number): number => Math.round(visible * ENERGY_SCALE);

/** Переводит внутренние единицы в «видимые». Только для интерфейса. */
export const energyToVisible = (internal: number): number => Math.floor(internal / ENERGY_SCALE);

/** Базовый доход: десять единиц в секунду, то есть десять внутренних за тик. */
export const BASE_INCOME_PER_TICK = 10;

/** Стартовый запас. Хватает на пару башен или на десяток штурмовиков. */
export const STARTING_ENERGY = energy(300);

// ─────────────────────────────────────────────────────────────────────────
// Базовые величины, от которых идут все множители
// ─────────────────────────────────────────────────────────────────────────

/**
 * Длительность матча, на которую сделан расчёт баланса, в секундах.
 *
 * Величина не участвует в правилах: ядро её не читает, и матч по ней
 * не заканчивается. Она нужна тем, кто оценивает выгоду наперёд —
 * прежде всего противнику под управлением компьютера, который через неё
 * переводит урон по базе в энергию: разрушение базы есть победа, а победа
 * стоит всего, что игрок за матч заработает.
 *
 * До сих пор число жило в комментарии к этому файлу («расчёт сделан
 * на матч длиной 10–15 минут»), то есть было, но сослаться на него
 * было нельзя. Взята середина названного диапазона.
 */
export const MATCH_TARGET_SECONDS = 12 * 60;

/** Базовое здоровье. Штурмовик имеет ровно столько. */
export const BASE_HEALTH = 100;

/** Базовый урон одного выстрела. */
export const BASE_ATTACK = 10;

/** Базовая перезарядка: один выстрел в секунду. */
export const BASE_COOLDOWN_TICKS = TICKS_PER_SECOND;

/** Базовая дальность стрельбы юнита, в клетках. */
export const BASE_UNIT_RANGE_CELLS = 2;

/** Базовая дальность стрельбы башни, в клетках. */
export const BASE_TOWER_RANGE_CELLS = 5;

/**
 * Базовая скорость: примерно две клетки в секунду.
 *
 * Хранится сразу в «внутренних единицах за тик», потому что именно в таком
 * виде она нужна каждый тик. Две клетки в секунду при тридцати тиках дают
 * 66,67 единицы за тик — дробное число, которого в мире быть не должно,
 * поэтому округляем до 67 и получаем 2,01 клетки в секунду. Расхождение
 * в полпроцента незаметно, зато арифметика остаётся целой.
 */
export const BASE_SPEED_UNITS_PER_TICK = 67;

/** Базовая стоимость юнита. От неё считаются цена ядерного удара и награды. */
export const BASE_UNIT_COST = energy(25);

// ─────────────────────────────────────────────────────────────────────────
// Юниты
// ─────────────────────────────────────────────────────────────────────────

export const UnitType = {
  /** Штурмовик: всё базовое. Основа любой атаки. */
  Assault: 0,
  /** Снайпер: бьёт живых больно и издалека, по постройкам почти бесполезен. */
  Sniper: 1,
  /** Гранатомётчик: осадный. Медленный, дорогой, перекрывает башню по дальности. */
  Grenadier: 2,
} as const;

export type UnitType = (typeof UnitType)[keyof typeof UnitType];

export const UNIT_TYPES: readonly UnitType[] = [
  UnitType.Assault,
  UnitType.Sniper,
  UnitType.Grenadier,
];

export interface UnitStats {
  readonly label: string;
  readonly health: number;
  readonly attack: number;
  readonly cooldownTicks: number;
  /** Дальность стрельбы во внутренних единицах. */
  readonly range: number;
  readonly speed: number;
  /** Доля урона по постройкам, в процентах от обычного урона. */
  readonly structureDamagePercent: number;
  readonly cost: number;
}

/**
 * Характеристики юнитов.
 *
 * Множители относительно базовых величин записаны в комментариях —
 * это прямая расшифровка игрового замысла, и сверять её нужно с ним,
 * а не с этими числами.
 */
export const UNIT_STATS: Readonly<Record<UnitType, UnitStats>> = {
  [UnitType.Assault]: {
    label: 'Штурмовик',
    health: BASE_HEALTH, // ×1
    attack: BASE_ATTACK, // ×1
    cooldownTicks: BASE_COOLDOWN_TICKS, // ×1
    range: cellsToUnits(BASE_UNIT_RANGE_CELLS), // ×1
    speed: BASE_SPEED_UNITS_PER_TICK, // ×1
    structureDamagePercent: 100, // ×1
    cost: BASE_UNIT_COST, // ×1
  },
  [UnitType.Sniper]: {
    label: 'Снайпер',
    health: Math.round(BASE_HEALTH * 0.75), // ×0,75
    attack: BASE_ATTACK * 3, // ×3
    // Скорострельность ×0,3 — значит перезарядка делится на 0,3.
    cooldownTicks: Math.round(BASE_COOLDOWN_TICKS / 0.3),
    range: cellsToUnits(BASE_UNIT_RANGE_CELLS * 3), // ×3
    speed: BASE_SPEED_UNITS_PER_TICK, // ×1
    structureDamagePercent: 10, // ×0,1
    cost: BASE_UNIT_COST * 2, // ×2
  },
  [UnitType.Grenadier]: {
    label: 'Гранатомётчик',
    health: BASE_HEALTH, // ×1
    attack: BASE_ATTACK * 3, // ×3
    cooldownTicks: Math.round(BASE_COOLDOWN_TICKS / 0.3), // скорострельность ×0,3
    // Дальность задана не множителем, а относительно башни: ровно на клетку
    // больше базовой дальности башни. В этом весь смысл гранатомётчика —
    // он расстреливает башню, стоя вне её досягаемости.
    range: cellsToUnits(BASE_TOWER_RANGE_CELLS + 1),
    speed: Math.round(BASE_SPEED_UNITS_PER_TICK * 0.3), // ×0,3
    structureDamagePercent: 100, // ×1
    cost: BASE_UNIT_COST * 10, // ×10
  },
};

/**
 * Потолок численности живых юнитов у одного игрока.
 *
 * Ограничение техническое, а не игровое: четыреста юнитов на карте
 * считаются и рисуются спокойно, тысячи — уже нет. Достигнув потолка,
 * производство встаёт на паузу, а очередь сохраняется.
 */
export const UNIT_CAP = 200;

/** Сколько заказов помещается в очередь производства. */
export const PRODUCTION_QUEUE_CAP = 20;

// ─────────────────────────────────────────────────────────────────────────
// Постройки
// ─────────────────────────────────────────────────────────────────────────

export const StructureKind = {
  /** База. Не строится, существует с начала матча, её разрушение — победа. */
  Base: 0,
  /** Стена: не стреляет, но очень прочная. Покупает время. */
  Wall: 1,
  /** Базовая башня. */
  TowerBasic: 2,
  /** Снайперская башня: дальняя и больно бьющая, но редко стреляющая. */
  TowerSniper: 3,
} as const;

export type StructureKind = (typeof StructureKind)[keyof typeof StructureKind];

/** Что игрок может строить. База сюда не входит: её не строят. */
export const BUILDABLE_KINDS: readonly StructureKind[] = [
  StructureKind.Wall,
  StructureKind.TowerBasic,
  StructureKind.TowerSniper,
];

export interface StructureStats {
  readonly label: string;
  readonly health: number;
  /** Ноль означает, что постройка не стреляет. */
  readonly attack: number;
  readonly cooldownTicks: number;
  readonly range: number;
  readonly cost: number;
  readonly buildTicks: number;
  /**
   * Радиус основания в клетках: 0 — одна клетка, 1 — площадка три на три.
   * Только у базы отличен от нуля.
   */
  readonly footprintRadius: number;
}

export const STRUCTURE_STATS: Readonly<Record<StructureKind, StructureStats>> = {
  [StructureKind.Base]: {
    label: 'Командный центр',
    // Запас подобран под матч в 10–15 минут и является ГЛАВНЫМ регулятором
    // его длительности: почти всё остальное задано соотношениями замысла,
    // а это число свободно.
    //
    // Считается так. Юниты друг друга не расталкивают, поэтому у базы может
    // собраться сколько угодно стрелков, и потолок урона задаётся не
    // геометрией, а численностью. Полный потолок в двести штурмовиков
    // сносит базу за полминуты, полсотни — за две минуты, полтора десятка —
    // за семь. Дойти же до неё через всю карту и пережить оборону ещё надо.
    //
    // Первая версия ставила сюда шестьдесят базовых здоровий, и матч
    // заканчивался на третьей минуте: первая же волна доходила до базы
    // и сносила её, не встретив сопротивления, которое успело бы окупиться.
    health: BASE_HEALTH * 500,
    attack: 0,
    cooldownTicks: 0,
    range: 0,
    cost: 0,
    buildTicks: 0,
    footprintRadius: 1,
  },
  [StructureKind.Wall]: {
    label: 'Стена',
    // ×10 базового здоровья — прямое требование замысла.
    //
    // Именно базового (100), а не здоровья башни. От здоровья башни
    // получилось бы 2000, и стена стала бы практически неразрушимой,
    // тогда как по замыслу она «покупает время, а не отменяет атаку».
    health: BASE_HEALTH * 10,
    attack: 0,
    cooldownTicks: 0,
    range: 0,
    cost: energy(20),
    // Пять секунд — вдвое с половиной дольше, чем стена копится.
    //
    // У постройки два ограничителя: цена (сколько копить) и время
    // возведения (сколько стоять). Работает тот, который длиннее.
    // Стена стоит две секунды базового дохода, и ценой её ограничить
    // невозможно в принципе: сколько её ни поднимай, она останется
    // мелочью. Единственный доступный ограничитель — время, и оно
    // намеренно сделано главным. Иначе стена бесплатна прямо в бою,
    // а ход, меняющий геометрию карты, не должен стоить полсекунды.
    buildTicks: TICKS_PER_SECOND * 5,
    footprintRadius: 0,
  },
  [StructureKind.TowerBasic]: {
    label: 'Башня',
    health: BASE_HEALTH * 2,
    // Полуторный базовый урон. Башня неподвижна и не может отступить,
    // поэтому бьёт сильнее пехоты — но не настолько, чтобы три штурмовика
    // не могли её разменять.
    attack: Math.round(BASE_ATTACK * 1.5),
    cooldownTicks: BASE_COOLDOWN_TICKS,
    range: cellsToUnits(BASE_TOWER_RANGE_CELLS),
    cost: energy(60),
    // Шесть секунд — ровно столько же, сколько башня копится при базовом
    // доходе. Два ограничителя, цена и время, здесь сравнялись, и это
    // самый честный случай: башня одинаково ограничена и деньгами,
    // и необходимостью постоять рядом с местом стройки.
    buildTicks: TICKS_PER_SECOND * 6,
    footprintRadius: 0,
  },
  [StructureKind.TowerSniper]: {
    label: 'Снайперская башня',
    health: Math.round(BASE_HEALTH * 2 * 0.75), // ×0,75 от базовой башни
    attack: Math.round(BASE_ATTACK * 1.5 * 3), // ×3
    cooldownTicks: Math.round(BASE_COOLDOWN_TICKS / 0.3), // скорострельность ×0,3
    // Дальность вдвое, а не втрое.
    //
    // Втрое дало бы пятнадцать клеток — половину видимого экрана. Такая
    // башня простреливала бы поле раньше, чем игрок успевал её заметить,
    // и превращалась бы из контрбатарейной в оружие по всей карте.
    // Двукратная дальность сохраняет за ней роль: она перекрывает
    // гранатомётчика с его шестью клетками, но не более того.
    range: cellsToUnits(BASE_TOWER_RANGE_CELLS * 2),
    cost: energy(150),
    // Девять секунд против пятнадцати, за которые башня копится.
    //
    // Здесь главным ограничителем намеренно остаётся цена: снайперская
    // башня задумана как дорогое специализированное сооружение, и всё,
    // что от времени требуется, — перестать быть незаметным. Уравнять
    // время с ценой означало бы полминуты неподвижного генерала,
    // после чего башня не строилась бы никогда.
    buildTicks: TICKS_PER_SECOND * 9,
    footprintRadius: 0,
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Генерал
// ─────────────────────────────────────────────────────────────────────────

export const GENERAL_STATS = {
  label: 'Генерал',
  health: BASE_HEALTH * 2, // ×2
  attack: BASE_ATTACK, // ×1
  cooldownTicks: BASE_COOLDOWN_TICKS,
  range: cellsToUnits(BASE_UNIT_RANGE_CELLS),
  speed: Math.round(BASE_SPEED_UNITS_PER_TICK * 1.5), // ×1,5
  structureDamagePercent: 100,
  /** Радиус строительства вокруг генерала, во внутренних единицах. */
  buildRadius: cellsToUnits(5),
  /** Время возрождения: десять секунд по игровому замыслу. */
  respawnTicks: TICKS_PER_SECOND * 10,
} as const;

/** Ниже этого порога прокачка время возрождения не опускает. */
export const MIN_RESPAWN_TICKS = TICKS_PER_SECOND;

/** Ниже этого порога прокачка перезарядку не опускает. */
export const MIN_COOLDOWN_TICKS = 3;

/**
 * Награда генералу за убийство вражеского генерала —
 * двадцать базовых стоимостей юнита.
 */
export const GENERAL_KILL_REWARD = BASE_UNIT_COST * 20;

// ─────────────────────────────────────────────────────────────────────────
// Рост башни за убийства
// ─────────────────────────────────────────────────────────────────────────

/** Прибавка к атаке и прочности башни за каждое убийство, в процентах. */
export const TOWER_KILL_GROWTH_PERCENT = 5;

/**
 * Потолок роста башни: тысячекратное усиление.
 *
 * Причина арифметическая, не игровая — подробности в `percent.ts`.
 * В реальном матче потолок недостижим: до него нужно полторы сотни убийств
 * одной башней.
 */
export const TOWER_GROWTH_CAP_PPM = 1_000_000_000;

// ─────────────────────────────────────────────────────────────────────────
// Ядерный удар
// ─────────────────────────────────────────────────────────────────────────

/** Пятьдесят базовых стоимостей юнита. */
export const NUKE_COST = BASE_UNIT_COST * 50;

/** Радиус поражения: две базовые дальности выстрела башни. */
export const NUKE_RADIUS_CELLS = BASE_TOWER_RANGE_CELLS * 2;
export const NUKE_RADIUS = cellsToUnits(NUKE_RADIUS_CELLS);

/**
 * Задержка между командой и взрывом.
 *
 * Мгновенный удар не оставляет противнику хода: полсотни юнитов исчезают
 * без единого шанса среагировать. Три секунды и видимая метка на карте
 * превращают удар из наказания в угрозу, на которую можно ответить.
 */
export const NUKE_DELAY_TICKS = TICKS_PER_SECOND * 3;

/**
 * Запретная зона вокруг каждой базы: базы всегда остаются вне радиуса
 * поражения. Радиус взрыва плюс основание базы плюс клетка запаса.
 */
export const NUKE_BASE_EXCLUSION = cellsToUnits(NUKE_RADIUS_CELLS + 2);

// ─────────────────────────────────────────────────────────────────────────
// Прокачка
// ─────────────────────────────────────────────────────────────────────────

/**
 * Что именно прокачивается. Совпадает с «типом» из требования
 * «прокачивается для каждого типа независимо».
 */
export const UpgradeTarget = {
  UnitAssault: 0,
  UnitSniper: 1,
  UnitGrenadier: 2,
  TowerBasic: 3,
  TowerSniper: 4,
  Wall: 5,
  General: 6,
  Economy: 7,
} as const;

export type UpgradeTarget = (typeof UpgradeTarget)[keyof typeof UpgradeTarget];

export const UPGRADE_TARGET_COUNT = 8;

/** Какая характеристика улучшается. */
export const UpgradeStat = {
  Attack: 0,
  Health: 1,
  /** Улучшение уменьшает перезарядку. */
  FireRate: 2,
  Range: 3,
  Speed: 4,
  BuildRadius: 5,
  /** Улучшение уменьшает время возрождения. */
  RespawnTime: 6,
  Income: 7,
} as const;

export type UpgradeStat = (typeof UpgradeStat)[keyof typeof UpgradeStat];

export interface UpgradeBranch {
  readonly target: UpgradeTarget;
  readonly stat: UpgradeStat;
  readonly label: string;
  readonly baseCost: number;
  /** На сколько процентов дорожает следующий уровень этой же ветки. */
  readonly costGrowthPercent: number;
  /**
   * На сколько процентов меняется характеристика за уровень.
   * Отрицательное значение означает уменьшение — так устроены
   * перезарядка и время возрождения, где меньше значит лучше.
   */
  readonly effectPercent: number;
}

/**
 * Прибавка за уровень для «чем больше, тем лучше».
 * Единая для всех веток: разные шаги у похожих улучшений игрок не считывает,
 * зато они порождают неочевидные перекосы баланса.
 */
const GAIN = 10;

/**
 * Уменьшение за уровень для «чем меньше, тем лучше».
 *
 * Шесть процентов, а не десять. Уменьшение на десять процентов
 * сложным процентом за тридцать уровней даёт коэффициент 0,04 —
 * перезарядка практически исчезает. Шесть процентов оставляют 0,16,
 * что уже ощутимо, но не ломает игру.
 */
const REDUCE = -6;

/** Обычный рост цены уровня. У экономики он свой, вдвое с половиной больше. */
const COST_GROWTH = 10;

const branch = (
  target: UpgradeTarget,
  stat: UpgradeStat,
  label: string,
  baseCost: number,
  effectPercent: number,
): UpgradeBranch => ({
  target,
  stat,
  label,
  baseCost,
  costGrowthPercent: COST_GROWTH,
  effectPercent,
});

const unitBranches = (target: UpgradeTarget, cost: number): readonly UpgradeBranch[] => [
  branch(target, UpgradeStat.Attack, 'Атака', cost, GAIN),
  branch(target, UpgradeStat.Health, 'Прочность', cost, GAIN),
  branch(target, UpgradeStat.FireRate, 'Скорострельность', cost, REDUCE),
  branch(target, UpgradeStat.Speed, 'Скорость', cost, GAIN),
];

const towerBranches = (target: UpgradeTarget, cost: number): readonly UpgradeBranch[] => [
  branch(target, UpgradeStat.Attack, 'Атака', cost, GAIN),
  branch(target, UpgradeStat.Health, 'Прочность', cost, GAIN),
  branch(target, UpgradeStat.FireRate, 'Скорострельность', cost, REDUCE),
  branch(target, UpgradeStat.Range, 'Дальность', cost, GAIN),
];

/**
 * Все ветки прокачки одной таблицей.
 *
 * Двадцать семь веток — прямое следствие требования «каждый показатель
 * каждого типа независимо». Расписывать их ветвлениями в коде значило бы
 * гарантированно ошибиться при копировании, а в интерфейсе — сверстать
 * двадцать семь почти одинаковых блоков. Поэтому и ядро, и панель
 * прокачки выводятся из этой таблицы.
 *
 * ВАЖНО: порядок фиксирован. Индекс ветки в этом массиве — это то, что
 * едет в команде покупки, поэтому вставлять новые ветки можно только
 * в конец, иначе сохранённые записи матчей потеряют смысл.
 */
export const UPGRADE_BRANCHES: readonly UpgradeBranch[] = [
  ...unitBranches(UpgradeTarget.UnitAssault, energy(40)),
  ...unitBranches(UpgradeTarget.UnitSniper, energy(60)),
  ...unitBranches(UpgradeTarget.UnitGrenadier, energy(120)),
  ...towerBranches(UpgradeTarget.TowerBasic, energy(60)),
  ...towerBranches(UpgradeTarget.TowerSniper, energy(120)),
  branch(UpgradeTarget.Wall, UpgradeStat.Health, 'Прочность', energy(50), GAIN),
  branch(UpgradeTarget.General, UpgradeStat.Attack, 'Атака', energy(80), GAIN),
  branch(UpgradeTarget.General, UpgradeStat.Health, 'Прочность', energy(80), GAIN),
  branch(UpgradeTarget.General, UpgradeStat.Speed, 'Скорость', energy(80), GAIN),
  branch(UpgradeTarget.General, UpgradeStat.BuildRadius, 'Радиус стройки', energy(80), GAIN),
  branch(UpgradeTarget.General, UpgradeStat.RespawnTime, 'Воскрешение', energy(80), REDUCE),
  {
    target: UpgradeTarget.Economy,
    stat: UpgradeStat.Income,
    label: 'Добыча энергии',
    baseCost: energy(100),
    // Двадцать пять процентов вместо десяти — прямое требование замысла.
    // Экономика усиливает сама себя, поэтому дорожать должна быстрее всех.
    costGrowthPercent: 25,
    effectPercent: GAIN,
  },
];

export const UPGRADE_BRANCH_COUNT = UPGRADE_BRANCHES.length;

/**
 * Поиск ветки по цели и характеристике.
 *
 * Нужен тем, кто идёт от смысла к номеру: панели прокачки, противнику
 * под управлением компьютера и рендеру, который показывает уровень
 * оружия на модели юнита. Перебирать таблицу на каждое обращение нельзя —
 * рендер спрашивает про каждый тип каждый кадр.
 *
 * Ключ собран из двух чисел в одно: характеристик меньше шестнадцати,
 * поэтому сдвиг на шестнадцать разводит пары без пересечений.
 */
const BRANCH_BY_TARGET_STAT: ReadonlyMap<number, number> = new Map(
  UPGRADE_BRANCHES.map((entry, index) => [entry.target * 16 + entry.stat, index]),
);

/** Индекс ветки прокачки, либо -1, если такой ветки нет. */
export const upgradeBranchIndex = (target: UpgradeTarget, stat: UpgradeStat): number =>
  BRANCH_BY_TARGET_STAT.get(target * 16 + stat) ?? -1;

/**
 * Насколько дорожает покупка типа за каждый купленный уровень его прокачки.
 * Требование замысла, ровно два процента сложным процентом.
 */
export const PURCHASE_INFLATION_PERCENT = 2;

/**
 * Цели прокачки, у которых есть что покупать. Улучшение генерала
 * и экономики цен не двигает — покупать там нечего.
 */
export const INFLATES_PURCHASE: Readonly<Record<UpgradeTarget, boolean>> = {
  [UpgradeTarget.UnitAssault]: true,
  [UpgradeTarget.UnitSniper]: true,
  [UpgradeTarget.UnitGrenadier]: true,
  [UpgradeTarget.TowerBasic]: true,
  [UpgradeTarget.TowerSniper]: true,
  [UpgradeTarget.Wall]: true,
  [UpgradeTarget.General]: false,
  [UpgradeTarget.Economy]: false,
};

/** Соответствие типа юнита цели прокачки. */
export const UNIT_UPGRADE_TARGET: Readonly<Record<UnitType, UpgradeTarget>> = {
  [UnitType.Assault]: UpgradeTarget.UnitAssault,
  [UnitType.Sniper]: UpgradeTarget.UnitSniper,
  [UnitType.Grenadier]: UpgradeTarget.UnitGrenadier,
};

/**
 * Соответствие вида постройки цели прокачки.
 * База не прокачивается, поэтому у неё нет цели — и ставить сюда
 * что-то осмысленное было бы обманом.
 */
export const STRUCTURE_UPGRADE_TARGET: Readonly<Record<StructureKind, UpgradeTarget | undefined>> =
  {
    [StructureKind.Base]: undefined,
    [StructureKind.Wall]: UpgradeTarget.Wall,
    [StructureKind.TowerBasic]: UpgradeTarget.TowerBasic,
    [StructureKind.TowerSniper]: UpgradeTarget.TowerSniper,
  };

// ─────────────────────────────────────────────────────────────────────────
// Навигация
// ─────────────────────────────────────────────────────────────────────────

/**
 * Как часто разрешено пересчитывать поле потока, в тиках.
 *
 * Пересчёт стоит один обход карты и запускается по изменению цели или
 * набора построек. Без этого порога шквал построек вызвал бы пересчёт
 * на каждом тике.
 */
export const NAV_MIN_INTERVAL_TICKS = 10;

/**
 * Сколько прочности постройки соответствует одному «шагу» стоимости
 * при поиске пути сквозь преграды.
 *
 * Так прочность переводится в ту же единицу, что и расстояние: юнит
 * сравнивает «сколько идти» с «сколько ломать» одним числом.
 */
export const BREACH_HEALTH_PER_STEP = 50;

/** Верхняя граница платы за пролом одной клетки. */
export const MAX_BREACH_COST = 60;

// ─────────────────────────────────────────────────────────────────────────
// Прочее
// ─────────────────────────────────────────────────────────────────────────

/** Сколько тиков живёт запись о выстреле. Нужна только рендеру для трассера. */
export const SHOT_LIFETIME_TICKS = 4;

/** Как часто противник под управлением компьютера принимает решения. */
export const AI_DECISION_INTERVAL_TICKS = 15;
