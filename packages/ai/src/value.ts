import {
  BUILDABLE_KINDS,
  STRUCTURE_UPGRADE_TARGET,
  StructureKind,
  UNIT_TYPES,
  UNIT_UPGRADE_TARGET,
  UPGRADE_BRANCHES,
  UpgradeStat,
  UpgradeTarget,
  distanceSquared,
  effectModelOf,
  stepPpm,
} from '@td/shared';
import type { PlayerId, UnitType, UpgradeBranch, Vec2 } from '@td/shared';
import { cellAt, cellCentre, incomeWithEffect } from '@td/sim';
import type { PlayerStats, WorldState } from '@td/sim';
import { ENERGY_PER_LIVE_DAMAGE, generalDeathCost } from './posture.js';
import { horizonTicks } from './profile.js';
import type { AiProfile, PhaseProfile, Spending } from './profile.js';

/**
 * Во что покупка превращается — в энергии.
 *
 * Зачем это понадобилось. Порядок трат фазы строгий: первое, что удалось
 * купить, останавливает перебор. Пока в начале списка стояла дорогая
 * экономика, до остального очередь доходила — экономику часто не удавалось
 * купить. Стоило прокачке начать выбирать цель жеребьёвкой, как в начале
 * списка почти всегда оказывалась дешёвая доступная ветка, и постройки
 * исчезли из матча совсем: за семь минут ни одной.
 *
 * Лечится это не перестановкой пунктов и не ещё одним порогом, а тем же
 * приёмом, каким `posture.ts` выбирает рубеж: покупки сравниваются
 * по прибавке, выраженной в энергии. Единица общая, значит сравнение
 * законно, и подбирать в нём нечего.
 *
 * ## Что здесь считается и чего здесь НЕ считается
 *
 * Прибавка — это урон, который покупка добавит за горизонт планирования,
 * переведённый в энергию курсом из `posture.ts`. Горизонт берётся оттуда же:
 * заводить второй было бы двумя источниками истины об одном.
 *
 * Прикидка намеренно грубая в одном месте: прибавка к прочности
 * и к дальности считается наравне с прибавкой к урону. Строго это неверно —
 * прочность продлевает жизнь, а не усиливает выстрел, — но обе ветки
 * стоят одинаково и растут одинаково, поэтому ошибка одинакова у всех
 * и порядок сравнения не искажает. Точный расчёт потребовал бы модели
 * боя, а она есть только у самого боя.
 *
 * ## Экономика считается той же меркой, и довод против этого был неверен
 *
 * Здесь долго стояло объяснение, почему экономика в сравнении
 * не участвует: «её прибавка выражается в будущем доходе, а не в уроне,
 * и привести их к одной величине без горизонта всего матча нельзя».
 *
 * Довод опровергается десятью строками ниже. `damageValue` уже
 * умножает урон в тик на ГОРИЗОНТ ПЛАНИРОВАНИЯ, то есть боевая прибавка
 * и без того проинтегрирована по времени и выражена в энергии. Горизонт
 * всего матча не нужен вовсе: прибавка экономики за тот же горизонт —
 * это прирост дохода за тик, умноженный на него же, и она в энергии
 * по построению, без всякого переводного курса.
 *
 * Подобранного веса здесь поэтому нет, и нового числа тоже: обе величины
 * отвечают на один вопрос — сколько энергии покупка принесёт за то время,
 * на которое противник планирует.
 *
 * Цена прежнего умолчания была не в том, что экономику покупали реже.
 * Её прибавку было НЕ С ЧЕМ сравнить: в фазе, качающей одну экономику,
 * оценка прокачки отсутствовала вовсе, становилась непревосходимым
 * порогом накопления и запирала все прочие траты до конца терпения.
 */

/** Урон в тик, переведённый в энергию за горизонт планирования. */
const damageValue = (damagePerTick: number, profile: AiProfile): number =>
  damagePerTick * horizonTicks(profile) * ENERGY_PER_LIVE_DAMAGE;

/** Урон в тик одного юнита данного типа с учётом прокачки владельца. */
const unitDamagePerTick = (stats: PlayerStats, type: UnitType): number => {
  const baseline = stats.units[type];
  return baseline.attack / Math.max(1, baseline.cooldownTicks);
};

/**
 * Прибавка от одного нового юнита, усреднённая по составу фазы.
 *
 * Усреднение по составу, а не по конкретному выпавшему типу, — намеренно:
 * тип определяется жеребьёвкой внутри попытки, а порядок трат решается
 * до неё. Спрашивать жеребьёвку дважды нельзя, иначе матч перестанет
 * воспроизводиться по seed.
 *
 * Величина не зависит от размера войска — в этом вся суть сравнения:
 * машина приносит свою полную стоимость независимо от того, что уже куплено.
 */
export const unitGain = (stats: PlayerStats, phase: PhaseProfile, profile: AiProfile): number => {
  const total = UNIT_TYPES.reduce<number>((sum, type) => sum + phase.mix[type], 0);
  if (total <= 0) return 0;

  const damage = UNIT_TYPES.reduce<number>(
    (sum, type) => sum + unitDamagePerTick(stats, type) * phase.mix[type],
    0,
  );

  return damageValue(damage / total, profile);
};

/** Средняя цена юнита по составу фазы. Знаменатель прибавки на энергию. */
export const unitPrice = (stats: PlayerStats, phase: PhaseProfile): number => {
  const total = UNIT_TYPES.reduce<number>((sum, type) => sum + phase.mix[type], 0);
  if (total <= 0) return 0;

  return (
    UNIT_TYPES.reduce<number>((sum, type) => sum + stats.units[type].cost * phase.mix[type], 0) /
    total
  );
};

/** Сколько урона в тик игрок уже имеет по этой цели прокачки. */
const ownedDamagePerTick = (
  world: WorldState,
  me: PlayerId,
  stats: PlayerStats,
  target: UpgradeTarget,
): number => {
  // Соответствие «тип — цель прокачки» уже есть в балансе, и заводить
  // здесь второй такой словарь значило бы завести второй источник истины.
  const unitType = UNIT_TYPES.find((type) => UNIT_UPGRADE_TARGET[type] === target);
  if (unitType !== undefined) {
    return world.units.reduce(
      (sum, unit) =>
        unit.owner === me && unit.unitType === unitType
          ? sum + unitDamagePerTick(stats, unitType)
          : sum,
      0,
    );
  }

  const structureKind = BUILDABLE_KINDS.find((kind) => STRUCTURE_UPGRADE_TARGET[kind] === target);
  if (structureKind !== undefined) {
    return world.structures.reduce((sum, structure) => {
      if (structure.owner !== me || structure.kind !== structureKind) return sum;
      // Недостроенная башня ещё не стреляет, значит и умножать в ней нечего.
      if (world.tick < structure.builtAtTick) return sum;

      const baseline = stats.structures[structure.kind];
      if (baseline.attack <= 0) return sum;

      return sum + baseline.attack / Math.max(1, baseline.cooldownTicks);
    }, 0);
  }

  if (target === UpgradeTarget.General) {
    const general = world.generals[me];
    if (general === undefined || !general.alive) return 0;

    return stats.general.attack / Math.max(1, stats.general.cooldownTicks);
  }

  // Стена не стреляет, экономика к урону не приводится. Обе не участвуют.
  return 0;
};

/**
 * Характеристики, описывающие ракету, а не строение базы.
 *
 * Живут здесь, а не в `opponent.ts`, потому что потребителей двое —
 * оценка выгоды и выбор ветки при покупке, — и список обязан быть один:
 * ветка, забытая в одном из двух, поведёт себя по-разному в оценке
 * и в покупке, а заметить это можно только по расхождению цифр.
 */
export const NUCLEAR_STATS: readonly UpgradeStat[] = [
  UpgradeStat.NukeDamage,
  UpgradeStat.NukeRadius,
  UpgradeStat.NukeCooldown,
];

/**
 * Прибавка к доходу от следующего уровня добычи, в энергии за горизонт.
 *
 * Множитель следующего уровня получается тем же `stepPpm` с моделью
 * ветки, каким его наращивает сама покупка в ядре, а доход из множителя —
 * той же `incomeWithEffect`, какой его считают характеристики игрока.
 * Двух формул дохода быть не должно: они разойдутся на первой же правке
 * модели роста.
 *
 * Целочисленность здесь не помеха, а свойство: прирост дохода округляется
 * вниз ровно так же, как он округлится в мире, поэтому уровень, который
 * НИЧЕГО не прибавит, оценивается нулём — и правильно делает.
 */
const incomeGain = (
  world: WorldState,
  me: PlayerId,
  stats: PlayerStats,
  branch: UpgradeBranch,
  index: number,
  profile: AiProfile,
): number => {
  const current = world.players[me]?.upgrades[index];
  if (current === undefined) return 0;

  const next = stepPpm(current.effectPpm, branch.effectPercent, effectModelOf(branch));
  const delta = incomeWithEffect(next) - stats.incomePerTick;
  if (delta <= 0) return 0;

  return delta * horizonTicks(profile);
};

/**
 * Прибавка от самого выгодного улучшения, доступного фазе, и его цена.
 *
 * Прокачка **умножает то, что уже есть**, и в этом всё дело. Улучшение
 * атаки штурмовика на десять процентов стоит ровно столько, сколько стоят
 * эти проценты от имеющегося войска: при пяти машинах умножать почти
 * нечего, при полусотне — есть что. Ровно поэтому «прокачка вперёд всего»
 * даёт осечку в начале матча.
 *
 * Экономика подчиняется тому же правилу, только умножает она не войско,
 * а оставшееся время: чем раньше куплен уровень, тем дольше он работает.
 * Выражается это само собой — горизонтом планирования в обеих формулах.
 */
export const upgradeGain = (
  world: WorldState,
  me: PlayerId,
  stats: PlayerStats,
  phase: PhaseProfile,
  profile: AiProfile,
  costs: readonly number[],
): { readonly gain: number; readonly price: number } => {
  let best = { gain: 0, price: 0 };
  let bestEfficiency = -1;

  UPGRADE_BRANCHES.forEach((branch, index) => {
    if ((phase.upgrades[branch.target] ?? 0) <= 0) return;
    if (branch.stat === UpgradeStat.BuildRadius) return;
    if (branch.stat === UpgradeStat.RespawnTime) return;
    // Ядерные ветки сидят на цели «база» рядом с добычей, но к строению
    // экономики отношения не имеют: их прибавка не выражается ни доходом,
    // ни уроном в тик. Вне сравнения, как и прежде.
    if (NUCLEAR_STATS.includes(branch.stat)) return;

    const price = costs[index] ?? 0;
    if (price <= 0) return;

    const gain =
      branch.stat === UpgradeStat.Income
        ? incomeGain(world, me, stats, branch, index, profile)
        : // Отрицательный процент — это уменьшение перезарядки, то есть тоже
          // прибавка к урону. Знак поэтому снимается.
          damageValue(
            (ownedDamagePerTick(world, me, stats, branch.target) * Math.abs(branch.effectPercent)) /
              100,
            profile,
          );

    const efficiency = gain / price;
    if (efficiency <= bestEfficiency) return;

    bestEfficiency = efficiency;
    best = { gain, price };
  });

  return best;
};

export interface NukeOutcome {
  /** Стоимость уничтоженного у противника, в энергии. */
  readonly gain: number;
  /** Стоимость уничтоженного у себя, в энергии. */
  readonly loss: number;
}

/**
 * Во что обойдётся и что принесёт удар в этой точке.
 *
 * Взрыв не различает стороны: свои юниты, свои постройки и свой генерал
 * гибнут наравне с чужими. Прежняя оценка считала одни только чужие
 * головы и потому регулярно приводила к ударам по собственному генералу:
 * из ста пятидесяти восьми ударов сорок пять убили его.
 *
 * Считается СНЯТАЯ ПРОЧНОСТЬ, а не гибель. Взрыв перестал стирать всё
 * в круге и стал вычитать урон, поэтому «в радиусе — значит погиб»
 * означало бы систематическую переоценку: башня, Тесла и генерал удар
 * переживают, а стена его почти не замечает. Порог выгоды равен цене
 * удара, и завышенная оценка перешагивала бы его там, где размена нет —
 * то есть бить впустую за полторы тысячи энергии.
 *
 * Доля цели в зачёте — `min(здоровье, урон) / максимум`. Там, где урона
 * хватает на гибель, правило сводится к прежнему: цель идёт целиком
 * по остаточной стоимости.
 *
 * Радиус и мощность берутся у того, кто бьёт: обе величины прокачиваются.
 *
 * Генерал считается той же ценой гибели, какой её меряет `posture.ts`.
 * Двух цен гибели быть не должно — они немедленно разойдутся.
 */
export const nukeOutcome = (
  world: WorldState,
  me: PlayerId,
  centre: Vec2,
  myStats: PlayerStats,
  enemyStats: PlayerStats,
  homeCells: (cell: number) => number,
  /**
   * Считать ли стреляющие постройки по нанесённому ими урону.
   *
   * За выключателем, потому что оценка удара общая для всех профилей:
   * включи её всем — и профиль по умолчанию начнёт бить иначе, то есть
   * изменится поведение, которое стережёт эталон.
   */
  countDefence = false,
  /** Горизонт планирования в тиках. Нужен только при `countDefence`. */
  horizon = 0,
): NukeOutcome => {
  const reach = myStats.nuke.radius * myStats.nuke.radius;
  const damage = myStats.nuke.damage;

  /**
   * Какая доля цели достанется взрыву.
   *
   * Не «жива или мертва», а сколько прочности снято: цель, пережившая
   * удар с четвертью здоровья, принесла три четверти своей цены —
   * добить её теперь дёшево.
   */
  const share = (health: number, maxHealth: number): number =>
    Math.min(health, damage) / Math.max(1, maxHealth);

  let gain = 0;
  let loss = 0;

  for (const unit of world.units) {
    if (distanceSquared(unit.position, centre) > reach) continue;

    const mine = unit.owner === me;
    const stats = mine ? myStats : enemyStats;
    const baseline = stats.units[unit.unitType];
    const worth = baseline.cost * share(unit.health, baseline.health);

    if (mine) loss += worth;
    else gain += worth;
  }

  for (const structure of world.structures) {
    // База неуязвима для удара: её прикрывает запретная зона наведения.
    if (structure.kind === StructureKind.Base) continue;
    if (distanceSquared(cellCentre(structure.cell), centre) > reach) continue;

    const mine = structure.owner === me;
    const baseline = (mine ? myStats : enemyStats).structures[structure.kind];

    // Стреляющая постройка стоит большего из двух: цены, за которую
    // куплена, и урона, который успеет нанести за горизонт.
    //
    // Иначе скопление башен для удара невидимо. Семь базовых стоят 420
    // при цене удара в 1250 — размен не сходится никогда, хотя именно
    // это скопление и запирает дорогу. Те же семь за минуту наносят
    // в несколько раз больше энергии урона, чем стоили сами.
    //
    // Цена не отбрасывается: только что поставленная башня, не сделавшая
    // ни выстрела, иначе оказалась бы бесплатной мишенью. Правило
    // одинаково для обеих сторон — взрыв не различает, чьё жжёт.
    const dealt =
      countDefence && baseline.attack > 0 && baseline.range > 0
        ? (baseline.attack / Math.max(1, baseline.cooldownTicks)) * horizon * ENERGY_PER_LIVE_DAMAGE
        : 0;
    // Доля та же, что и у живых: стена в тысячу прочности от одного
    // заряда теряет седьмую часть себя, и оценка обязана это видеть.
    // Без доли линия стен читалась бы как готовый размен, хотя взрыв
    // её едва царапает.
    const worth = Math.max(baseline.cost, dealt) * share(structure.health, baseline.health);

    if (mine) loss += worth;
    else gain += worth;
  }

  for (const general of world.generals) {
    if (!general.alive) continue;
    if (distanceSquared(general.position, centre) > reach) continue;

    const mine = general.owner === me;
    const stats = mine ? myStats : enemyStats;
    const worth =
      generalDeathCost(stats, homeCells(cellAt(general.position))) *
      share(general.health, stats.general.health);

    if (mine) loss += worth;
    else gain += worth;
  }

  return { gain, loss };
};

/**
 * Есть ли в фазе хоть одна цель прокачки, чью прибавку можно оценить.
 *
 * Прежде проверка исключала экономику, и именно этим запирала траты:
 * фаза, качающая одну экономику, объявлялась несравнимой, её прибавка
 * становилась непревосходимым порогом накопления, и до постройки
 * с машиной очередь не доходила вовсе.
 *
 * Теперь оценить можно любую цель, поэтому вопрос остался ровно один:
 * названа ли хоть одна. Проверка нужна и в таком виде — `upgradeGain`
 * при пустом наборе вернул бы нулевую цену, а на неё делят.
 */
export const hasComparableUpgrade = (phase: PhaseProfile): boolean =>
  Object.values(phase.upgrades).some((weight) => (weight ?? 0) > 0);

/**
 * Прибавка на энергию, уценённая ожиданием.
 *
 * Без уценки сравнение выгоды даёт ровно ту беду, от которой уходило:
 * самая ценная покупка встаёт в очереди первой, оказывается не по карману,
 * отвечает «коплю» — и обрывает перебор. В замере это выглядело так:
 * в 276 решениях из 360 не покупалось НИЧЕГО.
 *
 * Уценка выражает простую мысль: покупка, до которой копить полгоризонта,
 * успеет отработать лишь половину его. Ждать дольше горизонта бессмысленно
 * вовсе — такая покупка получает ноль и в сравнении проигрывает всему.
 *
 * Новых чисел не заводится: горизонт и доход уже есть.
 */
export const discountedEfficiency = (
  gain: number,
  price: number,
  energy: number,
  incomePerTick: number,
  profile: AiProfile,
): number => {
  if (price <= 0) return 0;

  const horizon = horizonTicks(profile);
  const waitTicks = incomePerTick <= 0 ? horizon : Math.max(0, price - energy) / incomePerTick;
  const usable = Math.max(0, horizon - waitTicks) / horizon;

  return (gain / price) * usable;
};

/**
 * Порядок трат, в котором бесполезная сейчас покупка уступает очередь.
 *
 * Правило намеренно слабее, чем «покупка с большей прибавкой идёт первой»,
 * и вот почему. Полное пересортирование по прибавке было опробовано
 * и отвергнуто замером: башня в нынешних формулах оценивается заведомо
 * ниже прокачки, потому что её выгода умножается на долю покрытия ДВАЖДЫ —
 * и на долю накрытого пути, и на плотность потока по нему. При таком
 * сравнении прокачка выигрывает всегда, и противник за семь минут не ставил
 * ни одной постройки. Это вывод не о покупках, а о мерке, и чинить его
 * надо в `posture.ts`, а не подкручиванием весов здесь.
 *
 * Поэтому переставляется только очевидное: трата, прибавка которой равна
 * нулю, уходит в конец. Ровно она и была бедой — «прокачка вперёд всего»
 * на первой минуте умножает пустое войско, то есть покупает ноль
 * и при этом занимает всю очередь.
 *
 * Порядок остальных сохраняется: он — предпочтение профиля, и решать
 * за профиль там, где сравнение ненадёжно, мы не будем.
 *
 * Пункты без прибавки вовсе (прокачка в фазе, где интересна одна
 * экономика) не двигаются: их не с чем сравнивать.
 */
export const orderBySpendGain = (
  order: readonly Spending[],
  efficiency: Readonly<Partial<Record<Spending, number>>>,
  /**
   * У игрока нет ни одной башни.
   *
   * Единственное место, где порядок фазы отменяется целиком, и порог здесь
   * честный — ноль. Игрок в игре про оборону башнями, не имеющий ни одной
   * башни, ошибается независимо от того, что считает мерка выгоды; а мерка
   * эта, как показал замер, башню и вовсе недооценивает. Пока беда мерки
   * не исправлена в `posture.ts`, правило держит противника в игре.
   */
  undefended = false,
): readonly Spending[] => {
  const useless = (spending: Spending): boolean => efficiency[spending] === 0;

  const ranked = order.some(useless)
    ? [...order.filter((spending) => !useless(spending)), ...order.filter(useless)]
    : order;

  if (!undefended) return ranked;

  return ['build', ...ranked.filter((spending) => spending !== 'build')];
};
