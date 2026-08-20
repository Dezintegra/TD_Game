import {
  AI_DECISION_INTERVAL_TICKS,
  BUILDABLE_KINDS,
  CommandKind,
  NUKE_BASE_EXCLUSION,
  NUKE_COST,
  NUKE_RADIUS,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  PRODUCTION_QUEUE_CAP,
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
  buildOccupancy,
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
import type { PlayerState, WorldState } from '@td/sim';

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
const THREAT_RADIUS_CELLS = 18;

/** Сколько юнитов у базы противник считает поводом идти домой. */
const THREAT_UNITS = 3;

/** Сколько своих башен рядом с генералом считается достаточным. */
const TOWERS_AROUND_GENERAL = 3;

const CELLS_AROUND_GENERAL = 8;

/** Каждая четвёртая постройка — стена: они создают узкие места. */
const WALL_EVERY = 4;

/** Сколько вражеских юнитов оправдывают ядерный удар. */
const NUKE_WORTH_UNITS = 6;

/** Шаг сетки при поиске места для удара, в клетках. */
const NUKE_SCAN_STEP = 6;

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

export const createOpponent = (me: PlayerId, seed: number): Opponent => {
  // Случайность берётся из детерминированного генератора, а не из
  // Math.random. Формально это не требуется — противник живёт вне ядра, —
  // но благодаря этому матч с фиксированными seed воспроизводится целиком,
  // что бесценно при разборе «почему он вдруг так пошёл».
  let rng = createRng(seed);
  let nextDecisionTick = 0;
  let buildCounter = 0;
  let waitStreak = 0;

  // Отслеживание застревания: если генерал не сдвинулся с места между
  // решениями, он упёрся в скалу, и надо попробовать другое направление.
  let lastGeneralCell = -1;
  let stuckCount = 0;

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

      const player = world.players[me];
      if (player === undefined) return [];

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
                ? tryBuild(commands, world, me, player, phase, () => {
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

      const movement = decideMovement(world, me, roll, trackStuck(world));
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

const decideMovement = (
  world: WorldState,
  me: PlayerId,
  roll: (bound: number) => number,
  stuck: number,
): Command | undefined => {
  const general = world.generals[me];
  if (general === undefined || !general.alive) return undefined;

  // Упёрлись и стоим — пробуем случайное направление, иначе генерал
  // так и останется висеть на углу скалы до конца матча.
  const direction =
    stuck >= 2 ? roll(8) + 1 : directionTowards(...offsetTo(goalOf(world, me), general.position));

  if (direction === general.direction) return undefined;

  return command({
    kind: CommandKind.MoveGeneral,
    player: me,
    tick: asTickNumber(world.tick),
    direction,
  });
};

const offsetTo = (goal: Vec2, from: Vec2): [number, number] => [goal.x - from.x, goal.y - from.y];

/**
 * Куда генерал стремится.
 *
 * Своя база под угрозой — идём домой. Иначе продвигаемся к фронту:
 * точке между базами, которая со временем сдвигается в сторону чужой.
 * Дальше середины противник не заходит: генерал — не штурмовой отряд,
 * а строитель, и терять его в чужом тылу невыгодно.
 */
const goalOf = (world: WorldState, me: PlayerId): Vec2 => {
  const homeCell = world.map.baseCells[me];
  const enemyCell = world.map.baseCells[otherPlayer(me)];
  if (homeCell === undefined || enemyCell === undefined) return { x: 0, y: 0 };

  const home = cellCentre(homeCell);
  const enemy = cellCentre(enemyCell);

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

  return {
    x: Math.round(home.x + (enemy.x - home.x) * progress),
    y: Math.round(home.y + (enemy.y - home.y) * progress),
  };
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
  nextBuildNumber: () => number,
): Attempt => {
  const general = world.generals[me];
  if (general === undefined || !general.alive) return 'pass';

  const nearby = world.structures.filter(
    (structure) =>
      structure.owner === me &&
      structure.kind !== StructureKind.Base &&
      distanceSquared(cellCentre(structure.cell), general.position) <=
        cellsToUnits(CELLS_AROUND_GENERAL) ** 2,
  ).length;

  // Плотнее строить смысла нет: генерал всё равно уйдёт вперёд,
  // и новая позиция окажется полезнее ещё одной башни на старой.
  if (nearby >= TOWERS_AROUND_GENERAL) return 'pass';

  const number = nextBuildNumber();
  const kind = number % WALL_EVERY === 0 ? StructureKind.Wall : StructureKind.TowerBasic;
  if (!BUILDABLE_KINDS.includes(kind)) return 'pass';

  const stats = playerStats(player);
  const price = stats.structures[kind].cost + phase.reserve;
  if (player.energy < price) return waitOrPass(price, stats.incomePerTick);

  const cell = forwardBuildCell(world, me, general.position, stats.general.buildRadius);
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
 * Свободная клетка в радиусе строительства, самая близкая к чужой базе.
 *
 * Выбор «ближайшей к врагу» превращает строительство в наступательное:
 * башни сами собой выстраиваются в сторону противника, а не кольцом
 * вокруг генерала.
 */
const forwardBuildCell = (world: WorldState, me: PlayerId, from: Vec2, radius: number): number => {
  const enemyCell = world.map.baseCells[otherPlayer(me)];
  if (enemyCell === undefined) return -1;

  const enemy = cellCentre(enemyCell);
  const occupancy = buildOccupancy(world.map, world.structures);

  const centre = cellAt(from);
  const reach = Math.floor(radius / FIXED_POINT_SCALE);

  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let dy = -reach; dy <= reach; dy += 1) {
    for (let dx = -reach; dx <= reach; dx += 1) {
      const x = cellX(centre) + dx;
      const y = cellY(centre) + dy;
      if (x < 0 || y < 0 || x >= MAP_WIDTH_CELLS || y >= MAP_HEIGHT_CELLS) continue;

      const cell = cellIndex(x, y);
      if (occupancy.blocked[cell] === 1) continue;

      const point = cellCentre(cell);
      // Клетка должна быть действительно в радиусе: квадрат перебора
      // описан вокруг круга и по углам из него выходит.
      if (distanceSquared(point, from) > radius * radius) continue;

      const distance = distanceSquared(point, enemy);
      if (distance >= bestDistance) continue;

      bestDistance = distance;
      best = cell;
    }
  }

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
