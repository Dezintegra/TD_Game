import {
  AI_DECISION_INTERVAL_TICKS,
  BASE_BUILD_EXCLUSION,
  BUILDABLE_KINDS,
  CommandKind,
  DIRECTION_STOP,
  FIXED_POINT_SCALE,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  NUKE_BASE_EXCLUSION,
  NUKE_COST,
  NUKE_RADIUS,
  StructureKind,
  TICKS_PER_SECOND,
  UPGRADE_BRANCHES,
  UPGRADE_TARGETS,
  UnitType,
  UpgradeStat,
  UpgradeTarget,
  asTickNumber,
  cellsToUnits,
  directionTowards,
  distanceSquared,
} from '@td/shared';
import type { Command, PlayerId, Vec2 } from '@td/shared';
import {
  UNREACHABLE,
  bestStep,
  cellAt,
  cellCentre,
  cellIndex,
  cellX,
  cellY,
  createRng,
  nextRngInt,
  playerStats,
  upgradeCosts,
} from '@td/sim';
import type { Occupancy, PlayerState, PlayerStats, StructureState, WorldState } from '@td/sim';
import { approachOf, otherPlayer, walkField } from './approach.js';
import type { Approach } from './approach.js';
import {
  coveredCells,
  freshCoverage,
  pickVerdict,
  rangeInCells,
  rankFrontiers,
  situationOf,
} from './posture.js';
import type { Verdict } from './posture.js';
import { AttemptNote } from './observer.js';
import type { AttemptRecord, AttemptResult, DecisionObserver, DecisionRecord } from './observer.js';
import { BASELINE_PROFILE, escortRadius, patienceDecisions, phaseAt, reserveOf } from './profile.js';
import type { AiProfile, PhaseProfile, Spending } from './profile.js';
import {
  discountedEfficiency,
  hasComparableUpgrade,
  orderBySpendGain,
  unitGain,
  unitPrice,
  upgradeGain,
} from './value.js';

/**
 * Противник под управлением компьютера.
 *
 * Ключевое архитектурное решение: он живёт в клиенте, а не в ядре
 * симуляции, и влияет на мир исключительно командами — теми же самыми,
 * что отдаёт человек. Ядро не отличает его от живого игрока и применяет
 * к нему ровно те же проверки: радиус строительства, стоимость, запретную
 * зону ядерного удара, потолок численности.
 *
 * Почему не внутри `packages/sim`: противник — это игрок, а игроки
 * в нашей архитектуре находятся снаружи симуляции. Стоит пустить туда
 * стратегию, и граница между правилами игры и способом в неё играть
 * размоется, а следом в детерминированное ядро просочится эвристика.
 *
 * Решения принимаются раз в полсекунды, а не каждый тик. Это сознательное
 * ограничение: человек физически не может отдавать тридцать команд
 * в секунду, и противник, который может, выигрывает не умом, а частотой.
 *
 * Куда идти генералу, решает не этот файл, а `posture.ts`: там модели
 * поведения сравниваются по выгоде и риску. Здесь остаётся исполнение —
 * дорога до выбранного рубежа, стройка, производство и прокачка.
 */

export interface Opponent {
  /** Команды на этот тик. Пустой массив — противник сейчас думает. */
  decide(world: WorldState): readonly Command[];
}

// Все числа, задающие манеру игры, переехали в профиль поведения
// (`profile.ts`). Здесь остаётся то, как противник ими пользуется.

/**
 * Чем закончилась попытка потратить энергию.
 *
 * `wait` — самое важное здесь. Без него противник вечно тратил бы доход
 * на мелочи и никогда не накопил бы на крупное: при доходе в десять
 * в секунду и штурмовике за двадцать пять казна просто не успевает
 * подрасти между решениями. `wait` означает «хочу, но пока не по карману,
 * и мелочь покупать не буду».
 */
interface Attempt {
  readonly result: AttemptResult;
  /**
   * Почему не купил. Отсутствует только у состоявшейся покупки.
   *
   * Хранится не ради самого противника — ему довольно исхода, — а ради
   * разбора поведения: «не построил башню» может означать четыре
   * совершенно разные вещи, и снаружи они неразличимы.
   */
  readonly note?: AttemptNote;
  /** Цена желаемого. Без неё запись «коплю» не говорит, на что именно. */
  readonly price?: number;
}

const BOUGHT: Attempt = { result: 'bought' };
const passing = (note: AttemptNote): Attempt => ({ result: 'pass', note });

/** Поле расстояний до рубежа. Живёт между решениями, поэтому изменяемое. */
interface GoalField {
  cell: number;
  /** Ревизия набора построек, при которой поле посчитано. */
  revision: number;
  field: Int32Array;
}

export const createOpponent = (
  me: PlayerId,
  seed: number,
  // Профиль необязателен намеренно: существующие вызовы от этого
  // не меняются ни в клиенте, ни в тестах, и утверждение «поведение
  // не изменилось» становится тем убедительнее, чем меньше тронуто строк.
  profile: AiProfile = BASELINE_PROFILE,
  // Наблюдатель необязателен и по умолчанию отсутствует. Без него
  // не создаётся ни одного объекта записи: в матче человека это горячий
  // путь, а сведения там никому не нужны.
  observe?: DecisionObserver,
): Opponent => {
  // Случайность берётся из детерминированного генератора, а не из
  // Math.random. Формально это не требуется — противник живёт вне ядра, —
  // но благодаря этому матч с фиксированными seed воспроизводится целиком,
  // что бесценно при разборе «почему он вдруг так пошёл».
  let rng = createRng(seed);
  let nextDecisionTick = 0;
  let buildCounter = 0;
  let waitStreak = 0;

  let goalField: GoalField | undefined;

  const roll = (bound: number): number => {
    const [next, value] = nextRngInt(rng, bound);
    rng = next;
    return value;
  };

  /**
   * Поле расстояний до рубежа, пересчитываемое только по необходимости.
   *
   * Ключ кеша — пара «клетка рубежа, ревизия построек». Пока цель
   * не сменилась и на карте ничего не построили и не разрушили, поле
   * остаётся верным, а обход карты стоит дороже сравнения двух чисел.
   */
  const fieldTo = (occupancy: Occupancy, cell: number, revision: number): Int32Array => {
    if (goalField !== undefined && goalField.cell === cell && goalField.revision === revision) {
      return goalField.field;
    }

    const field = walkField(occupancy, [cell]);
    goalField = { cell, revision, field };

    return field;
  };

  return {
    decide(world) {
      if (world.winner !== null) return [];
      if (world.tick < nextDecisionTick) return [];

      nextDecisionTick = world.tick + AI_DECISION_INTERVAL_TICKS;

      const player = world.players[me];
      if (player === undefined) return [];

      // Вероятный путь считается раз в решение, то есть дважды в секунду.
      // Это два обхода карты в две с небольшим тысячи клеток — цена,
      // которую не видно даже на профиле, а зависят от него и выбор места
      // под башню, и цель движения генерала.
      const approach = approachOf(world, me);
      if (approach === undefined) return [];

      const phase = phaseAt(profile, world.tick);
      const stats = playerStats(player);
      const covered = coveredCells(world, me, stats);
      const situation = situationOf(world, me, approach, stats, covered, profile);

      // Оценки всех рубежей и выбор лучшего — два шага, а не один.
      // Разбору поведения нужны все оценки: если выбранный рубеж обошёл
      // соседний на два процента, это дрожь, а не решение. Считаются они
      // и так, поэтому наблюдение не стоит противнику ничего.
      const verdicts = situation === undefined ? [] : rankFrontiers(situation);
      const verdict = pickVerdict(verdicts);

      const commands: Command[] = [];

      // Выбор цели энергии не стоит и потому идёт всегда.
      pushTargeting(commands, world, me, player, approach);

      // Ядерный удар проверяется до остальных трат: он копится в запасе
      // фазы, и тратить этот запас на что-то другое было бы обидно.
      const struck = tryNuke(commands, world, me, player, profile);

      const attempts: AttemptRecord[] = [];
      const nearby = escortNearby(world, me, stats);
      const escorting =
        (verdict?.frontier.fraction ?? 0) > profile.movement.advanceFraction &&
        nearby < profile.escort.units;
      // Копить бесконечно нельзя: если накопление затянулось, на этом
      // решении желание «подождать» игнорируется, и деньги уходят на то,
      // что доступно сейчас. Предел выводится из горизонта накопления,
      // а не хранится вторым числом рядом с ним.
      const impatient = waitStreak >= patienceDecisions(profile);

      // Порядок трат фазы — предпочтение по умолчанию, но не закон.
      // Покупка с большей прибавкой обходит очередь, и прибавка считается
      // в энергии, той же единицей, какой меряются рубежи.
      //
      // Без этого правила строгий приоритет съедал сам себя: как только
      // прокачка начала выбирать цель жеребьёвкой, в начале очереди почти
      // всегда оказывалась дешёвая доступная ветка, и постройки исчезли
      // из матча совсем — за семь минут ни одной.
      //
      // Сопровождение генерала оставлено отдельной веткой, а не сведено
      // к тому же сравнению: там речь не о выгоде покупки, а о том, что
      // генерал на дальнем рубеже без своих рядом просто не живёт.
      const undefended = !world.structures.some(
        (structure) =>
          structure.owner === me &&
          structure.kind !== StructureKind.Base &&
          structure.kind !== StructureKind.Wall,
      );

      const spendOrder = escorting
        ? profile.escort.spend
        : orderBySpendGain(
            phase.spend,
            spendEfficiency(world, me, player, phase, profile, verdict),
            undefended,
          );

      if (!struck) {
        let waited = false;

        // Уходя вперёд без сопровождения, противник сначала набирает
        // войско. На оборонительном рубеже такой спешки нет: там генерала
        // прикрывают собственные башни.
        for (const spending of spendOrder) {
          const attempt =
            spending === 'upgrade'
              ? tryUpgrade(commands, world, me, player, phase, profile, roll)
              : spending === 'build'
                ? tryBuild(commands, world, me, player, phase, profile, approach, covered, () => {
                    buildCounter += 1;
                    return buildCounter;
                  })
                : tryTrain(commands, world, me, player, phase, profile, roll);

          if (observe !== undefined) attempts.push({ spending, ...attempt });

          if (attempt.result === 'bought') break;

          // `wait` прерывает перебор: раз на желаемое почти хватает,
          // тратить сейчас на что-то менее важное значит никогда до него
          // не добраться.
          //
          // Разрешать при этом покупки дешевле желаемого нельзя, и это
          // проверено прогоном: юнит вчетверо дешевле улучшения, поэтому
          // «покупай, что дешевле цели» вырождается в «покупай юнитов
          // всегда» — за две минуты 59 машин, ноль построек и ни одного
          // улучшения сверх первого. Послабление имеет смысл только вместе
          // со сравнением выгоды покупок (раздел 5 в `fix-ai-spending`),
          // которое умеет сказать, что юнит сейчас выгоднее улучшения,
          // а не просто дешевле.
          if (attempt.result === 'wait' && !impatient) {
            waited = true;
            break;
          }
        }

        waitStreak = waited ? waitStreak + 1 : 0;
      }

      const movement = decideMovement(world, me, approach, verdict, profile, fieldTo);
      if (movement !== undefined) commands.push(movement);

      // Запись собирается последней и только когда есть кому её принять:
      // без наблюдателя не создаётся ни одного лишнего объекта.
      if (observe !== undefined) {
        observe(
          record(world, me, player, profile, {
            phase,
            waitStreak,
            impatient,
            escorting,
            nearby,
            spendOrder,
            attempts,
            verdicts,
            verdict,
            approach,
            struck,
            commandCount: commands.length,
          }),
        );
      }

      return commands;
    },
  };
};

/** Собранное для наблюдателя. Живёт одно решение и наружу не выходит. */
interface Observed {
  readonly phase: PhaseProfile;
  readonly waitStreak: number;
  readonly impatient: boolean;
  readonly escorting: boolean;
  readonly nearby: number;
  readonly spendOrder: readonly Spending[];
  readonly attempts: readonly AttemptRecord[];
  readonly verdicts: readonly Verdict[];
  readonly verdict: Verdict | undefined;
  readonly approach: Approach;
  readonly struck: boolean;
  readonly commandCount: number;
}

/**
 * Запись о решении.
 *
 * Только чтение уже посчитанного: ни одного обращения к генератору
 * случайных чисел, ни одного дополнительного обхода карты. Прогон
 * с наблюдателем обязан давать ту же контрольную сумму, что и без него.
 */
const record = (
  world: WorldState,
  me: PlayerId,
  player: PlayerState,
  profile: AiProfile,
  seen: Observed,
): DecisionRecord => {
  const general = world.generals[me];
  const generalCell = general === undefined || !general.alive ? -1 : cellAt(general.position);

  // Клетка генерала может оказаться недостижимой от собственной базы —
  // например, если его обстроили со всех сторон. Поле расстояний
  // возвращает в этом случае сентинел, и записать его как расстояние
  // значило бы подсунуть разбору два миллиарда клеток вместо «неизвестно».
  // Один такой матч ломает всю сводку по пачке: в ней появляется генерал,
  // зашедший на пятьдесят миллионов долей пути.
  const fromHome = generalCell < 0 ? UNREACHABLE : (seen.approach.fromHome[generalCell] ?? UNREACHABLE);

  return {
    tick: world.tick,
    player: me,
    phaseIndex: profile.phases.indexOf(seen.phase),
    waitStreak: seen.waitStreak,
    impatient: seen.impatient,
    escorting: seen.escorting,
    liveUnits: liveUnits(world, me),
    nearbyUnits: seen.nearby,
    spendOrder: seen.spendOrder,
    attempts: seen.attempts,
    frontiers: seen.verdicts.map((entry) => ({
      fraction: entry.frontier.fraction,
      cell: entry.frontier.cell,
      coverage: entry.frontier.coverage,
      gain: entry.gain,
      risk: entry.risk,
      score: entry.score,
      deathChance: entry.deathChance,
      chosen: entry.frontier.cell === seen.verdict?.frontier.cell,
    })),
    generalCell,
    generalFromHome: fromHome === UNREACHABLE ? -1 : fromHome,
    approachShortest: seen.approach.shortest,
    energy: player.energy,
    struck: seen.struck,
    commandCount: seen.commandCount,
  };
};

const command = <T extends Command>(value: T): T => value;

/**
 * Прибавка на единицу энергии по каждому виду трат.
 *
 * Отсутствующий ключ означает «сравнивать не с чем»: такая трата остаётся
 * на своём месте в порядке фазы. Так ведёт себя прокачка в фазе, где
 * интересна одна экономика: её прибавка выражается будущим доходом,
 * а не уроном, и привести одно к другому нечем.
 *
 * Постройка оценивается уже посчитанной выгодой лучшего рубежа — той
 * самой, по которой генерал этот рубеж и выбрал. Второй оценки для
 * башни не заводится: она немедленно разошлась бы с первой.
 */
const spendEfficiency = (
  world: WorldState,
  me: PlayerId,
  player: PlayerState,
  phase: PhaseProfile,
  profile: AiProfile,
  verdict: Verdict | undefined,
): Readonly<Partial<Record<Spending, number>>> => {
  const stats = playerStats(player);
  const efficiency: Partial<Record<Spending, number>> = {};

  const reserve = reserveOf(phase);
  const worth = (gain: number, price: number): number =>
    discountedEfficiency(gain, price + reserve, player.energy, stats.incomePerTick, profile);

  const trainPrice = unitPrice(stats, phase);
  if (trainPrice > 0) efficiency.train = worth(unitGain(stats, phase, profile), trainPrice);

  const towerPrice = stats.structures[StructureKind.TowerBasic].cost;
  if (towerPrice > 0) efficiency.build = worth(Math.max(0, verdict?.gain ?? 0), towerPrice);

  if (hasComparableUpgrade(phase)) {
    const best = upgradeGain(world, me, stats, phase, profile, upgradeCosts(player));
    efficiency.upgrade = worth(best.gain, best.price);
  }

  return efficiency;
};

/** Сколько юнитов игрока живо на карте. */
const liveUnits = (world: WorldState, me: PlayerId): number =>
  world.units.reduce((count, unit) => (unit.owner === me ? count + 1 : count), 0);

/**
 * Сколько своих юнитов стоит РЯДОМ С ГЕНЕРАЛОМ.
 *
 * Именно это и означает «прикрыт», хотя раньше считались все живые юниты
 * на карте. Разница не теоретическая: восемь штурмовиков, толпящихся
 * у собственной базы, не помогают генералу, стоящему у чужой, ничем —
 * а признак «прикрыт» при этом выполнялся, и противник спокойно уходил
 * вперёд один.
 */
const escortNearby = (world: WorldState, me: PlayerId, stats: PlayerStats): number => {
  const general = world.generals[me];
  if (general === undefined || !general.alive) return 0;

  const radius = escortRadius(stats);

  return world.units.reduce(
    (count, unit) =>
      unit.owner === me && distanceSquared(unit.position, general.position) <= radius * radius
        ? count + 1
        : count,
    0,
  );
};

/**
 * Стоит ли копить на покупку или проще заняться чем-то другим.
 *
 * Ждать имеет смысл, только если желаемое близко: копить десять минут
 * на одну башню, ничего при этом не делая, — верный способ проиграть.
 */
const waitOrPass = (
  price: number,
  incomePerTick: number,
  profile: AiProfile,
  unaffordable: AttemptNote,
): Attempt => {
  const horizon = incomePerTick * TICKS_PER_SECOND * profile.spending.savingHorizonSeconds;

  // Помеха одна и та же — не хватает энергии, — а исходов два. Причина
  // поэтому прикладывается к обоим: без неё запись «коплю» не сказала бы,
  // на что именно. Цена прикладывается по той же причине и вдобавок
  // работает потолком для более дешёвых покупок.
  return { result: price <= horizon ? 'wait' : 'pass', note: unaffordable, price };
};

// ─────────────────────────────────────────────────────────────────────────
// Движение генерала
// ─────────────────────────────────────────────────────────────────────────

/**
 * Движение по маршруту, а не по прямой.
 *
 * Направление берётся из поля расстояний до рубежа: генерал спускается
 * по градиенту на несколько клеток вперёд и правит нос туда. Упор
 * в препятствие при этом невозможен по построению, поэтому прежние
 * эвристики — «не сдвинулся два решения, значит застрял», «сверни
 * в свободную сторону», «удерживай обход шесть решений» — не нужны
 * и удалены вместе со своей дёрганностью.
 *
 * Дойдя до рубежа, генерал получает явную команду остановиться. Это
 * важнее, чем кажется: направление живёт в состоянии мира, и без такой
 * команды генерал продолжал бы идти в последнюю заданную сторону, уходя
 * с только что занятой позиции.
 */
const decideMovement = (
  world: WorldState,
  me: PlayerId,
  approach: Approach,
  verdict: Verdict | undefined,
  profile: AiProfile,
  fieldTo: (occupancy: Occupancy, cell: number, revision: number) => Int32Array,
): Command | undefined => {
  const general = world.generals[me];
  if (general === undefined || !general.alive || verdict === undefined) return undefined;

  const from = cellAt(general.position);
  const field = fieldTo(approach.occupancy, verdict.frontier.cell, world.navRevision);

  let aim = from;
  for (let step = 0; step < profile.movement.lookaheadCells; step += 1) {
    const next = bestStep(field, approach.occupancy, world.structures, me, aim, false);
    if (next.cell < 0) break;

    aim = next.cell;
  }

  const target = cellCentre(aim);
  const direction =
    aim === from
      ? DIRECTION_STOP
      : directionTowards(target.x - general.position.x, target.y - general.position.y);

  if (direction === general.direction) return undefined;

  return command({
    kind: CommandKind.MoveGeneral,
    player: me,
    tick: asTickNumber(world.tick),
    direction,
  });
};

// ─────────────────────────────────────────────────────────────────────────
// Производство
// ─────────────────────────────────────────────────────────────────────────

const tryTrain = (
  commands: Command[],
  world: WorldState,
  me: PlayerId,
  player: PlayerState,
  phase: PhaseProfile,
  profile: AiProfile,
  roll: (bound: number) => number,
): Attempt => {
  if (player.queue.length >= profile.spending.queueTarget) return passing(AttemptNote.QueueFull);

  const stats = playerStats(player);
  const weights = [
    [UnitType.Assault, phase.mix[UnitType.Assault]] as const,
    [UnitType.Sniper, phase.mix[UnitType.Sniper]] as const,
    [UnitType.Grenadier, phase.mix[UnitType.Grenadier]] as const,
  ];

  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) return passing(AttemptNote.MixEmpty);

  let pick = roll(total);
  let chosen: UnitType = UnitType.Assault;
  for (const [type, weight] of weights) {
    if (pick < weight) {
      chosen = type;
      break;
    }
    pick -= weight;
  }

  const price = stats.units[chosen].cost + reserveOf(phase);

  // Копить на юнита можно — и это не мелочность. «Юниты дёшевы, копить
  // незачем» верно для штурмовика за одну базовую стоимость и неверно
  // для гранатомётчика за десять: его цена сопоставима с башней, и без
  // накопления он не покупается никогда. Ровно поэтому в матчах не было
  // ни одного гранатомётчика при заявленной в профиле трети.
  if (player.energy < price) {
    return waitOrPass(price, stats.incomePerTick, profile, AttemptNote.UnitUnaffordable);
  }

  commands.push(
    command({
      kind: CommandKind.TrainUnit,
      player: me,
      tick: asTickNumber(world.tick),
      unitType: chosen,
    }),
  );

  return BOUGHT;
};

// ─────────────────────────────────────────────────────────────────────────
// Строительство
// ─────────────────────────────────────────────────────────────────────────

const tryBuild = (
  commands: Command[],
  world: WorldState,
  me: PlayerId,
  player: PlayerState,
  phase: PhaseProfile,
  profile: AiProfile,
  approach: Approach,
  covered: Uint8Array,
  nextBuildNumber: () => number,
): Attempt => {
  const general = world.generals[me];
  if (general === undefined || !general.alive) return passing(AttemptNote.GeneralDead);

  const around = cellsToUnits(profile.building.cellsAroundGeneral) ** 2;
  const towers = world.structures.filter(
    (structure) =>
      structure.owner === me &&
      structure.kind !== StructureKind.Base &&
      structure.kind !== StructureKind.Wall &&
      distanceSquared(cellCentre(structure.cell), general.position) <= around,
  );

  // Стена ставится только когда есть что прикрывать. Стена сама по себе
  // лишь покупает противнику время на обход; стена перед башней —
  // укрепление, потому что башня стреляет поверх неё, а юниты сквозь
  // неё стрелять не могут.
  const shielding = nextBuildNumber() % profile.building.wallEvery === 0 && towers.length > 0;
  const kind = shielding ? StructureKind.Wall : StructureKind.TowerBasic;
  if (!BUILDABLE_KINDS.includes(kind)) return passing(AttemptNote.NotBuildable);

  const stats = playerStats(player);
  const price = stats.structures[kind].cost + reserveOf(phase);
  if (player.energy < price) {
    return waitOrPass(price, stats.incomePerTick, profile, AttemptNote.StructureUnaffordable);
  }

  const radius = stats.general.buildRadius;

  const cell = shielding
    ? shieldBuildCell(world, me, general.position, radius, approach, towers, profile)
    : towerBuildCell(
        world,
        me,
        general.position,
        radius,
        approach,
        covered,
        rangeInCells(stats.structures[StructureKind.TowerBasic].range),
      );

  // Места нет — и это не то же самое, что «нет денег». Башне нужен
  // ненакрытый путь в радиусе, стене — своя башня, которую она прикроет;
  // и то и другое кончается задолго до энергии.
  if (cell < 0) {
    return passing(shielding ? AttemptNote.NoShieldSite : AttemptNote.NoTowerSite);
  }

  commands.push(
    command({
      kind: CommandKind.Build,
      player: me,
      tick: asTickNumber(world.tick),
      cell,
      structure: kind,
    }),
  );

  return BOUGHT;
};

/**
 * Свободные клетки в радиусе строительства.
 *
 * Клетки с живыми юнитами и генералами пропускаются: ядро такую постройку
 * отклонит, а решение противника окажется потраченным впустую. Клетка под
 * собственным генералом здесь особенно важна — она первый кандидат
 * по построению, ведь строит он вокруг себя.
 *
 * По той же причине пропускается и защищённое кольцо вокруг баз. Оно
 * особенно коварно: генерал начинает матч именно там, и без этой проверки
 * ВСЕ ранние попытки строить уходили в отказ. Противник при этом считал,
 * что построил, и не пробовал другое место — за первые три минуты матча
 * у него не появлялось ни одной постройки.
 */
const forEachBuildCandidate = (
  world: WorldState,
  occupancy: Occupancy,
  from: Vec2,
  radius: number,
  visit: (cell: number, point: Vec2) => void,
): void => {
  const occupiedByLiving = new Set([
    ...world.units.map((unit) => cellAt(unit.position)),
    ...world.generals.filter((general) => general.alive).map((general) => cellAt(general.position)),
  ]);

  const centre = cellAt(from);
  const reach = Math.floor(radius / FIXED_POINT_SCALE);

  for (let dy = -reach; dy <= reach; dy += 1) {
    for (let dx = -reach; dx <= reach; dx += 1) {
      const x = cellX(centre) + dx;
      const y = cellY(centre) + dy;
      if (x < 0 || y < 0 || x >= MAP_WIDTH_CELLS || y >= MAP_HEIGHT_CELLS) continue;

      const cell = cellIndex(x, y);
      if (occupancy.blocked[cell] === 1) continue;
      if (occupiedByLiving.has(cell)) continue;

      const point = cellCentre(cell);
      // Клетка должна быть действительно в радиусе: квадрат перебора
      // описан вокруг круга и по углам из него выходит.
      if (distanceSquared(point, from) > radius * radius) continue;

      const nearBase = world.map.baseCells.some(
        (base) => distanceSquared(point, cellCentre(base)) <= BASE_BUILD_EXCLUSION ** 2,
      );
      if (nearBase) continue;

      visit(cell, point);
    }
  }
};

/**
 * Место под башню: клетка, накрывающая как можно больше ЕЩЁ НЕ НАКРЫТОГО
 * вероятного пути.
 *
 * Слово «ещё не накрытого» здесь главное. Прежняя мерка считала все клетки
 * пути подряд и не знала, что они уже простреливаются тремя своими
 * башнями, — поэтому одно и то же место оставалось «лучшим» бесконечно,
 * и приходилось затыкать это счётчиком «не больше трёх башен рядом».
 * Счётчик врал: три башни в скальном горле и три в чистом поле накрывают
 * совершенно разное.
 *
 * При равном покрытии выбирается ближайшая к чужой базе — так башни
 * сами собой выстраиваются в сторону противника, а не кольцом вокруг
 * генерала.
 *
 * Если накрывать нечего вовсе, место не выбирается. Это не пропуск хода,
 * а отказ от бесполезной покупки: та же нулевая выгода одновременно
 * уводит генерала на следующий рубеж, потому что рубежи оцениваются
 * той же меркой.
 */
const towerBuildCell = (
  world: WorldState,
  me: PlayerId,
  from: Vec2,
  radius: number,
  approach: Approach,
  covered: Uint8Array,
  rangeCells: number,
): number => {
  const enemyCell = world.map.baseCells[otherPlayer(me)];
  if (enemyCell === undefined) return -1;

  const enemy = cellCentre(enemyCell);

  let best = -1;
  let bestCoverage = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  forEachBuildCandidate(world, approach.occupancy, from, radius, (cell, point) => {
    const coverage = freshCoverage(approach, covered, cell, rangeCells);
    if (coverage < bestCoverage) return;

    const distance = distanceSquared(point, enemy);
    if (coverage === bestCoverage && distance >= bestDistance) return;

    bestCoverage = coverage;
    bestDistance = distance;
    best = cell;
  });

  return bestCoverage > 0 ? best : -1;
};

/**
 * Место под стену: между своей башней и стороной, откуда подходят войска.
 *
 * «Откуда подходят» определяется по расстоянию до чужой базы: стена
 * должна оказаться к ней ближе, чем прикрываемая башня. Клетка на самом
 * пути ценнее клетки рядом с ним — именно по ней и пойдут.
 */
const shieldBuildCell = (
  world: WorldState,
  me: PlayerId,
  from: Vec2,
  radius: number,
  approach: Approach,
  towers: readonly StructureState[],
  profile: AiProfile,
): number => {
  const enemyCell = world.map.baseCells[otherPlayer(me)];
  if (enemyCell === undefined) return -1;

  const enemy = cellCentre(enemyCell);
  const shieldReach = cellsToUnits(profile.building.shieldRadiusCells) ** 2;

  let best = -1;
  let bestOnPath = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  forEachBuildCandidate(world, approach.occupancy, from, radius, (cell, point) => {
    const distance = distanceSquared(point, enemy);

    const shields = towers.some((tower) => {
      const towerPoint = cellCentre(tower.cell);
      return (
        distanceSquared(point, towerPoint) <= shieldReach &&
        distance < distanceSquared(towerPoint, enemy)
      );
    });
    if (!shields) return;

    const onPath = approach.onPath[cell] === 1 ? 1 : 0;
    if (onPath < bestOnPath) return;
    if (onPath === bestOnPath && distance >= bestDistance) return;

    bestOnPath = onPath;
    bestDistance = distance;
    best = cell;
  });

  return best;
};

// ─────────────────────────────────────────────────────────────────────────
// Выбор цели
// ─────────────────────────────────────────────────────────────────────────

/**
 * Ближайшая к своей базе клетка вероятного пути, накрытая постройкой.
 *
 * Возвращает `UNREACHABLE`, если постройка путь не накрывает вовсе, —
 * такая войску не мешает и целью быть не должна.
 *
 * Меряется именно накрытая клетка, а не клетка самой постройки, и это
 * не придирка: постройка делает свою клетку непроходимой, поэтому
 * расстояние по проходимым клеткам у неё самой не определено. Взяв его,
 * мы отбрасывали бы ровно те башни, которые стоят на пути, — то есть
 * все, ради которых правило и заводится.
 *
 * Заодно величина получается осмысленнее: это место, где войско ВПЕРВЫЕ
 * попадёт под огонь этой башни.
 */
const firstCoveredOnPath = (approach: Approach, cell: number, rangeCells: number): number => {
  const cx = cellX(cell);
  const cy = cellY(cell);

  let nearest = UNREACHABLE;

  for (let dy = -rangeCells; dy <= rangeCells; dy += 1) {
    for (let dx = -rangeCells; dx <= rangeCells; dx += 1) {
      if (dx * dx + dy * dy > rangeCells * rangeCells) continue;

      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= MAP_WIDTH_CELLS || y >= MAP_HEIGHT_CELLS) continue;

      const inner = cellIndex(x, y);
      if (approach.onPath[inner] !== 1) continue;

      const from = approach.fromHome[inner] ?? UNREACHABLE;
      if (from < nearest) nearest = from;
    }
  }

  return nearest;
};

/**
 * Цель атаки.
 *
 * Ближайшая по вероятному пути вражеская стреляющая постройка, которая
 * этот путь накрывает. База — только если таких построек нет вовсе.
 *
 * Правило существует потому, что юнит останавливается ТОЛЬКО у назначенной
 * цели: постройка на пути его не задерживает. Это правило движения
 * намеренное — без него гранатомётчик залипал бы на первой встречной
 * стене, — но вместе с целью-базой оно давало волну, идущую сквозь строй
 * башен под их огнём и не пытающуюся эти башни снять.
 *
 * Цена ошибки была не в одних потерях. Башня получает прибавку к атаке
 * и прочности за каждое убийство сложным процентом, поэтому войско,
 * гибнущее по дороге, бесплатно усиливало оборону, сквозь которую шло:
 * двадцать разменянных машин делают обычную башню вдвое с половиной
 * сильнее навсегда.
 *
 * Заодно правило впервые позволяет гранатомётчику делать то, ради чего
 * он куплен: его дальность на клетку больше башенной, и, остановившись
 * у НАЗНАЧЕННОЙ цели, он расстреливает её вне досягаемости.
 *
 * Прежнее правило делило карту пополам и перенацеливалось на всё, что
 * противник выдвинул к нам. Оно покрывается новым как частный случай —
 * выдвинутая башня накрывает путь и оказывается ближайшей, — но теперь
 * выбирается по причине, а не по географии: башня в стороне от маршрута
 * войску не мешает, а сход с маршрута ради неё стоит времени и жизней.
 */
const pushTargeting = (
  commands: Command[],
  world: WorldState,
  me: PlayerId,
  player: PlayerState,
  approach: Approach,
): void => {
  const enemyBase = world.structures.find(
    (structure) => structure.owner !== me && structure.kind === StructureKind.Base,
  );
  if (enemyBase === undefined) return;

  const enemy = world.players[otherPlayer(me)];
  const enemyStats = enemy === undefined ? undefined : playerStats(enemy);

  let chosen = enemyBase;
  let closest = Number.POSITIVE_INFINITY;

  for (const structure of world.structures) {
    if (structure.owner === me || structure.kind === StructureKind.Base) continue;

    // Стреляющая — значит опасная. Стена урона не наносит, и сносить
    // её войску незачем; условие отсекает её без отдельного правила.
    const baseline = enemyStats?.structures[structure.kind];
    if (baseline === undefined || baseline.attack <= 0 || baseline.range <= 0) continue;

    // Близость по проходимым клеткам, а не по прямой: войско идёт
    // по маршруту, и первой ему встретится ближайшая по маршруту.
    const distance = firstCoveredOnPath(approach, structure.cell, rangeInCells(baseline.range));
    if (distance === UNREACHABLE || distance > closest) continue;
    // Ничья — по меньшему индексу клетки: порядок построек в массиве
    // меняется при разрушении, и без этого цель дрожала бы на ровном месте.
    if (distance === closest && structure.cell >= chosen.cell) continue;

    closest = distance;
    chosen = structure;
  }

  if (player.targetStructure === chosen.id) return;

  commands.push(
    command({
      kind: CommandKind.SetTarget,
      player: me,
      tick: asTickNumber(world.tick),
      cell: chosen.cell,
    }),
  );
};

// ─────────────────────────────────────────────────────────────────────────
// Прокачка
// ─────────────────────────────────────────────────────────────────────────

const tryUpgrade = (
  commands: Command[],
  world: WorldState,
  me: PlayerId,
  player: PlayerState,
  phase: PhaseProfile,
  profile: AiProfile,
  roll: (bound: number) => number,
): Attempt => {
  // Цель прокачки выбирается взвешенной жеребьёвкой — тем же способом
  // и тем же генератором, каким выбирается тип юнита.
  //
  // Прежде цели перебирались «в порядке предпочтения», и порядок
  // вырождался в первый пункт: ветка не кончается никогда, поэтому
  // до второй цели очередь не доходила ни разу за матч. Из восьми
  // названных целей покупки получали две.
  //
  // Пережеребьёвки при неудаче нет намеренно. Соблазн велик — выпала
  // цель, где покупать нечего, тянем ещё раз, — но так состав молча
  // сдвигается в сторону доступного, и заявленные доли перестают
  // значить хоть что-нибудь.
  const weights = UPGRADE_TARGETS.map((target) => [target, phase.upgrades[target] ?? 0] as const);
  const totalWeight = weights.reduce((sum, [, weight]) => sum + weight, 0);
  if (totalWeight <= 0) return passing(AttemptNote.NothingToUpgrade);

  let pick = roll(totalWeight);
  let target: UpgradeTarget = UpgradeTarget.Economy;
  for (const [candidate, weight] of weights) {
    if (pick < weight) {
      target = candidate;
      break;
    }
    pick -= weight;
  }

  const costs = upgradeCosts(player);

  // Внутри выпавшей цели берётся самая дешёвая ветка: они однородны
  // по смыслу, и предпочитать среди них нечего.
  let bestBranch = -1;
  let bestCost = Number.POSITIVE_INFINITY;

  UPGRADE_BRANCHES.forEach((branch, index) => {
    if (branch.target !== target) return;
    // Радиус строительства и время воскрешения полезны, но выигрыш
    // от них не считается в уроне, и оценить его нечем. Проще
    // пропустить, чем усложнять правило.
    if (branch.stat === UpgradeStat.BuildRadius) return;
    if (branch.stat === UpgradeStat.RespawnTime) return;

    const cost = costs[index] ?? Number.POSITIVE_INFINITY;
    if (cost >= bestCost) return;

    bestBranch = index;
    bestCost = cost;
  });

  if (bestBranch < 0) return passing(AttemptNote.NothingToUpgrade);

  const price = bestCost + reserveOf(phase);
  if (player.energy < price) {
    return waitOrPass(
      price,
      playerStats(player).incomePerTick,
      profile,
      AttemptNote.UpgradeUnaffordable,
    );
  }

  commands.push(
    command({
      kind: CommandKind.BuyUpgrade,
      player: me,
      tick: asTickNumber(world.tick),
      branch: bestBranch,
    }),
  );

  return BOUGHT;
};

// ─────────────────────────────────────────────────────────────────────────
// Ядерный удар
// ─────────────────────────────────────────────────────────────────────────

const tryNuke = (
  commands: Command[],
  world: WorldState,
  me: PlayerId,
  player: PlayerState,
  profile: AiProfile,
): boolean => {
  if (player.energy < NUKE_COST) return false;

  const bases = world.structures
    .filter((structure) => structure.kind === StructureKind.Base)
    .map((structure) => cellCentre(structure.cell));

  let bestCell = -1;
  let bestCount = profile.nuke.worthUnits - 1;

  for (let y = 0; y < MAP_HEIGHT_CELLS; y += profile.nuke.scanStep) {
    for (let x = 0; x < MAP_WIDTH_CELLS; x += profile.nuke.scanStep) {
      const centre = cellCentre(cellIndex(x, y));

      // Запретную зону проверяет и ядро, но команда, которую заведомо
      // отклонят, — это впустую потраченное решение.
      if (bases.some((base) => distanceSquared(centre, base) < NUKE_BASE_EXCLUSION ** 2)) {
        continue;
      }

      let count = 0;
      for (const unit of world.units) {
        if (unit.owner === me) continue;
        if (distanceSquared(unit.position, centre) <= NUKE_RADIUS ** 2) count += 1;
      }
      // Свои потери вычитаются: удар по свалке, где своих больше чужих,
      // выгоден противнику, а не нам.
      for (const unit of world.units) {
        if (unit.owner !== me) continue;
        if (distanceSquared(unit.position, centre) <= NUKE_RADIUS ** 2) count -= 1;
      }

      if (count <= bestCount) continue;

      bestCount = count;
      bestCell = cellIndex(x, y);
    }
  }

  if (bestCell < 0) return false;

  commands.push(
    command({
      kind: CommandKind.LaunchNuke,
      player: me,
      tick: asTickNumber(world.tick),
      cell: bestCell,
    }),
  );

  return true;
};
