import {
  FIXED_POINT_SCALE,
  STRUCTURE_STATS,
  StructureKind,
  UNIT_TYPES,
  UnitType,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { cellCentre } from '@td/sim';
import type { PlayerStats, WorldState } from '@td/sim';
import type { Approach } from './approach.js';
import { otherPlayer } from './approach.js';
import { incomingAt } from './posture.js';
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

