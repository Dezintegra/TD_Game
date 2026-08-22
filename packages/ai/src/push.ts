import {
  FIXED_POINT_SCALE,
  STRUCTURE_STATS,
  StructureKind,
  UNIT_TYPES,
  UnitType,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { cellAt, cellCentre } from '@td/sim';
import type { PlayerStats, WorldState } from '@td/sim';
import type { Approach } from './approach.js';
import { otherPlayer } from './approach.js';
import { ENERGY_PER_LIVE_DAMAGE, incomingAt } from './posture.js';
import { horizonTicks } from './profile.js';
import type { AiProfile } from './profile.js';

/**
 * Добивающий рывок: волна, отправленная тогда и только тогда, когда добьёт.
 *
 * Зачем это отдельно от обычного производства. Противник покупает
 * не чаще одной машины за решение, то есть двух в секунду; десять машин —
 * это пять секунд, за которые первая уходит за полкарты. Волны как таковой
 * не существует, есть ручеёк, и оборона перемалывает его по частям.
 *
 * Хуже того: каждая гибель добавляет башне пять процентов к атаке
 * и прочности сложным процентом. Подача войск по одному — это не просто
 * неэффективная атака, это бесплатная прокачка вражеской обороны
 * за свой счёт.
 *
 * ## Модель боя здесь линейная, и это сказано честно
 *
 * Расчёт не знает ни расстановки, ни очерёдности выстрелов. Он знает
 * три вещи: сколько здоровья у волны, сколько урона в тик по ней
 * достаётся вдоль дороги и сколько её убивает у базы. Ошибается модель
 * в понятную сторону — она не учитывает, что часть обороны отвлечётся
 * на генерала и что раненые продолжают стрелять. Обе поправки играют
 * ЗА рывок, значит ворота осторожнее правды, а осторожные ворота лучше
 * беспечных.
 */

/** Сколько урона в тик волна наносит ПОСТРОЙКАМ. */
const structureDamagePerTick = (stats: PlayerStats, type: UnitType, count: number): number => {
  const baseline = stats.units[type];

  return (
    (count * baseline.attack * baseline.structureDamagePercent) /
    100 /
    Math.max(1, baseline.cooldownTicks)
  );
};

/**
 * Урон в тик, который волна получает на дороге.
 *
 * Считается по нескольким точкам вероятного пути и НЕ умножается
 * на численность: башня стреляет по одному юниту за раз, и её урон
 * вычитается из общего здоровья волны, а не из каждой машины отдельно.
 * Это ровно то различие, из-за которого волна вдвое большая доходит,
 * а вдвое меньшая — нет.
 */
const roadDamagePerTick = (
  world: WorldState,
  me: PlayerId,
  enemyStats: PlayerStats,
  approach: Approach,
  probes: number,
): number => {
  if (probes <= 0 || approach.shortest <= 0) return 0;

  // Точки берутся по долям пути: сам путь уже посчитан, и обход карты
  // ради этого не нужен.
  const wanted = Array.from({ length: probes }, (_unused, index) =>
    Math.round((approach.shortest * (index + 1)) / probes),
  );

  const best = wanted.map(() => -1);

  for (let cell = 0; cell < approach.onPath.length; cell += 1) {
    if (approach.onPath[cell] !== 1) continue;

    const from = approach.fromHome[cell] ?? -1;
    if (from < 0) continue;

    wanted.forEach((target, index) => {
      if ((best[index] ?? -1) >= 0) return;
      if (Math.abs(from - target) > 1) return;

      best[index] = cell;
    });
  }

  let total = 0;
  let taken = 0;

  for (const cell of best) {
    if (cell < 0) continue;

    total += incomingAt(world, me, enemyStats, cellCentre(cell)).total;
    taken += 1;
  }

  return taken === 0 ? 0 : total / taken;
};

/** Урон в тик, которым оборона у чужой базы встречает дошедших. */
const defenceAtBase = (
  world: WorldState,
  me: PlayerId,
  enemyStats: PlayerStats,
): number => {
  const cell = world.map.baseCells[otherPlayer(me)];
  if (cell === undefined) return 0;

  return incomingAt(world, me, enemyStats, cellCentre(cell)).total;
};

/**
 * Прикрыт ли вероятный путь вражескими стреляющими постройками.
 *
 * Живёт здесь, а не в двух местах сразу: по этому же признаку рывок
 * выбирает состав волны, а производство — отвечать ли на потери осадным
 * оружием. Вопрос один, и ответ на него обязан быть один.
 */
export const pathGuarded = (
  world: WorldState,
  me: PlayerId,
  enemyStats: PlayerStats,
  approach: Approach,
): boolean => defenceOnPath(world, me, enemyStats, approach).hp > 0;

/** Что стоит на пути: сколько его сносить и сколько оно наносит. */
export interface Defence {
  /** Суммарное оставшееся здоровье стреляющих построек. */
  readonly hp: number;
  /** Их суммарный урон в тик. */
  readonly dps: number;
  /** Сумма цен: сколько за них заплачено. */
  readonly cost: number;
}

const NO_DEFENCE: Defence = { hp: 0, dps: 0, cost: 0 };

/**
 * Оборона противника на вероятном пути.
 *
 * Перебор тот же, каким прежде отвечали на вопрос «прикрыт ли путь», —
 * и это не совпадение, а требование: вопросов теперь два, но обстановка
 * у них одна, и считать её дважды разными способами значило бы завести
 * два расходящихся представления об одной дороге.
 */
export const defenceOnPath = (
  world: WorldState,
  me: PlayerId,
  enemyStats: PlayerStats,
  approach: Approach,
): Defence => {
  let hp = 0;
  let dps = 0;
  let cost = 0;

  for (const structure of world.structures) {
    if (structure.owner === me || structure.kind === StructureKind.Base) continue;

    const baseline = enemyStats.structures[structure.kind];
    if (baseline.attack <= 0 || baseline.range <= 0) continue;

    const onPath =
      approach.onPath[structure.cell] === 1 || approach.fromHome[structure.cell] !== undefined;
    if (!onPath) continue;

    hp += structure.health;
    dps += baseline.attack / Math.max(1, baseline.cooldownTicks);
    cost += baseline.cost;
  }

  return hp > 0 ? { hp, dps, cost } : NO_DEFENCE;
};

/**
 * Во что оборона обходится нападающему, в энергии.
 *
 * Не цена покупки, а нанесённый урон: башня стоит на пути не ради своей
 * цены и не обязана сносить базу — её работа в том, чтобы чужие машины
 * не доходили. Скопление из семи базовых башен стоило противнику 420
 * энергии при цене ядерного удара в 1250, и по цене покупки такой удар
 * не окупался никогда; за минуту те же башни наносят в несколько раз
 * больше энергии урона, чем стоили сами.
 *
 * Берётся БОЛЬШЕЕ из двух. Цена покупки не отбрасывается: только что
 * поставленная башня, не сделавшая ни выстрела, иначе оказалась бы
 * бесплатной мишенью.
 *
 * Курс перевода урона в энергию не новый: им уже меряются и рубеж,
 * и польза собственной башни. Второго курса быть не должно.
 */
export const defenceWorth = (defence: Defence, profile: AiProfile): number =>
  Math.max(defence.cost, defence.dps * horizonTicks(profile) * ENERGY_PER_LIVE_DAMAGE);

/**
 * Пора ли выпускать прикрытие осадной волне.
 *
 * Осадная машина втрое медленнее дешёвой: путь, который штурмовик
 * проходит за двадцать пять секунд, Тесла ползёт восемьдесят три.
 * Выпусти прикрытие вместе с волной — оно придёт задолго до неё, погибнет
 * в одиночку и никого не прикроет. Поэтому части разводятся во времени.
 *
 * Условие выводится из мира и читается так: машина прикрытия,
 * отправленная СЕЙЧАС от своей базы, дойдёт не раньше осадных.
 *
 *     остаток пути осадных / скорость осадных ≤ весь путь / скорость прикрытия
 *
 * Поля состояния «идёт волна» рядом не заводится намеренно. Признак,
 * выведенный из мира, перестаёт выполняться сам, когда осадные машины
 * гибнут по дороге; поле в памяти рассказывало бы о волне, которой
 * уже нет.
 */
export const screenDue = (
  world: WorldState,
  me: PlayerId,
  myStats: PlayerStats,
  approach: Approach,
  screen: UnitType,
): boolean => {
  if (approach.shortest <= 0) return false;

  const screenSpeed = myStats.units[screen].speed;
  if (screenSpeed <= 0) return false;

  // Весь путь для машины прикрытия, в тиках.
  const screenTicks = (approach.shortest * FIXED_POINT_SCALE) / screenSpeed;
  const towerRange = STRUCTURE_STATS[StructureKind.TowerBasic].range;

  for (const unit of world.units) {
    if (unit.owner !== me) continue;

    const baseline = myStats.units[unit.unitType];
    // Осадная машина — та, что достаёт дальше башни. То же правило,
    // по которому выбирается состав волны.
    if (baseline.range <= towerRange || baseline.speed <= 0) continue;

    const travelled = approach.fromHome[cellAt(unit.position)] ?? -1;
    if (travelled < 0) continue;

    const left = Math.max(0, approach.shortest - travelled);
    const siegeTicks = (left * FIXED_POINT_SCALE) / baseline.speed;

    if (siegeTicks <= screenTicks) return true;
  }

  return false;
};

export interface WaveOutcome {
  /** Сколько здоровья волна снимет с базы противника. */
  readonly damage: number;
  /** Сколько машин доедет. Ноль означает, что волна погибнет по дороге. */
  readonly survivors: number;
}

/**
 * Что сделает волна из `count` машин типа `type`.
 *
 * Три шага, каждый в величинах, которые уже есть: что доедет, сколько
 * дошедшие проживут у базы и сколько за это время снимут.
 */
export const waveOutcome = (
  world: WorldState,
  me: PlayerId,
  myStats: PlayerStats,
  enemyStats: PlayerStats,
  approach: Approach,
  profile: AiProfile,
  type: UnitType,
  count: number,
): WaveOutcome => {
  if (count <= 0) return { damage: 0, survivors: 0 };

  const baseline = myStats.units[type];
  const health = baseline.health * count;

  const travelTicks = (approach.shortest * FIXED_POINT_SCALE) / Math.max(1, baseline.speed);
  const onRoad = roadDamagePerTick(
    world,
    me,
    enemyStats,
    approach,
    profile.posture.pathProbes,
  );

  const left = health - onRoad * travelTicks;
  if (left <= 0) return { damage: 0, survivors: 0 };

  const survivors = Math.floor(left / Math.max(1, baseline.health));
  if (survivors <= 0) return { damage: 0, survivors: 0 };

  // Сколько дошедшие проживут под огнём обороны. Без обороны время
  // упирается в горизонт планирования: бесконечности в расчёте быть
  // не должно, иначе ворота откроет одна-единственная машина.
  const defence = defenceAtBase(world, me, enemyStats);
  const horizon = horizonTicks(profile);
  const alive = defence <= 0 ? horizon : Math.min(horizon, left / defence);

  return { damage: structureDamagePerTick(myStats, type, survivors) * alive, survivors };
};

/**
 * Тип юнита для волны.
 *
 * Однородность волны — не прихоть. Тесла втрое медленнее
 * штурмовика, и смешанный состав растягивается по дороге: каждая часть
 * встречает оборону целиком, то есть гибнет по частям.
 *
 * Правило выбора выводится из чисел, а не из вкуса:
 *
 * - путь прикрыт стреляющими постройками — нужен тот, кто вскрывает
 *   башни: полный урон по постройкам и дальность больше башенной;
 * - путь чист — нужен самый дешёвый по цене за единицу урона
 *   по постройкам.
 *
 * Снайпер не проходит ни туда, ни сюда: он наносит постройкам десятую
 * часть урона при двойной цене.
 */
export const waveType = (myStats: PlayerStats, guarded: boolean): UnitType => {
  const towerRange = STRUCTURE_STATS[StructureKind.TowerBasic].range;

  const candidates = UNIT_TYPES.filter((type) => {
    const baseline = myStats.units[type];
    // Десятипроцентный урон по постройкам — это не «слабее», а «незачем».
    return baseline.structureDamagePercent >= 100;
  });

  if (guarded) {
    const siege = candidates.find((type) => myStats.units[type].range > towerRange);
    if (siege !== undefined) return siege;
  }

  let cheapest = candidates[0] ?? UnitType.Assault;
  let bestPrice = Number.POSITIVE_INFINITY;

  for (const type of candidates) {
    const baseline = myStats.units[type];
    const damage = structureDamagePerTick(myStats, type, 1);
    if (damage <= 0) continue;

    const price = baseline.cost / damage;
    if (price >= bestPrice) continue;

    bestPrice = price;
    cheapest = type;
  }

  return cheapest;
};

