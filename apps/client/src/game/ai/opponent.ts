import {
  AI_DECISION_INTERVAL_TICKS,
  BUILDABLE_KINDS,
  CommandKind,
  DIRECTION_COUNT,
  DIRECTION_SCALE,
  DIRECTION_STOP,
  DIRECTION_VECTORS,
  NUKE_BASE_EXCLUSION,
  NUKE_COST,
  NUKE_RADIUS,
  MAP_CELL_COUNT,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  PRODUCTION_QUEUE_CAP,
  STRUCTURE_STATS,
  StructureKind,
  TICKS_PER_SECOND,
  FIXED_POINT_SCALE,
  UPGRADE_BRANCHES,
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
  buildOccupancy,
  cellAt,
  cellCentre,
  cellIndex,
  cellX,
  cellY,
  createRng,
  dijkstraField,
  footprintCells,
  isInsideMap,
  nextRngInt,
  playerStats,
  upgradeCosts,
} from '@td/sim';
import type { Occupancy, PlayerState, StructureState, WorldState } from '@td/sim';

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
 */

export interface Opponent {
  /** Команды на этот тик. Пустой массив — противник сейчас думает. */
  decide(world: WorldState): readonly Command[];
}

/** Радиус, в котором вражеские юниты считаются угрозой базе, в клетках. */
const THREAT_RADIUS_CELLS = 10;

/** Сколько юнитов у базы противник считает поводом идти домой. */
const THREAT_UNITS = 3;

/** Сколько своих башен рядом с генералом считается достаточным. */
const TOWERS_AROUND_GENERAL = 3;

const CELLS_AROUND_GENERAL = 8;

/** Каждая четвёртая постройка — стена: они прикрывают уже стоящие башни. */
const WALL_EVERY = 4;

/** Сколько вражеских юнитов оправдывают ядерный удар. */
const NUKE_WORTH_UNITS = 6;

/** Шаг сетки при поиске места для удара, в клетках. */
const NUKE_SCAN_STEP = 3;

/**
 * Насколько маршрут может быть длиннее кратчайшего, чтобы всё ещё считаться
 * вероятным путём вражеских войск, в клетках.
 *
 * Ноль означал бы одну-единственную нитку, и башня чуть в стороне от неё
 * считалась бы бесполезной. Слишком много — и «вероятным путём» станет
 * половина карты, а вместе с этим исчезнет сам смысл понятия.
 */
const PATH_SLACK_CELLS = 6;

/** Сколько решений подряд без смены клетки считается застреванием. */
const STUCK_DECISIONS = 2;

/**
 * Сколько решений удерживается выбранный обход.
 *
 * Без удержания генерал на следующем же решении снова поворачивает к цели,
 * упирается в ту же скалу и повторяет это до конца матча: из вогнутого
 * кармана одним шагом в сторону не выйти.
 */
const DETOUR_DECISIONS = 6;

/** На сколько клеток вперёд проверяется проходимость направления. */
const PROBE_CELLS = 3;

/** В скольких клетках от своей башни имеет смысл ставить прикрывающую стену. */
const SHIELD_RADIUS_CELLS = 2;

/** На что можно потратить энергию за одно решение. */
type Spending = 'upgrade' | 'build' | 'train';

/**
 * Чем закончилась попытка потратить энергию.
 *
 * `wait` — самое важное здесь. Без него противник вечно тратил бы доход
 * на мелочи и никогда не накопил бы на крупное: при доходе в десять
 * в секунду и штурмовике за двадцать пять казна просто не успевает
 * подрасти между решениями. `wait` означает «хочу, но пока не по карману,
 * и мелочь покупать не буду».
 */
type Attempt = 'bought' | 'wait' | 'pass';

/**
 * Насколько далёкую покупку имеет смысл ждать, в секундах дохода.
 *
 * Ждать вечно нельзя: если желаемое стоит десять минут дохода, разумнее
 * тратить на то, что доступно сейчас.
 */
const SAVING_HORIZON_SECONDS = 45;

/**
 * Сколько решений подряд разрешено копить, ничего не покупая.
 *
 * Без этого предела противник впадал в ступор: прокачка каждый раз
 * отвечала «почти хватает, подожди», и он ждал до конца матча, не построив
 * ни одной башни и не купив ни одного улучшения. Восемь решений — это
 * четыре секунды: за них казна прирастает заметно, но армия не простаивает.
 */
const MAX_WAIT_DECISIONS = 8;

interface Phase {
  readonly untilSecond: number;
  /** Ветки прокачки, интересные в этой фазе, в порядке предпочтения. */
  readonly upgrades: readonly UpgradeTarget[];
  /** Доля юнитов каждого типа: сумма весов задаёт вероятности. */
  readonly mix: Readonly<Record<UnitType, number>>;
  /**
   * Порядок трат. Первое, что удалось купить, останавливает перебор:
   * за одно решение противник совершает не более одной покупки.
   */
  readonly spend: readonly Spending[];
  /**
   * Неприкосновенный запас энергии.
   *
   * В поздней фазе он равен цене ядерного удара: противник держит
   * заряд в банке и тратит только излишек. Без запаса он до удара
   * не накопит никогда — юниты и прокачка съедают доход подчистую.
   */
  readonly reserve: number;
}

/**
 * Фазы матча.
 *
 * Ранняя — вложения в экономику и первые башни у базы. Средняя — поток
 * юнитов и башни ближе к фронту. Поздняя — прокачка боевых веток
 * и ядерный удар.
 *
 * Порядок трат — самая важная строка в каждой фазе. Первая версия
 * противника пыталась купить всё сразу, и штурмовики за 25 энергии
 * при доходе в 10 в секунду выгребали казну раньше, чем очередь доходила
 * до экономики: за восемь минут он ставил ОДНУ постройку и не покупал
 * ни одного улучшения. Одна покупка за решение, в заданном порядке,
 * лечит это полностью.
 */
const LATE_PHASE: Phase = {
  untilSecond: Number.POSITIVE_INFINITY,
  upgrades: [
    UpgradeTarget.UnitAssault,
    UpgradeTarget.UnitGrenadier,
    UpgradeTarget.TowerSniper,
    UpgradeTarget.General,
    UpgradeTarget.Economy,
  ],
  mix: { [UnitType.Assault]: 4, [UnitType.Sniper]: 2, [UnitType.Grenadier]: 3 },
  spend: ['upgrade', 'train', 'build'],
  reserve: NUKE_COST,
};

const PHASES: readonly Phase[] = [
  {
    untilSecond: 90,
    upgrades: [UpgradeTarget.Economy],
    mix: { [UnitType.Assault]: 4, [UnitType.Sniper]: 1, [UnitType.Grenadier]: 0 },
    // Экономика вперёд всего: вложенное в первую минуту окупается весь матч.
    spend: ['upgrade', 'build', 'train'],
    reserve: 0,
  },
  {
    untilSecond: 300,
    upgrades: [UpgradeTarget.Economy, UpgradeTarget.UnitAssault, UpgradeTarget.TowerBasic],
    mix: { [UnitType.Assault]: 5, [UnitType.Sniper]: 2, [UnitType.Grenadier]: 1 },
    // Прокачка перед постройками: вложенное в экономику к середине матча
    // окупается, а лишняя башня у блуждающего генерала — почти никогда.
    spend: ['upgrade', 'build', 'train'],
    reserve: 0,
  },
  // Поздняя фаза замыкает список: её порог бесконечен, поэтому поиск
  // всегда что-нибудь находит и запасной вариант нужен лишь формально.
  LATE_PHASE,
];

const phaseAt = (tick: number): Phase => {
  const seconds = tick / TICKS_PER_SECOND;
  return PHASES.find((phase) => seconds < phase.untilSecond) ?? LATE_PHASE;
};

const otherPlayer = (id: PlayerId): number => 1 - id;

// ─────────────────────────────────────────────────────────────────────────
// Вероятный путь вражеских войск
// ─────────────────────────────────────────────────────────────────────────

/**
 * Где противник ждёт чужие войска.
 *
 * Первая версия ставила башни в свободную клетку, ближайшую к вражеской
 * базе. Звучит наступательно, а на деле башни регулярно оказывались
 * в скальном кармане, куда никто никогда не придёт: «ближе к врагу»
 * по прямой и «на дороге к врагу» — разные вещи, и на карте со скалами
 * они расходятся почти всегда.
 *
 * Правильный признак — лежит ли клетка на маршруте, по которому войска
 * реально пойдут. Считается это без всякой эвристики: два обхода карты,
 * от своей базы и от чужой. Клетка лежит на пути, если сумма расстояний
 * до обеих баз превышает кратчайшее расстояние между ними не больше чем
 * на допуск. При нулевом допуске получилась бы одна нитка кратчайшего
 * пути, при разумном — коридор всех разумных обходов.
 */
export interface Approach {
  /** Единица — клетка лежит на маршруте, близком к кратчайшему. */
  readonly onPath: Uint8Array;
  /** Расстояние от своей базы по проходимым клеткам. */
  readonly fromHome: Int32Array;
  /** Длина кратчайшего маршрута между базами. */
  readonly shortest: number;
  /** Занятость, посчитанная заодно: она нужна и строительству, и движению. */
  readonly occupancy: Occupancy;
}

const distanceField = (occupancy: Occupancy, seeds: readonly number[]): Int32Array => {
  const cost = new Int32Array(MAP_CELL_COUNT);

  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    cost[cell] = occupancy.blocked[cell] === 1 ? 0 : 1;
  }
  // Клетки основания базы проходимы для поля: иначе оно не смогло бы
  // от них начаться.
  for (const seed of seeds) cost[seed] = 1;

  return dijkstraField(cost, seeds);
};

const baseSeeds = (cell: number): readonly number[] =>
  footprintCells(cell, STRUCTURE_STATS[StructureKind.Base].footprintRadius);

export const approachOf = (world: WorldState, me: PlayerId): Approach | undefined => {
  const homeCell = world.map.baseCells[me];
  const enemyCell = world.map.baseCells[otherPlayer(me)];
  if (homeCell === undefined || enemyCell === undefined) return undefined;

  const occupancy = buildOccupancy(world.map, world.structures);
  const fromHome = distanceField(occupancy, baseSeeds(homeCell));
  const fromEnemy = distanceField(occupancy, baseSeeds(enemyCell));

  // Кратчайший маршрут ищется минимумом суммы, а не расстоянием до чужой
  // базы: клетки самой базы непроходимы, и поле до них не доходит.
  let shortest = UNREACHABLE;
  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    const home = fromHome[cell] ?? UNREACHABLE;
    const enemy = fromEnemy[cell] ?? UNREACHABLE;
    if (home === UNREACHABLE || enemy === UNREACHABLE) continue;

    const total = home + enemy;
    if (total < shortest) shortest = total;
  }

  if (shortest === UNREACHABLE) return undefined;

  const limit = shortest + PATH_SLACK_CELLS;
  const onPath = new Uint8Array(MAP_CELL_COUNT);

  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    if (occupancy.blocked[cell] === 1) continue;

    const home = fromHome[cell] ?? UNREACHABLE;
    const enemy = fromEnemy[cell] ?? UNREACHABLE;
    if (home === UNREACHABLE || enemy === UNREACHABLE) continue;

    if (home + enemy <= limit) onPath[cell] = 1;
  }

  return { onPath, fromHome, shortest, occupancy };
};

export const createOpponent = (me: PlayerId, seed: number): Opponent => {
  // Случайность берётся из детерминированного генератора, а не из
  // Math.random. Формально это не требуется — противник живёт вне ядра, —
  // но благодаря этому матч с фиксированными seed воспроизводится целиком,
  // что бесценно при разборе «почему он вдруг так пошёл».
  let rng = createRng(seed);
  let nextDecisionTick = 0;
  let buildCounter = 0;
  let waitStreak = 0;
  let decisionCount = 0;

  // Отслеживание застревания: если генерал не сдвинулся с места между
  // решениями, он упёрся в скалу, и надо попробовать другое направление.
  let lastGeneralCell = -1;
  let stuckCount = 0;

  const detour: Detour = { direction: DIRECTION_STOP, untilDecision: 0 };

  const roll = (bound: number): number => {
    const [next, value] = nextRngInt(rng, bound);
    rng = next;
    return value;
  };

  const trackStuck = (world: WorldState): number => {
    const general = world.generals[me];
    const cell = general === undefined ? -1 : cellAt(general.position);

    stuckCount = cell === lastGeneralCell ? stuckCount + 1 : 0;
    lastGeneralCell = cell;

    return stuckCount;
  };

  return {
    decide(world) {
      if (world.winner !== null) return [];
      if (world.tick < nextDecisionTick) return [];

      nextDecisionTick = world.tick + AI_DECISION_INTERVAL_TICKS;
      decisionCount += 1;

      const player = world.players[me];
      if (player === undefined) return [];

      // Вероятный путь считается раз в решение, то есть дважды в секунду.
      // Это два обхода карты в две с небольшим тысячи клеток — цена,
      // которую не видно даже на профиле, а зависят от него и выбор места
      // под башню, и цель движения генерала.
      const approach = approachOf(world, me);
      if (approach === undefined) return [];

      const phase = phaseAt(world.tick);
      const commands: Command[] = [];

      // Выбор цели энергии не стоит и потому идёт всегда.
      pushTargeting(commands, world, me, player);

      // Ядерный удар проверяется до остальных трат: он копится в запасе
      // фазы, и тратить этот запас на что-то другое было бы обидно.
      const struck = tryNuke(commands, world, me, player);

      if (!struck) {
        // Копить бесконечно нельзя: если накопление затянулось,
        // на этом решении желание «подождать» игнорируется, и деньги
        // уходят на то, что доступно сейчас.
        const impatient = waitStreak >= MAX_WAIT_DECISIONS;
        let waited = false;

        for (const spending of phase.spend) {
          const result =
            spending === 'upgrade'
              ? tryUpgrade(commands, world, me, player, phase)
              : spending === 'build'
                ? tryBuild(commands, world, me, player, phase, approach, () => {
                    buildCounter += 1;
                    return buildCounter;
                  })
                : tryTrain(commands, world, me, player, phase, roll, phase.reserve);

          if (result === 'bought') break;

          // `wait` прерывает перебор: раз на желаемое почти хватает,
          // тратить сейчас на что-то менее важное значит никогда до него
          // не добраться.
          if (result === 'wait' && !impatient) {
            waited = true;
            break;
          }
        }

        waitStreak = waited ? waitStreak + 1 : 0;
      }

      const movement = decideMovement(
        world,
        me,
        approach,
        trackStuck(world),
        decisionCount,
        detour,
        roll,
      );
      if (movement !== undefined) commands.push(movement);

      return commands;
    },
  };
};

const command = <T extends Command>(value: T): T => value;

/**
 * Стоит ли копить на покупку или проще заняться чем-то другим.
 *
 * Ждать имеет смысл, только если желаемое близко: копить десять минут
 * на одну башню, ничего при этом не делая, — верный способ проиграть.
 */
const waitOrPass = (price: number, incomePerTick: number): Attempt => {
  const horizon = incomePerTick * TICKS_PER_SECOND * SAVING_HORIZON_SECONDS;
  return price <= horizon ? 'wait' : 'pass';
};

// ─────────────────────────────────────────────────────────────────────────
// Движение генерала
// ─────────────────────────────────────────────────────────────────────────

/** Выбранный обход. Живёт между решениями, поэтому изменяемый. */
interface Detour {
  direction: number;
  /** Номер решения, до которого обход держится. */
  untilDecision: number;
}

const decideMovement = (
  world: WorldState,
  me: PlayerId,
  approach: Approach,
  stuck: number,
  decision: number,
  detour: Detour,
  roll: (bound: number) => number,
): Command | undefined => {
  const general = world.generals[me];
  if (general === undefined || !general.alive) return undefined;

  const moveTo = (direction: number): Command | undefined =>
    direction === general.direction || direction === DIRECTION_STOP
      ? undefined
      : command({
          kind: CommandKind.MoveGeneral,
          player: me,
          tick: asTickNumber(world.tick),
          direction,
        });

  // Обход держится несколько решений подряд, но прерывается, если генерал
  // застрял и в нём тоже: тогда ищется новый.
  if (decision < detour.untilDecision && stuck < STUCK_DECISIONS) {
    return moveTo(detour.direction);
  }

  const goal = goalOf(world, me, approach);

  if (stuck >= STUCK_DECISIONS) {
    detour.direction = escapeDirection(
      approach.occupancy,
      general.position,
      goal,
      general.direction,
      roll,
    );
    detour.untilDecision = decision + DETOUR_DECISIONS;

    return moveTo(detour.direction);
  }

  return moveTo(directionTowards(goal.x - general.position.x, goal.y - general.position.y));
};

/** Проходимы ли ближайшие клетки в этом направлении. */
const directionIsFree = (occupancy: Occupancy, from: Vec2, direction: number): boolean => {
  const vector = DIRECTION_VECTORS[direction];
  if (vector === undefined) return false;

  const centre = cellAt(from);
  const startX = cellX(centre);
  const startY = cellY(centre);

  for (let step = 1; step <= PROBE_CELLS; step += 1) {
    const x = startX + Math.round((vector.x * step) / DIRECTION_SCALE);
    const y = startY + Math.round((vector.y * step) / DIRECTION_SCALE);

    if (!isInsideMap(x, y)) return false;
    if (occupancy.blocked[cellIndex(x, y)] === 1) return false;
  }

  return true;
};

/**
 * Куда сворачивать, упершись.
 *
 * Не случайное направление, а лучшее из свободных: то, которое при прочих
 * равных приближает к цели. Случайное было в первой версии и работало
 * плохо ровно потому, что случайное — значит с вероятностью в семь восьмых
 * не туда.
 */
const escapeDirection = (
  occupancy: Occupancy,
  from: Vec2,
  goal: Vec2,
  current: number,
  roll: (bound: number) => number,
): number => {
  let best = DIRECTION_STOP;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let direction = 1; direction < DIRECTION_COUNT; direction += 1) {
    if (direction === current) continue;
    if (!directionIsFree(occupancy, from, direction)) continue;

    const vector = DIRECTION_VECTORS[direction];
    if (vector === undefined) continue;

    const ahead = {
      x: from.x + (vector.x * PROBE_CELLS * FIXED_POINT_SCALE) / DIRECTION_SCALE,
      y: from.y + (vector.y * PROBE_CELLS * FIXED_POINT_SCALE) / DIRECTION_SCALE,
    };

    const distance = distanceSquared(ahead, goal);
    if (distance >= bestDistance) continue;

    bestDistance = distance;
    best = direction;
  }

  // Свободных направлений нет вовсе — дёргаемся случайно. Лучше так,
  // чем стоять до конца матча.
  return best === DIRECTION_STOP ? roll(8) + 1 : best;
};

/**
 * Куда генерал стремится.
 *
 * Своя база под угрозой — идём домой. Иначе продвигаемся к фронту:
 * точке НА вероятном пути вражеских войск, отстоящей от своей базы
 * на заданную долю маршрута. Доля растёт со временем.
 *
 * Именно на пути, а не на прямой между базами. Прямая между базами
 * запросто проходит сквозь скальную гряду, и генерал, идущий к точке
 * на ней, упирается в камень и там же строит бесполезные башни.
 * Точка на пути проходима по построению.
 *
 * Дальше середины противник не заходит: генерал — не штурмовой отряд,
 * а строитель, и терять его в чужом тылу невыгодно.
 */
const goalOf = (world: WorldState, me: PlayerId, approach: Approach): Vec2 => {
  const homeCell = world.map.baseCells[me];
  if (homeCell === undefined) return { x: 0, y: 0 };

  const home = cellCentre(homeCell);

  const threatRadius = cellsToUnits(THREAT_RADIUS_CELLS);
  let threats = 0;
  for (const unit of world.units) {
    if (unit.owner === me) continue;
    if (distanceSquared(unit.position, home) <= threatRadius * threatRadius) threats += 1;
  }

  if (threats >= THREAT_UNITS) return home;

  // Продвижение растёт со временем: за пять минут доходит до 0,45.
  const minutes = world.tick / (TICKS_PER_SECOND * 60);
  const progress = Math.min(0.45, 0.12 + minutes * 0.07);
  const wanted = Math.round(approach.shortest * progress);

  let best = -1;
  let bestGap = Number.POSITIVE_INFINITY;

  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    if (approach.onPath[cell] !== 1) continue;

    const gap = Math.abs((approach.fromHome[cell] ?? 0) - wanted);
    if (gap >= bestGap) continue;

    bestGap = gap;
    best = cell;
  }

  return best < 0 ? home : cellCentre(best);
};

// ─────────────────────────────────────────────────────────────────────────
// Производство
// ─────────────────────────────────────────────────────────────────────────

/** Не держим в очереди больше нескольких заказов: энергия нужнее живой. */
const QUEUE_TARGET = Math.min(4, PRODUCTION_QUEUE_CAP);

const tryTrain = (
  commands: Command[],
  world: WorldState,
  me: PlayerId,
  player: PlayerState,
  phase: Phase,
  roll: (bound: number) => number,
  reserve: number,
): Attempt => {
  if (player.queue.length >= QUEUE_TARGET) return 'pass';

  const stats = playerStats(player);
  const weights = [
    [UnitType.Assault, phase.mix[UnitType.Assault]] as const,
    [UnitType.Sniper, phase.mix[UnitType.Sniper]] as const,
    [UnitType.Grenadier, phase.mix[UnitType.Grenadier]] as const,
  ];

  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) return 'pass';

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
  if (player.energy < cost + reserve) return 'pass';

  commands.push(
    command({
      kind: CommandKind.TrainUnit,
      player: me,
      tick: asTickNumber(world.tick),
      unitType: chosen,
    }),
  );

  return 'bought';
};

// ─────────────────────────────────────────────────────────────────────────
// Строительство
// ─────────────────────────────────────────────────────────────────────────

const tryBuild = (
  commands: Command[],
  world: WorldState,
  me: PlayerId,
  player: PlayerState,
  phase: Phase,
  approach: Approach,
  nextBuildNumber: () => number,
): Attempt => {
  const general = world.generals[me];
  if (general === undefined || !general.alive) return 'pass';

  const around = cellsToUnits(CELLS_AROUND_GENERAL) ** 2;
  const nearby = world.structures.filter(
    (structure) =>
      structure.owner === me &&
      structure.kind !== StructureKind.Base &&
      distanceSquared(cellCentre(structure.cell), general.position) <= around,
  );

  // Плотнее строить смысла нет: генерал всё равно уйдёт вперёд,
  // и новая позиция окажется полезнее ещё одной башни на старой.
  if (nearby.length >= TOWERS_AROUND_GENERAL) return 'pass';

  const towers = nearby.filter((structure) => structure.kind !== StructureKind.Wall);

  // Стена ставится только когда есть что прикрывать. Стена сама по себе
  // лишь покупает противнику время на обход; стена перед башней —
  // укрепление, потому что башня стреляет поверх неё, а юниты сквозь
  // неё стрелять не могут.
  const shielding = nextBuildNumber() % WALL_EVERY === 0 && towers.length > 0;
  const kind = shielding ? StructureKind.Wall : StructureKind.TowerBasic;
  if (!BUILDABLE_KINDS.includes(kind)) return 'pass';

  const stats = playerStats(player);
  const price = stats.structures[kind].cost + phase.reserve;
  if (player.energy < price) return waitOrPass(price, stats.incomePerTick);

  const radius = stats.general.buildRadius;
  const towerRange = Math.floor(
    stats.structures[StructureKind.TowerBasic].range / FIXED_POINT_SCALE,
  );

  const cell = shielding
    ? shieldBuildCell(world, me, general.position, radius, approach, towers)
    : towerBuildCell(world, me, general.position, radius, approach, towerRange);

  if (cell < 0) return 'pass';

  commands.push(
    command({
      kind: CommandKind.Build,
      player: me,
      tick: asTickNumber(world.tick),
      cell,
      structure: kind,
    }),
  );

  return 'bought';
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

/** Сколько клеток вероятного пути накрывает башня, поставленная в клетку. */
const coverageOf = (approach: Approach, cell: number, rangeCells: number): number => {
  const cx = cellX(cell);
  const cy = cellY(cell);

  let covered = 0;

  for (let dy = -rangeCells; dy <= rangeCells; dy += 1) {
    for (let dx = -rangeCells; dx <= rangeCells; dx += 1) {
      if (dx * dx + dy * dy > rangeCells * rangeCells) continue;

      const x = cx + dx;
      const y = cy + dy;
      if (!isInsideMap(x, y)) continue;

      if (approach.onPath[cellIndex(x, y)] === 1) covered += 1;
    }
  }

  return covered;
};

/**
 * Место под башню: клетка, накрывающая как можно больше вероятного пути.
 *
 * При равном покрытии выбирается ближайшая к чужой базе — так башни
 * сами собой выстраиваются в сторону противника, а не кольцом вокруг
 * генерала.
 *
 * Если накрывать нечего вовсе, место не выбирается и башня не строится.
 * Это не пропуск хода, а отказ от бесполезной покупки: энергия уйдёт
 * на юнитов или прокачку, а генерал тем временем дойдёт до пути —
 * его цель на нём и лежит.
 */
const towerBuildCell = (
  world: WorldState,
  me: PlayerId,
  from: Vec2,
  radius: number,
  approach: Approach,
  rangeCells: number,
): number => {
  const enemyCell = world.map.baseCells[otherPlayer(me)];
  if (enemyCell === undefined) return -1;

  const enemy = cellCentre(enemyCell);

  let best = -1;
  let bestCoverage = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  forEachBuildCandidate(world, approach.occupancy, from, radius, (cell, point) => {
    const coverage = coverageOf(approach, cell, rangeCells);
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
): number => {
  const enemyCell = world.map.baseCells[otherPlayer(me)];
  if (enemyCell === undefined) return -1;

  const enemy = cellCentre(enemyCell);
  const shieldReach = cellsToUnits(SHIELD_RADIUS_CELLS) ** 2;

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
  phase: Phase,
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

  if (bestBranch < 0) return 'pass';

  const price = bestCost + phase.reserve;
  if (player.energy < price) return waitOrPass(price, playerStats(player).incomePerTick);

  commands.push(
    command({
      kind: CommandKind.BuyUpgrade,
      player: me,
      tick: asTickNumber(world.tick),
      branch: bestBranch,
    }),
  );

  return 'bought';
};

// ─────────────────────────────────────────────────────────────────────────
// Ядерный удар
// ─────────────────────────────────────────────────────────────────────────

const tryNuke = (
  commands: Command[],
  world: WorldState,
  me: PlayerId,
  player: PlayerState,
): boolean => {
  if (player.energy < NUKE_COST) return false;

  const bases = world.structures
    .filter((structure) => structure.kind === StructureKind.Base)
    .map((structure) => cellCentre(structure.cell));

  let bestCell = -1;
  let bestCount = NUKE_WORTH_UNITS - 1;

  for (let y = 0; y < MAP_HEIGHT_CELLS; y += NUKE_SCAN_STEP) {
    for (let x = 0; x < MAP_WIDTH_CELLS; x += NUKE_SCAN_STEP) {
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
