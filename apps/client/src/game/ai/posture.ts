import {
  AI_DECISION_INTERVAL_TICKS,
  BASE_HEALTH,
  BASE_INCOME_PER_TICK,
  BASE_UNIT_COST,
  FIXED_POINT_SCALE,
  MAP_CELL_COUNT,
  MATCH_TARGET_SECONDS,
  STRUCTURE_STATS,
  StructureKind,
  TICKS_PER_SECOND,
  cellsToUnits,
  distanceSquared,
} from '@td/shared';
import type { PlayerId, Vec2 } from '@td/shared';
import {
  UNREACHABLE,
  cellCentre,
  cellIndex,
  cellX,
  cellY,
  isInsideMap,
  squaredDistanceToFootprint,
  structureAttack,
} from '@td/sim';
import { cellAt, playerStats } from '@td/sim';
import type { PlayerStats, WorldState } from '@td/sim';
import { otherPlayer, walkField } from './approach.js';
import type { Approach } from './approach.js';

/**
 * Развесовка моделей поведения генерала.
 *
 * Модель ровно одна, но с параметром: «удерживать рубеж на доле *f*
 * вероятного пути». Ноль — своя база, единица — чужая. Оборона и осада
 * не отдельные режимы, а крайние значения доли, и потому сравнимы между
 * собой одной формулой:
 *
 *     оценка = выгода − риск
 *
 * Почему не конечный автомат режимов. Автомат умеет переключаться,
 * но не умеет сравнивать: сказать, что осада сейчас лучше укрепления,
 * ему нечем. Переходы приходится задавать порогами вида «врагов больше
 * трёх», а порог — это дрожь на границе и невозможность объяснить,
 * почему на двух врагах поведение одно, а на трёх другое.
 *
 * Единица измерения — энергия. Она единственная величина в игре, через
 * которую выражено всё: и юниты, и постройки, и прокачка, и доход.
 * У неё есть курс к урону (юнит стоит столько-то и имеет столько-то
 * здоровья) и курс ко времени (доход в тик). Безразмерные очки были бы
 * проще, но их неоткуда вывести — только подобрать, а подобранный вес
 * невозможно объяснить и незачем проверять.
 *
 * Модуль чистый: он ничего не решает и никуда не ходит, а только считает.
 * Проверяется прямыми вызовами, без прогона матча.
 */

// ─────────────────────────────────────────────────────────────────────────
// Курсы: из урона в энергию
// ─────────────────────────────────────────────────────────────────────────

/**
 * Сколько энергии стоит единица урона по живому.
 *
 * Выводится прямо: убив сто здоровья штурмовика, мы отняли у противника
 * ровно то, что он за штурмовика заплатил.
 */
const ENERGY_PER_LIVE_DAMAGE = BASE_UNIT_COST / BASE_HEALTH;

/**
 * Сколько энергии стоит единица урона по вражеской базе.
 *
 * Тем же способом не выводится: база не покупается и цены не имеет.
 * Выводится из другого — из того, что разрушение базы есть победа,
 * а победа стоит всего, что игрок за матч заработает.
 *
 * Получается меньше, чем курс живого, и это не ошибка. У базы пятьдесят
 * тысяч здоровья, одна башня сносила бы её без малого час. Ценность
 * позиции у чужой базы не в том, что башня добьёт базу, а в том,
 * что она расстреливает выходящие войска в самой их гуще.
 */
const ENERGY_PER_BASE_DAMAGE =
  (BASE_INCOME_PER_TICK * TICKS_PER_SECOND * MATCH_TARGET_SECONDS) /
  STRUCTURE_STATS[StructureKind.Base].health;

/**
 * Горизонт планирования: минута.
 *
 * Башня возводится две секунды, значит на этом отрезке успевает окупиться.
 * Брать больше нельзя: за пять минут обстановка меняется до неузнаваемости,
 * и оценка превратилась бы в гадание.
 */
const HORIZON_TICKS = TICKS_PER_SECOND * 60;

/**
 * Сколько тиков генерал проводит под огнём, прежде чем выйдет из-под него.
 *
 * Не выдумано: одно решение на то, чтобы заметить обстрел, плюс время
 * пересечь дальность башни на собственной скорости. От прокачки скорости
 * величина сокращается — так и должно быть.
 */
const escapeTicks = (stats: PlayerStats): number =>
  AI_DECISION_INTERVAL_TICKS +
  STRUCTURE_STATS[StructureKind.TowerBasic].range / Math.max(1, stats.general.speed);

/** Перевод длины пути в клетках во время в тиках на скорости генерала. */
const walkTicks = (cells: number, stats: PlayerStats): number =>
  (cells * FIXED_POINT_SCALE) / Math.max(1, stats.general.speed);

/**
 * Доли вероятного пути, на которых генерал готов встать.
 *
 * Шесть значений, а не непрерывная величина. Непрерывная давала бы
 * новую цель на каждом решении: доля сдвигается на сотую, желаемое
 * расстояние — на клетку, и клетка-цель перескакивает в другой конец
 * коридора. Именно от этого генерал и метался.
 */
export const FRONTIER_FRACTIONS: readonly number[] = [0, 0.15, 0.35, 0.55, 0.75, 0.95];

/**
 * Насколько клетка может отстоять от желаемого расстояния и всё ещё
 * считаться тем же рубежом. Без допуска рубеж вырождался бы в одну
 * клетку, а она запросто окажется непроходимой или уже застроенной.
 */
const BAND_CELLS = 3;

/** Радиус, в котором вражеские юниты считаются угрозой базе, в клетках. */
export const THREAT_RADIUS_CELLS = 10;

// ─────────────────────────────────────────────────────────────────────────
// Входящий урон
// ─────────────────────────────────────────────────────────────────────────

export interface Incoming {
  /** Урон в тик от всего вражеского, достающего до точки. */
  readonly total: number;
  /**
   * Из него — от неподвижных построек.
   *
   * Отделено не для красоты: именно постройки делают рубеж неудерживаемым.
   * Юниты смертны, и рубеж у них отбивают, а башня никуда не денется.
   */
  readonly fromStructures: number;
}

/**
 * Сколько урона в тик получит генерал, оказавшись в точке.
 *
 * Линия огня намеренно не проверяется. Она стоила бы обхода клеток
 * на каждого стрелка, а ошибка от её отсутствия односторонняя
 * и безопасная: опасность переоценивается, и генерал осторожничает там,
 * где мог бы пройти. Обратная ошибка — недооценить обстрел — стоила бы
 * жизни.
 *
 * Характеристики берутся с учётом прокачки противника и личного роста
 * его башен. Подглядыванием это не является: тумана войны в игре нет
 * намеренно, и уровни соперника видны обоим.
 */
export const incomingAt = (
  world: WorldState,
  me: PlayerId,
  enemyStats: PlayerStats,
  point: Vec2,
): Incoming => {
  let fromStructures = 0;
  let fromUnits = 0;
  let fromGeneral = 0;

  for (const structure of world.structures) {
    if (structure.owner === me) continue;
    // Недостроенная постройка ещё не стреляет.
    if (world.tick < structure.builtAtTick) continue;

    const baseline = enemyStats.structures[structure.kind];
    if (baseline.attack <= 0 || baseline.range <= 0) continue;

    const distance = squaredDistanceToFootprint(
      point,
      structure.cell,
      STRUCTURE_STATS[structure.kind].footprintRadius,
    );
    if (distance > baseline.range * baseline.range) continue;

    fromStructures += structureAttack(baseline, structure.growthPpm) / baseline.cooldownTicks;
  }

  for (const unit of world.units) {
    if (unit.owner === me) continue;

    const baseline = enemyStats.units[unit.unitType];
    if (distanceSquared(unit.position, point) > baseline.range * baseline.range) continue;

    fromUnits += baseline.attack / baseline.cooldownTicks;
  }

  for (const general of world.generals) {
    if (general.owner === me || !general.alive) continue;

    const baseline = enemyStats.general;
    if (distanceSquared(general.position, point) > baseline.range * baseline.range) continue;

    fromGeneral += baseline.attack / baseline.cooldownTicks;
  }

  return { total: fromStructures + fromUnits + fromGeneral, fromStructures };
};

// ─────────────────────────────────────────────────────────────────────────
// Покрытие пути
// ─────────────────────────────────────────────────────────────────────────

/** Дальность в клетках: во внутренних единицах она нам здесь не нужна. */
export const rangeInCells = (range: number): number => Math.floor(range / FIXED_POINT_SCALE);

/** Сколько клеток помещается в круг такого радиуса. Знаменатель доли покрытия. */
export const discCellCount = (rangeCells: number): number => {
  let count = 0;

  for (let dy = -rangeCells; dy <= rangeCells; dy += 1) {
    for (let dx = -rangeCells; dx <= rangeCells; dx += 1) {
      if (dx * dx + dy * dy <= rangeCells * rangeCells) count += 1;
    }
  }

  return count;
};

const forEachInDisc = (cell: number, rangeCells: number, visit: (cell: number) => void): void => {
  const cx = cellX(cell);
  const cy = cellY(cell);

  for (let dy = -rangeCells; dy <= rangeCells; dy += 1) {
    for (let dx = -rangeCells; dx <= rangeCells; dx += 1) {
      if (dx * dx + dy * dy > rangeCells * rangeCells) continue;

      const x = cx + dx;
      const y = cy + dy;
      if (!isInsideMap(x, y)) continue;

      visit(cellIndex(x, y));
    }
  }
};

/**
 * Клетки, уже накрытые дальностью живых башен игрока.
 *
 * Отсюда берётся убывающая отдача: покрытие нового места считается только
 * по ненакрытым клеткам, поэтому каждая поставленная башня уменьшает
 * ценность позиции ровно на то, что она накрыла. Прежний счётчик «не
 * больше трёх башен рядом с генералом» врал: три башни в скальном горле
 * и три в чистом поле накрывают совершенно разное.
 */
export const coveredCells = (
  world: WorldState,
  me: PlayerId,
  myStats: PlayerStats,
): Uint8Array => {
  const covered = new Uint8Array(MAP_CELL_COUNT);

  for (const structure of world.structures) {
    if (structure.owner !== me) continue;

    const baseline = myStats.structures[structure.kind];
    if (baseline.attack <= 0 || baseline.range <= 0) continue;

    forEachInDisc(structure.cell, rangeInCells(baseline.range), (cell) => {
      covered[cell] = 1;
    });
  }

  return covered;
};

/** Сколько ещё не накрытых клеток вероятного пути накроет башня в этой клетке. */
export const freshCoverage = (
  approach: Approach,
  covered: Uint8Array,
  cell: number,
  rangeCells: number,
): number => {
  let count = 0;

  forEachInDisc(cell, rangeCells, (inner) => {
    if (approach.onPath[inner] !== 1) return;
    if (covered[inner] === 1) return;

    count += 1;
  });

  return count;
};

// ─────────────────────────────────────────────────────────────────────────
// Рубежи и их оценка
// ─────────────────────────────────────────────────────────────────────────

export interface Frontier {
  /** Доля вероятного пути, которой рубеж соответствует. */
  readonly fraction: number;
  readonly cell: number;
  /** Ненакрытых клеток пути в радиусе башни, поставленной здесь. */
  readonly coverage: number;
}

export interface Verdict {
  readonly frontier: Frontier;
  readonly score: number;
  readonly gain: number;
  readonly risk: number;
  /** Вероятность, что генерал на рубеже погибнет, не успев уйти. */
  readonly deathChance: number;
}

export interface Situation {
  readonly world: WorldState;
  readonly me: PlayerId;
  readonly approach: Approach;
  readonly myStats: PlayerStats;
  readonly enemyStats: PlayerStats;
  /** Здоровье генерала сейчас. Раненый рискует больше — и знает об этом. */
  readonly generalHealth: number;
  readonly homeCell: number;
  readonly enemyBaseCell: number;
  /** Расстояния от генерала по проходимым клеткам: достижимость и дорога. */
  readonly reach: Int32Array;
  readonly covered: Uint8Array;
}

/**
 * Обстановка, из которой считается развесовка.
 *
 * Поле расстояний ОТ генерала считается здесь одним обходом карты и потом
 * служит сразу двум делам: отсеять недостижимые рубежи и оценить дорогу
 * до достижимых. Считать его от каждого рубежа означало бы шесть обходов
 * вместо одного.
 *
 * Возвращает `undefined`, когда решать нечего: генерал мёртв или карта
 * почему-то без баз.
 */
export const situationOf = (
  world: WorldState,
  me: PlayerId,
  approach: Approach,
  myStats: PlayerStats,
  covered: Uint8Array,
): Situation | undefined => {
  const general = world.generals[me];
  if (general === undefined || !general.alive) return undefined;

  const homeCell = world.map.baseCells[me];
  const enemyBaseCell = world.map.baseCells[otherPlayer(me)];
  if (homeCell === undefined || enemyBaseCell === undefined) return undefined;

  const enemy = world.players[otherPlayer(me)];

  return {
    world,
    me,
    approach,
    myStats,
    // Характеристики противника видны: тумана войны в игре нет намеренно.
    // Если игрока почему-то нет, считаем его равным себе — это осторожнее,
    // чем считать безоружным.
    enemyStats: enemy === undefined ? myStats : playerStats(enemy),
    generalHealth: general.health,
    homeCell,
    enemyBaseCell,
    reach: walkField(approach.occupancy, [cellAt(general.position)]),
    covered,
  };
};

/**
 * Рубежи-кандидаты: по одному на каждую долю пути.
 *
 * Из клеток подходящей полосы выбирается та, что даёт наибольшее
 * покрытие ненакрытого пути; ничья — по меньшему индексу клетки, чтобы
 * выбор не зависел от порядка перебора. Недостижимые от генерала клетки
 * отсеиваются здесь же: идти к рубежу, до которого нет дороги, незачем.
 */
export const frontiersOf = (situation: Situation): readonly Frontier[] => {
  const { approach, reach, covered, myStats } = situation;
  const rangeCells = rangeInCells(myStats.structures[StructureKind.TowerBasic].range);

  const wanted = FRONTIER_FRACTIONS.map((fraction) => Math.round(fraction * approach.shortest));
  const best = FRONTIER_FRACTIONS.map(() => ({ cell: -1, coverage: -1 }));

  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    if (approach.onPath[cell] !== 1) continue;
    if ((reach[cell] ?? UNREACHABLE) === UNREACHABLE) continue;

    const fromHome = approach.fromHome[cell] ?? UNREACHABLE;
    if (fromHome === UNREACHABLE) continue;

    let coverage = -1;

    for (let index = 0; index < wanted.length; index += 1) {
      if (Math.abs(fromHome - (wanted[index] ?? 0)) > BAND_CELLS) continue;

      const slot = best[index];
      if (slot === undefined) continue;

      // Покрытие считается лениво: полосы узкие, и большинство клеток
      // карты не попадает ни в одну из них.
      if (coverage < 0) coverage = freshCoverage(approach, covered, cell, rangeCells);
      if (coverage <= slot.coverage) continue;

      slot.cell = cell;
      slot.coverage = coverage;
    }
  }

  const frontiers: Frontier[] = [];

  FRONTIER_FRACTIONS.forEach((fraction, index) => {
    const slot = best[index];
    if (slot === undefined || slot.cell < 0) return;

    frontiers.push({ fraction, cell: slot.cell, coverage: slot.coverage });
  });

  return frontiers;
};

/**
 * Урон в тик, с которым у своей базы справиться некому.
 *
 * Из вражеского напора вычитается огонь собственных башен, стоящих
 * у базы. Без этой поправки генерала тянул бы домой любой одиночный юнит,
 * которого башни и так перекрывают, — а это ровно та глухая оборона,
 * ради ухода от которой всё и затевалось.
 *
 * Оставшаяся разность в потолок не упирается, и это намеренно: чем
 * многочисленнее прорыв, тем сильнее должно тянуть домой. Ограничить
 * величину «тем, что генерал способен добавить» значило бы сделать
 * реакцию на десять прорвавшихся такой же, как на одного.
 */
const pressureOnHome = (situation: Situation): number => {
  const home = cellCentre(situation.homeCell);
  const radius = cellsToUnits(THREAT_RADIUS_CELLS);
  const reach = radius * radius;

  let enemyDamage = 0;
  for (const unit of situation.world.units) {
    if (unit.owner === situation.me) continue;
    if (distanceSquared(unit.position, home) > reach) continue;

    const baseline = situation.enemyStats.units[unit.unitType];
    enemyDamage += baseline.attack / baseline.cooldownTicks;
  }

  let ownDamage = 0;
  for (const structure of situation.world.structures) {
    if (structure.owner !== situation.me) continue;
    if (distanceSquared(cellCentre(structure.cell), home) > reach) continue;

    const baseline = situation.myStats.structures[structure.kind];
    if (baseline.attack <= 0 || baseline.range <= 0) continue;

    ownDamage += structureAttack(baseline, structure.growthPpm) / baseline.cooldownTicks;
  }

  return Math.max(0, enemyDamage - ownDamage);
};

/**
 * Оценка одного рубежа.
 *
 * Выгода — что башня, поставленная на рубеже, уничтожит за время, которое
 * генерал там продержится. Риск — вероятность его гибели, помноженная
 * на её цену.
 *
 * Три тонкости, без которых формула считала бы не то.
 *
 * 1. **Дорога вычитается из горизонта.** В пути генерал ничего не строит,
 *    поэтому дальний рубеж должен окупить не только риск, но и дорогу.
 *    Отсюда берётся инерция: ради малой прибавки генерал никуда
 *    не пойдёт, и отдельного коэффициента липкости, который пришлось бы
 *    подбирать, не нужно.
 *
 * 2. **Рубеж под огнём вражеских ПОСТРОЕК не удерживается.** Продуктивное
 *    время на нём — только время отхода. Огонь вражеских ЮНИТОВ так
 *    не действует: юниты смертны, и рубеж у них отбивают. Без этого
 *    различия генерал никогда не пошёл бы защищать собственную базу —
 *    там ведь тоже стреляют.
 *
 * 3. **У башни один ствол.** Она не может одновременно расстреливать
 *    проходящие войска и бить по базе, поэтому её урон делится между
 *    этими занятиями, а не складывается дважды.
 */
export const scoreFrontier = (situation: Situation, frontier: Frontier): Verdict => {
  const { myStats, enemyStats, approach } = situation;
  const point = cellCentre(frontier.cell);

  const tower = myStats.structures[StructureKind.TowerBasic];
  const towerDps = tower.attack / tower.cooldownTicks;
  const rangeCells = rangeInCells(tower.range);

  // Насколько плотно рубеж стоит на вражеском потоке. Доля покрытия
  // отвечает за «сколько дороги видно», плотность — за «сколько по ней
  // идёт»: войска противника выходят из своей базы в полном составе,
  // а до нашей доходят выжившие.
  const share = Math.min(1, frontier.coverage / Math.max(1, discCellCount(rangeCells)));
  const density =
    approach.shortest <= 0
      ? 0
      : Math.min(1, (approach.fromHome[frontier.cell] ?? 0) / approach.shortest);
  const busy = share * density;

  const reachesEnemyBase =
    squaredDistanceToFootprint(
      point,
      situation.enemyBaseCell,
      STRUCTURE_STATS[StructureKind.Base].footprintRadius,
    ) <=
    tower.range * tower.range;

  const home = cellCentre(situation.homeCell);
  const threatRadius = cellsToUnits(THREAT_RADIUS_CELLS);
  const coversHome = distanceSquared(point, home) <= threatRadius * threatRadius;

  const ratePerTick =
    towerDps * ENERGY_PER_LIVE_DAMAGE * busy +
    (reachesEnemyBase ? towerDps * ENERGY_PER_BASE_DAMAGE * (1 - busy) : 0) +
    (coversHome ? pressureOnHome(situation) * ENERGY_PER_BASE_DAMAGE : 0);

  const escape = escapeTicks(myStats);
  const travel = walkTicks(situation.reach[frontier.cell] ?? 0, myStats);
  const productive = Math.max(0, HORIZON_TICKS - travel);

  const incoming = incomingAt(situation.world, situation.me, enemyStats, point);
  const hold = incoming.fromStructures > 0 ? Math.min(productive, escape) : productive;

  const gain = ratePerTick * hold;

  const deathChance = Math.min(1, (incoming.total * escape) / Math.max(1, situation.generalHealth));

  // Цена гибели — простой на возрождении и дорога обратно, оплаченные
  // доходом: всё это время генерал ничего не строит, и доход некуда деть.
  //
  // Награда за убийство генерала сюда НЕ входит, хотя соблазн велик.
  // Дуэль двух генералов симметрична: сколько противник получит за нашего,
  // столько же мы получили бы за его. Считать один только убыток значит
  // научить противника избегать равного боя — и он избегал бы, потому что
  // награда в двадцать стоимостей юнита перевешивает любую выгоду позиции.
  const returnTicks = walkTicks(approach.fromHome[frontier.cell] ?? 0, myStats);
  const deathCost = (myStats.general.respawnTicks + returnTicks) * myStats.incomePerTick;

  const risk = deathChance * deathCost;

  return { frontier, score: gain - risk, gain, risk, deathChance };
};

/**
 * Лучший рубеж.
 *
 * Обычный случай — наибольшая оценка. Особый случай — когда накрывать
 * нечего нигде: положительной выгоды нет ни у одного рубежа, а значит
 * стоять на месте бессмысленно. Тогда генерал едет к чужой базе, выбирая
 * самый дальний рубеж, гибель на котором не предрешена. По дороге
 * открываются ненакрытые клетки пути, выгода снова становится
 * положительной, и строительство возобновляется само.
 */
export const chooseFrontier = (situation: Situation): Verdict | undefined => {
  const verdicts = frontiersOf(situation).map((frontier) => scoreFrontier(situation, frontier));
  if (verdicts.length === 0) return undefined;

  let best = verdicts[0];
  if (best === undefined) return undefined;

  for (const verdict of verdicts) {
    if (verdict.score > best.score) best = verdict;
  }

  if (best.gain > 0) return best;

  let advance: Verdict | undefined;
  for (const verdict of verdicts) {
    if (verdict.deathChance >= 1) continue;
    if (advance === undefined || verdict.frontier.fraction > advance.frontier.fraction) {
      advance = verdict;
    }
  }

  return advance ?? best;
};
