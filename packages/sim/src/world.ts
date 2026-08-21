import {
  AttackStance,
  GENERAL_STATS,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  PLAYERS_PER_MATCH,
  PPM_ONE,
  STARTING_ENERGY,
  STRUCTURE_STATS,
  StructureKind,
  UPGRADE_BRANCHES,
  UPGRADE_TARGET_COUNT,
  asEntityId,
  asPlayerId,
  asTickNumber,
  directionTowards,
} from '@td/shared';
import type {
  CommandKind,
  EntityId,
  PlayerId,
  RejectReason,
  TickNumber,
  UnitType,
  Vec2,
} from '@td/shared';
import { createRng } from './prng.js';
import type { RngState } from './prng.js';
import { cellCentre, cellIndex, cellX, cellY, generateMap, isInsideMap } from './map.js';
import type { GameMap } from './map.js';

/**
 * Уровень одной ветки прокачки.
 *
 * Множитель и цена следующего уровня хранятся здесь, а не вычисляются
 * из уровня при каждом обращении. Причина в производительности: уровней
 * может быть сколько угодно, а характеристики запрашиваются каждый тик
 * для каждой сущности. Пересчёт «с нуля» стоил бы цикла длиной в число
 * купленных уровней на каждое обращение; наращивание по одному шагу
 * за покупку стоит одного умножения на всю покупку.
 */
export interface UpgradeState {
  readonly level: number;
  /** Множитель эффекта в миллионных долях. */
  readonly effectPpm: number;
  /** Множитель цены следующего уровня в миллионных долях. */
  readonly costPpm: number;
}

export interface PlayerState {
  readonly id: PlayerId;
  /** Энергия во внутренних единицах. См. ENERGY_SCALE в balance.ts. */
  readonly energy: number;
  /** Уровни прокачки, индексируются индексом ветки в UPGRADE_BRANCHES. */
  readonly upgrades: readonly UpgradeState[];
  /**
   * Множители цены покупки, индексируются целью прокачки.
   * Каждое купленное улучшение типа поднимает его цену на два процента.
   */
  readonly purchasePpm: readonly number[];
  /** Постройка, назначенная общей целью для всех юнитов игрока. */
  readonly targetStructure: EntityId;
  /**
   * Режим атаки всего войска.
   *
   * Свойство игрока, а не отдельного юнита: приказ отдаётся войску
   * целиком, как и выбор цели. Управление ротами — совсем другая игра.
   */
  readonly stance: AttackStance;
  /**
   * Очередь производства. Энергия за эти заказы уже списана.
   *
   * Отката у производства нет, поэтому в обычном тике очередь пуста:
   * заказанное выходит на карту немедленно. Непустой она остаётся
   * только тогда, когда достигнут потолок численности или вокруг базы
   * нет свободной клетки.
   */
  readonly queue: readonly UnitType[];
}

export interface StructureState {
  readonly id: EntityId;
  readonly owner: PlayerId;
  readonly kind: StructureKind;
  /** Индекс клетки центра постройки. */
  readonly cell: number;
  readonly health: number;
  /**
   * Индивидуальный множитель силы, накопленный убийствами.
   *
   * Это не прокачка: прокачка действует на все постройки вида и покупается
   * за энергию, а это — заслуга конкретной башни, и вместе с ней она
   * и погибает.
   */
  readonly growthPpm: number;
  /** Тик, когда постройка сможет выстрелить снова. */
  readonly readyAtTick: TickNumber;
  /** Тик завершения возведения. До него постройка не стреляет. */
  readonly builtAtTick: TickNumber;
  /**
   * Тик исчезновения при сносе. Ноль означает, что снос не начат.
   *
   * Снос — обратное возведение той же длительности: здоровье убывает,
   * клетка остаётся непроходимой, в конце постройка исчезает. Мгновенный
   * снос превратил бы стену из обязательства в бесплатный переключатель:
   * перекрыл проход, дождался волны, перед своей атакой открыл.
   *
   * Величина живёт в состоянии мира, а не в клиенте, потому что снос —
   * обычная команда: он воспроизводится реплеем, переезжает в снимке
   * при рассинхроне и откатывается вместе с предсказанием.
   */
  readonly demolishAtTick: TickNumber;
}

export interface UnitState {
  readonly id: EntityId;
  readonly owner: PlayerId;
  readonly unitType: UnitType;
  readonly position: Vec2;
  readonly health: number;
  /**
   * Румб, в который повёрнута машина: индекс из тех же восьми направлений,
   * что и у генерала.
   *
   * Величина производная и нужна одному лишь рендеру — но храниться она
   * обязана здесь, а не на клиенте. Клиент предсказывает симуляцию вперёд
   * и откатывается при расхождении с сервером; направление, выведенное
   * из разницы положений между кадрами, при откате теряется, и войско
   * разворачивается куда попало ровно в тот момент, когда игрок смотрит
   * на бой. Прецедент рядом: ShotState живёт здесь же и тоже нужен
   * исключительно рендеру.
   *
   * В отличие от направления генерала, ноль здесь невозможен: у генерала
   * ноль означает «стоять», а машина всегда куда-то повёрнута.
   *
   * На правила боя не влияет: точность от направления не зависит, разворот
   * не занимает времени, стрелять назад можно. Разворот с задержкой — это
   * игровая механика, а не облик, и вводить её под видом правки картинки
   * нельзя.
   */
  readonly facing: number;
  readonly readyAtTick: TickNumber;
}

export interface GeneralState {
  readonly owner: PlayerId;
  readonly position: Vec2;
  readonly health: number;
  /** Индекс направления движения, ноль — стоит. */
  readonly direction: number;
  /**
   * Румб, в который развёрнута машина.
   *
   * Отдельно от `direction` потому, что `direction` обнуляется, едва игрок
   * отпустил клавиши, а машина от этого не разворачивается носом в никуда:
   * остановившийся истребитель продолжает смотреть туда, куда летел.
   */
  readonly facing: number;
  readonly readyAtTick: TickNumber;
  readonly alive: boolean;
  /** Тик возвращения в игру. Осмысленно только когда генерал мёртв. */
  readonly respawnAtTick: TickNumber;
}

export interface NukeState {
  readonly id: EntityId;
  readonly owner: PlayerId;
  readonly cell: number;
  readonly detonateAtTick: TickNumber;
}

/**
 * След выстрела.
 *
 * Попадание мгновенное, снаряда в полёте не существует. Эта запись живёт
 * несколько тиков и нужна исключительно рендеру: без неё стрельба была бы
 * не видна вовсе — здоровье просто убывало бы.
 */
export interface ShotState {
  readonly owner: PlayerId;
  readonly from: Vec2;
  readonly to: Vec2;
  readonly expiresAtTick: TickNumber;
  /** Убил ли этот выстрел цель. Рендер показывает добивание ярче. */
  readonly lethal: boolean;
}

/**
 * Отклонённая команда.
 *
 * Живёт в состоянии мира по образцу `ShotState`: величина производна
 * от входов, нужна потребителю снаружи ядра и в контрольную сумму
 * не входит. Возвращать её парой из `step` было нельзя — это сломало бы
 * форму «состояние тика есть ровно один объект», на которую опирается
 * откат предсказания; передавать колбэком тоже, потому что при пересчёте
 * тика после отката колбэк выстрелил бы повторно.
 *
 * В отличие от следа выстрела запись живёт **один** тик, а не несколько.
 * Выстрел надо успеть нарисовать, а рендер идёт с частотой монитора
 * и с тиком не совпадает. У отказа потребитель другой — обработчик,
 * вызываемый на каждом тике без пропусков, — и растягивать жизнь записи
 * значило бы показывать один отказ несколько раз.
 *
 * Номер тика внутри не хранится: запись лежит в состоянии конкретного
 * тика, и тик известен из него самого.
 */
export interface Rejection {
  readonly player: PlayerId;
  readonly kind: CommandKind;
  readonly reason: RejectReason;
  /**
   * Номер отклонённой команды в списке, поданном на этот тик.
   *
   * Без него отказ нельзя связать с конкретной командой, когда их
   * в тике несколько одного вида. Случай не выдуманный: заказ пачки
   * юнитов — это десять отдельных команд, и «четыре прошли, шесть
   * отклонены» без номера превращается в «шесть отказов неизвестно
   * на что».
   */
  readonly index: number;
}

/**
 * Поле потока одного игрока: расстояние от каждой клетки до общей цели.
 *
 * Два поля, а не одно. `walk` идёт только по свободной земле, `breach`
 * дополнительно проходит сквозь разрушимые вражеские постройки, и вход
 * в такую клетку стоит тем дороже, чем она прочнее. Второе поле включается,
 * только когда первое не даёт до цели никакого пути.
 */
export interface NavField {
  readonly walk: Int32Array;
  readonly breach: Int32Array;
  /** Состояние мира, при котором поле посчитано. См. navRevision. */
  readonly revision: number;
  readonly computedAtTick: TickNumber;
}

/**
 * Полное состояние игрового мира на конкретном тике.
 *
 * Всё состояние собрано в одном объекте намеренно: так его можно целиком
 * сохранить для rollback, посчитать от него контрольную сумму и отправить
 * снимком при рассинхроне. Ничего "снаружи" симуляция не хранит.
 */
export interface WorldState {
  readonly tick: TickNumber;
  readonly rng: RngState;
  /**
   * Карта мира. Восстанавливается из seed на обеих сторонах и по сети
   * не передаётся: четыре байта seed вместо девяти тысяч клеток.
   */
  readonly map: GameMap;
  readonly players: readonly PlayerState[];
  readonly structures: readonly StructureState[];
  readonly units: readonly UnitState[];
  readonly generals: readonly GeneralState[];
  readonly nukes: readonly NukeState[];
  readonly shots: readonly ShotState[];
  /**
   * Команды, отклонённые на этом тике. Живут один тик, в сумму не входят.
   * Пусты в подавляющем большинстве тиков — отказ это исключение.
   */
  readonly rejections: readonly Rejection[];
  /**
   * Поля потока по игрокам. Данные производные, но кешируются между тиками:
   * пересчитывать их каждый тик слишком дорого, а внешний кеш сломал бы
   * чистоту шага симуляции.
   */
  readonly nav: readonly NavField[];
  /**
   * Растёт при любом изменении набора построек или цели.
   * По нему поле потока понимает, что устарело.
   */
  readonly navRevision: number;
  /** Счётчик для выдачи идентификаторов новым сущностям. */
  readonly nextEntityId: number;
  /** Победитель матча. Пока матч идёт — null. */
  readonly winner: PlayerId | null;
}

/** Идентификатор, которого заведомо не существует. Означает «цели нет». */
export const NO_ENTITY = asEntityId(0);

const freshUpgrades = (): readonly UpgradeState[] =>
  UPGRADE_BRANCHES.map(() => ({
    level: 0,
    effectPpm: PPM_ONE,
    costPpm: PPM_ONE,
  }));

const MAP_CENTRE_X = MAP_WIDTH_CELLS / 2;
const MAP_CENTRE_Y = MAP_HEIGHT_CELLS / 2;

/**
 * Отступ точки появления генерала от центра базы.
 *
 * Двойка, а не единица: основание базы занимает клетки в радиусе одной,
 * и генерал оказался бы внутри неё.
 */
const GENERAL_SPAWN_OFFSET_CELLS = 2;

/**
 * Клетка, где появляется генерал: на две клетки от базы в сторону центра
 * карты. Внутрь основания базы его ставить нельзя — она непроходима,
 * а генерал должен иметь возможность сойти с места.
 *
 * Направление «к центру» выбрано не для красоты: база стоит в углу, и три
 * из четырёх сторон вокруг неё упираются в край карты.
 */
export const generalSpawnCell = (baseCell: number): number => {
  const bx = cellX(baseCell);
  const by = cellY(baseCell);

  const x = bx + Math.sign(MAP_CENTRE_X - bx) * GENERAL_SPAWN_OFFSET_CELLS;
  const y = by + Math.sign(MAP_CENTRE_Y - by) * GENERAL_SPAWN_OFFSET_CELLS;

  return isInsideMap(x, y) ? cellIndex(x, y) : baseCell;
};

export const createWorld = (seed: number): WorldState => {
  const map = generateMap(seed);

  const structures: StructureState[] = map.baseCells.map((cell, index) => ({
    id: asEntityId(index + 1),
    owner: asPlayerId(index),
    kind: StructureKind.Base,
    cell,
    health: STRUCTURE_STATS[StructureKind.Base].health,
    growthPpm: PPM_ONE,
    readyAtTick: asTickNumber(0),
    builtAtTick: asTickNumber(0),
    demolishAtTick: asTickNumber(0),
  }));

  const generals: GeneralState[] = map.baseCells.map((cell, index) => {
    const spawn = generalSpawnCell(cell);

    return {
      owner: asPlayerId(index),
      position: cellCentre(spawn),
      health: GENERAL_STATS.health,
      direction: 0,
      // На старте оба смотрят в центр карты — туда, откуда придёт война.
      // Ноль здесь недопустим: у машины он означал бы отсутствие разворота.
      facing: directionTowards(MAP_CENTRE_X - cellX(spawn), MAP_CENTRE_Y - cellY(spawn)),
      readyAtTick: asTickNumber(0),
      alive: true,
      respawnAtTick: asTickNumber(0),
    };
  });

  const players: PlayerState[] = Array.from({ length: PLAYERS_PER_MATCH }, (_unused, index) => ({
    id: asPlayerId(index),
    energy: STARTING_ENERGY,
    upgrades: freshUpgrades(),
    purchasePpm: Array.from({ length: UPGRADE_TARGET_COUNT }, () => PPM_ONE),
    // По умолчанию цель — база противника. Это единственная постройка,
    // которая заведомо существует с первого тика.
    targetStructure: structures[1 - index]?.id ?? NO_ENTITY,
    // Прорыв по умолчанию: до появления режимов войско останавливалось
    // на каждом встречном, и осадная волна вязла в первом же заслоне.
    stance: AttackStance.Breakthrough,
    queue: [],
  }));

  return {
    tick: asTickNumber(0),
    rng: createRng(seed),
    map,
    players,
    structures,
    units: [],
    generals,
    nukes: [],
    shots: [],
    rejections: [],
    // Поля потока считаются лениво на первом же тике: строить их здесь
    // значило бы дублировать логику пересчёта ради одного случая.
    nav: [],
    navRevision: 1,
    nextEntityId: structures.length + 1,
    winner: null,
  };
};
