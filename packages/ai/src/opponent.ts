import {
  AI_DECISION_INTERVAL_TICKS,
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
  UnitType,
  UpgradeStat,
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
import type { Occupancy, PlayerState, StructureState, WorldState } from '@td/sim';
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
import { BASELINE_PROFILE, phaseAt, reserveOf } from './profile.js';
import type { AiProfile, PhaseProfile, Spending } from './profile.js';

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
      pushTargeting(commands, world, me, player);

      // Ядерный удар проверяется до остальных трат: он копится в запасе
      // фазы, и тратить этот запас на что-то другое было бы обидно.
      const struck = tryNuke(commands, world, me, player, profile);

      const attempts: AttemptRecord[] = [];
      const escorting =
        (verdict?.frontier.fraction ?? 0) > profile.movement.advanceFraction &&
        liveUnits(world, me) < profile.escort.units;
      // Копить бесконечно нельзя: если накопление затянулось, на этом
      // решении желание «подождать» игнорируется, и деньги уходят на то,
      // что доступно сейчас.
      const impatient = waitStreak >= profile.spending.maxWaitDecisions;
      const spendOrder = escorting ? profile.escort.spend : phase.spend;

      if (!struck) {
        let waited = false;

        // Уходя вперёд без сопровождения, противник сначала набирает
        // войско. На оборонительном рубеже такой спешки нет: там генерала
        // прикрывают собственные башни.
        for (const spending of spendOrder) {
          const attempt =
            spending === 'upgrade'
              ? tryUpgrade(commands, world, me, player, phase, profile)
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

/** Сколько юнитов игрока живо на карте. */
const liveUnits = (world: WorldState, me: PlayerId): number =>
  world.units.reduce((count, unit) => (unit.owner === me ? count + 1 : count), 0);

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
  // на что именно.
  return { result: price <= horizon ? 'wait' : 'pass', note: unaffordable };
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

  const cost = stats.units[chosen].cost;
  // Юниты дёшевы, копить на них незачем: если сейчас не хватает,
  // через пару решений хватит само собой.
  if (player.energy < cost + reserveOf(phase)) return passing(AttemptNote.UnitUnaffordable);

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
 * Цель атаки.
 *
 * По умолчанию — база противника. Но если он выдвинул башни к нашей
 * половине карты, разумнее сначала снести их: иначе поток юнитов будет
 * умирать по дороге, так и не дойдя до базы.
 */
const pushTargeting = (
  commands: Command[],
  world: WorldState,
  me: PlayerId,
  player: PlayerState,
): void => {
  const homeCell = world.map.baseCells[me];
  const enemyBaseCell = world.map.baseCells[otherPlayer(me)];
  if (homeCell === undefined || enemyBaseCell === undefined) return;

  const home = cellCentre(homeCell);
  const enemyBase = world.structures.find(
    (structure) => structure.owner !== me && structure.kind === StructureKind.Base,
  );
  if (enemyBase === undefined) return;

  const halfway = distanceSquared(home, cellCentre(enemyBaseCell)) * 0.36;

  let chosen = enemyBase;
  let closest = Number.POSITIVE_INFINITY;

  for (const structure of world.structures) {
    if (structure.owner === me) continue;
    if (structure.kind === StructureKind.Base || structure.kind === StructureKind.Wall) continue;

    const distance = distanceSquared(cellCentre(structure.cell), home);
    if (distance > halfway || distance >= closest) continue;

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
): Attempt => {
  const costs = upgradeCosts(player);

  // Ветки перебираются в порядке предпочтения фазы, а не по цене.
  //
  // Первая версия брала самую дешёвую из доступных, и это оказалось
  // ловушкой: ветки штурмовика стоят 40, а экономика 100, поэтому
  // противник до бесконечности покупал мелкие прибавки к атаке и ни разу
  // не вкладывался в добычу энергии. За пятнадцать минут он оставался
  // на втором уровне прокачки и с тем же доходом, что и на первой минуте.
  let bestBranch = -1;
  let bestCost = Number.POSITIVE_INFINITY;

  for (const target of phase.upgrades) {
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

    // Нашли что-то в текущей по важности цели — дальше не смотрим.
    if (bestBranch >= 0) break;
  }

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
