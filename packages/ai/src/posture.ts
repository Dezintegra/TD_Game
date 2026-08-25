import {
  AI_DECISION_INTERVAL_TICKS,
  BASE_HEALTH,
  BASE_INCOME_PER_TICK,
  BASE_UNIT_COST,
  FIXED_POINT_SCALE,
  MAP_CELL_COUNT,
  MATCH_TARGET_SECONDS,
  PPM_ONE,
  STRUCTURE_STATS,
  StructureKind,
  TICKS_PER_SECOND,
  VETERAN_RANK_KILLS,
  cellsToUnits,
  distanceSquared,
  veteranStructurePpmOf,
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
import { horizonTicks } from './profile.js';
import type { AiProfile } from './profile.js';

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
export const ENERGY_PER_LIVE_DAMAGE = BASE_UNIT_COST / BASE_HEALTH;

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
 * Цена гибели генерала в энергии.
 *
 * Простой на возрождении и дорога обратно, оплаченные доходом: всё это
 * время генерал ничего не строит, и доход некуда деть.
 *
 * Награда противнику за убийство сюда НЕ входит, хотя соблазн велик.
 * Дуэль двух генералов симметрична: сколько противник получит за нашего,
 * столько же мы получили бы за его. Считать один только убыток значит
 * научить противника избегать равного боя — и он избегал бы, потому что
 * награда в двадцать стоимостей юнита перевешивает любую выгоду позиции.
 *
 * Вынесено наружу, чтобы оценка ядерного удара пользовалась той же ценой,
 * а не заводила вторую: две цены гибели немедленно разошлись бы.
 */
export const generalDeathCost = (stats: PlayerStats, returnCells: number): number =>
  (stats.general.respawnTicks + walkTicks(returnCells, stats)) * stats.incomePerTick;

// Доли вероятного пути, допуск полосы, радиус угрозы базе и горизонт
// планирования переехали в профиль поведения (`profile.ts`): это настройка,
// которую сравнивают между вариантами, а не свойство формулы.

// ─────────────────────────────────────────────────────────────────────────
// Входящий урон
// ─────────────────────────────────────────────────────────────────────────

/**
 * Куда идут вражеские войска.
 *
 * У игрока одна общая цель для всех юнитов, и она лежит в его состоянии.
 * Если цели почему-то нет, берётся наша база: именно туда войска пойдут
 * по умолчанию, и ядро само их туда перенацелит.
 */
const enemyTargetPoint = (world: WorldState, me: PlayerId): Vec2 | undefined => {
  const enemy = world.players[otherPlayer(me)];
  const target = world.structures.find((structure) => structure.id === enemy?.targetStructure);
  if (target !== undefined) return cellCentre(target.cell);

  const home = world.map.baseCells[me];

  return home === undefined ? undefined : cellCentre(home);
};

/**
 * На сколько юнит успеет приблизиться к точке за отведённое время.
 *
 * Ноль, если точка не лежит у него на пути: юнит идёт к своей цели,
 * а не к нашему рубежу, и считать, что каждый вражеский юнит бежит
 * именно к нам, значило бы завысить опасность настолько, что генерал
 * не вышел бы из дома.
 *
 * «Лежит на пути» проверяется просто: точка ближе к цели войск, чем сам
 * юнит. Мерка грубая, но ошибается в безопасную сторону — она пропускает
 * тех, кто идёт мимо, и никогда не пропускает идущих прямо на нас.
 */
const approachDistance = (
  unit: { readonly position: Vec2 },
  point: Vec2,
  target: Vec2 | undefined,
  speed: number,
  ticks: number,
): number => {
  if (ticks <= 0 || target === undefined) return 0;
  if (distanceSquared(point, target) >= distanceSquared(unit.position, target)) return 0;

  return speed * ticks;
};

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
 *
 * `withinTicks` — за сколько тиков обстановка успеет измениться. Ноль
 * означает «прямо сейчас», и такой вызов повторяет прежнее поведение.
 * При положительном значении в счёт идут ещё две вещи, каждая из которых
 * раньше молча занижала опасность:
 *
 * - постройка, которая **достроится** за это время. Заложенная башня
 *   не стреляет в момент решения и потому не входила в урон вовсе —
 *   а к приходу генерала уже стреляет;
 * - войска, которые **дойдут** до точки за это время. Снимок «кто сейчас
 *   в радиусе» устаревает раньше, чем генерал доходит, и пустой рубеж,
 *   к которому подходит десяток штурмовиков, считался безопасным.
 */
export const incomingAt = (
  world: WorldState,
  me: PlayerId,
  enemyStats: PlayerStats,
  point: Vec2,
  withinTicks = 0,
): Incoming => {
  let fromStructures = 0;
  let fromUnits = 0;
  let fromGeneral = 0;

  for (const structure of world.structures) {
    if (structure.owner === me) continue;
    // Недостроенная постройка не стреляет — но та, что достроится раньше,
    // чем генерал уйдёт, стреляет по нему наверняка.
    if (world.tick + withinTicks < structure.builtAtTick) continue;

    const baseline = enemyStats.structures[structure.kind];
    if (baseline.attack <= 0 || baseline.range <= 0) continue;

    const distance = squaredDistanceToFootprint(
      point,
      structure.cell,
      STRUCTURE_STATS[structure.kind].footprintRadius,
    );
    if (distance > baseline.range * baseline.range) continue;

    fromStructures += structureAttack(baseline, structure.kills) / baseline.cooldownTicks;
  }

  // Куда идут вражеские войска, известно: у игрока одна общая цель
  // для всех юнитов. Направление берётся отсюда, а не угадывается.
  const enemyTarget = enemyTargetPoint(world, me);

  for (const unit of world.units) {
    if (unit.owner === me) continue;

    const baseline = enemyStats.units[unit.unitType];
    const reach =
      baseline.range + approachDistance(unit, point, enemyTarget, baseline.speed, withinTicks);
    if (distanceSquared(unit.position, point) > reach * reach) continue;

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
export const coveredCells = (world: WorldState, me: PlayerId, myStats: PlayerStats): Uint8Array => {
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

/**
 * Пометить накрытым всё, до чего достанет башня из этой клетки.
 *
 * Нужна там, где башня уже заказана, но в мире её ещё нет: `coveredCells`
 * обходит `world.structures`, а команда постройки попадёт туда только
 * после `step`. Без такой пометки вторая башня одного решения считала бы
 * своей заслугой то, что накрыла первая, и обе вставали бы в одно место.
 */
export const markCovered = (covered: Uint8Array, cell: number, rangeCells: number): void => {
  forEachInDisc(cell, rangeCells, (inner) => {
    covered[inner] = 1;
  });
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
// Взаимное прикрытие своих башен
// ─────────────────────────────────────────────────────────────────────────

/** Своя стреляющая постройка: всё, что нужно знать о ней для прикрытия. */
export interface FriendlyTower {
  readonly cell: number;
  readonly damagePerTick: number;
  readonly rangeCells: number;
}

/**
 * Свои стреляющие постройки — клеткой, уроном в тик и дальностью.
 *
 * Клетками, а не постройками, потому что башню, заказанную этим же
 * решением, объекта в мире ещё не имеющую, прикрывать уже осмысленно:
 * она появится в `world.structures` только после `step`. Ничего, кроме
 * этих трёх величин, для счёта прикрытия и не нужно.
 */
export const ownTowers = (
  world: WorldState,
  me: PlayerId,
  myStats: PlayerStats,
): FriendlyTower[] => {
  const towers: FriendlyTower[] = [];

  for (const structure of world.structures) {
    if (structure.owner !== me) continue;

    const baseline = myStats.structures[structure.kind];
    if (baseline.attack <= 0 || baseline.range <= 0) continue;

    towers.push({
      cell: structure.cell,
      // Ветеранский ранг в счёт: башня, набравшая убийства, прикрывает
      // соседей сильнее, и это ровно то, ради чего ранг заведён.
      damagePerTick: structureAttack(baseline, structure.kills) / baseline.cooldownTicks,
      rangeCells: rangeInCells(baseline.range),
    });
  }

  return towers;
};

/**
 * Дружественный огонь по каждой клетке карты: суммарный урон в тик своих
 * башен, достающих до неё.
 *
 * Зеркало `incomingAt`, только про своих, только про постройки и разом
 * по всей карте. Поле считается ОДИН раз на решение и потом читается
 * по клетке: башен единицы, кандидатов на место десятки, и считать
 * прикрытие каждому кандидату отдельным перебором башен значило бы
 * умножать одну и ту же работу.
 *
 * Юниты в счёт не идут намеренно. Прикрытие меряется для места, где башня
 * простоит минуты, а войско к тому времени уйдёт; считать его прикрытием
 * значило бы обещать башне защиту, которой к её первому бою уже не будет.
 *
 * Линия огня не проверяется — по той же причине, что и в `incomingAt`:
 * она стоила бы обхода клеток на каждого стрелка. Но ошибка здесь
 * направлена в другую сторону: прикрытие ПЕРЕОЦЕНИВАЕТСЯ, то есть место
 * за скалой выглядит защищённее, чем оно есть. Цена ошибки — неудачно
 * поставленная башня, а не погибший генерал, и потому она приемлема там,
 * где обратная была бы недопустима.
 */
export const coverField = (towers: readonly FriendlyTower[]): Float64Array => {
  const field = new Float64Array(MAP_CELL_COUNT);

  for (const tower of towers) {
    forEachInDisc(tower.cell, tower.rangeCells, (cell) => {
      field[cell] = (field[cell] ?? 0) + tower.damagePerTick;
    });
  }

  return field;
};

/**
 * Дописать в поле прикрытия башню, которой в мире ещё нет.
 *
 * Нужна там же, где `markCovered`: башня, заказанная этим решением,
 * появится в `world.structures` только после `step`, а прикрывает она
 * соседей уже по-настоящему. Без этой поправки вторая башня группы
 * считала бы себя одинокой.
 */
export const addCover = (
  field: Float64Array,
  cell: number,
  damagePerTick: number,
  rangeCells: number,
): void => {
  forEachInDisc(cell, rangeCells, (inner) => {
    field[inner] = (field[inner] ?? 0) + damagePerTick;
  });
};

/**
 * Взаимное прикрытие места: сколько огня встретит атакующего там, куда
 * будет стрелять новая башня.
 *
 * ## Меряется поле огня, а не клетка башни
 *
 * Соблазнительно спросить «сколько своих достаёт до этой клетки» —
 * и это была бы ошибка, причём ровно та, от которой изменение уходит.
 * Такая величина СТУПЕНЧАТА: сосед либо достаёт, либо нет, и «сравнение»
 * вырождается в порог «не дальше дальности башни». А порог — это и есть
 * запрещённое правило «ставить не дальше N клеток от своей», то самое,
 * что уже жило здесь под именем «не больше трёх башен рядом» и врало.
 *
 * Поэтому прикрытие меряется по КЛЕТКАМ ВЕРОЯТНОГО ПУТИ в круге новой
 * башни — по тем самым, куда она будет стрелять и где будет стоять
 * атакующий. Перекрытие полей огня убывает плавно по мере расхождения
 * башен, и сравнение остаётся сравнением.
 *
 * ## Два слагаемых, оба — урон в тик
 *
 * - **полученное**: средний дружественный урон по клеткам своего поля
 *   огня. Атакующий, подошедший к новой башне, получит ещё и его;
 * - **отданное**: собственный урон башни, помноженный на долю её поля
 *   огня, которую уже простреливают свои. Это та же величина в обратную
 *   сторону — насколько новая башня усиливает уже стоящих.
 *
 * Обе величины суть урон в тик, которым встречают атакующего, поэтому
 * складываются напрямую.
 *
 * Ноль, если стрелять не по кому: клеток пути в круге нет вовсе.
 */
export const siteCover = (
  approach: Approach,
  field: Float64Array,
  cell: number,
  damagePerTick: number,
  rangeCells: number,
): number => {
  let onPath = 0;
  let friendly = 0;
  let shared = 0;

  forEachInDisc(cell, rangeCells, (inner) => {
    if (approach.onPath[inner] !== 1) return;

    onPath += 1;

    const here = field[inner] ?? 0;
    if (here <= 0) return;

    friendly += here;
    shared += 1;
  });

  if (onPath === 0) return 0;

  return friendly / onPath + (damagePerTick * shared) / onPath;
};

// ─────────────────────────────────────────────────────────────────────────
// Цена покупки: чего стоит башня сама по себе
// ─────────────────────────────────────────────────────────────────────────

/**
 * Средний множитель ветеранского ранга башни за горизонт планирования.
 *
 * Башня набирает ранги за убийства и к пятнадцатому убийству становится
 * вдвое сильнее. Пока рост не учитывался, башня мерилась чужой меркой —
 * и проигрывала сравнение, которое на деле выигрывает.
 *
 * Число убийств выводится, а не задаётся: столько, сколько башня успеет
 * при своём уроне за горизонт, считая по здоровью опорного юнита.
 * Множитель берётся СРЕДНИЙ за горизонт, а не конечный, потому что
 * усиливается башня постепенно: к концу горизонта она может быть вдвое
 * сильнее, но большую часть времени была слабее.
 *
 * Считается точно, а не приближением. Множитель кусочно-постоянен —
 * он меняется на порогах рангов, — поэтому среднее это сумма
 * «значение × длина куска», делённая на число убийств. Прежде здесь
 * стояло среднее геометрической прогрессии: рост был непрерывным,
 * и формула для него годилась. Ступенчатому росту она уже не подходит.
 *
 * Оценка занижена дважды, и оба раза намеренно. Убийства считаются
 * по паспортному урону, хотя растущая башня убивает быстрее; опорным
 * берётся базовое здоровье, хотя противник качает прочность. Ошибаться
 * здесь следует в сторону осторожности: башня и без того выходит самой
 * выгодной покупкой.
 *
 * Потолок соблюдается сам собой: выше пятого ранга таблица не идёт.
 */
export const towerGrowthFactor = (damagePerTick: number, horizon: number): number => {
  const kills = (damagePerTick * horizon) / BASE_HEALTH;
  if (kills <= 0) return 1;

  let weighted = 0;
  let from = 0;

  // Пороги плюс само число убийств как последняя граница: последний
  // кусок обрывается там, где горизонт кончился.
  for (const threshold of [...VETERAN_RANK_KILLS, kills]) {
    const to = Math.min(threshold, kills);
    if (to <= from) continue;

    weighted += (veteranStructurePpmOf(from) / PPM_ONE) * (to - from);
    from = to;

    if (from >= kills) break;
  }

  return weighted / kills;
};

/**
 * Прибавка от ПОКУПКИ башни в энергии — то, с чем сравниваются юнит
 * и прокачка.
 *
 * Считается тем же выражением, что и прибавка от юнита в `value.ts`:
 * урон в тик, помноженный на горизонт и на курс энергии за единицу урона.
 * Иначе сравнивать покупки между собой было бы нельзя — а вся развесовка
 * трат ровно на этом сравнении и стоит.
 *
 * ## Чем это отличается от выгоды рубежа
 *
 * Тем, что отвечает на другой вопрос. `scoreFrontier` спрашивает, куда
 * идти генералу, и потому вычитает дорогу и обрезает время удержания
 * рубежа временем отхода. К покупке башни обе величины отношения
 * не имеют: башня не идёт никуда и не уходит вместе с генералом.
 * Под огнём вражеских башен рубеж генералу не удержать — а поставленная
 * там своя башня стоит и стреляет.
 *
 * Пока покупка мерилась выгодой рубежа, из этого следовала чепуха: башня
 * ровно там, где она нужнее всего, оценивалась почти в ноль.
 *
 * ## Множитель ровно один
 *
 * Доля накрытого пути, и только она: башня стреляет по тому, что идёт
 * мимо неё. Второго множителя — удалённости от своей базы — здесь нет
 * намеренно. В оценке рубежа он осмыслен (войска выходят из чужой базы
 * в полном составе, а до нашей доходят выжившие, и генералу стоит идти
 * навстречу), но применённый к покупке он обращает в ноль стоимость
 * башни у собственной базы — той самой, что расстреливает прорвавшихся
 * в двух шагах от командного центра. Именно это удвоение и названо
 * в `value.ts` бедой мерки.
 */
export const towerGain = (coverage: number, stats: PlayerStats, profile: AiProfile): number => {
  const tower = stats.structures[StructureKind.TowerBasic];
  if (tower.attack <= 0 || tower.range <= 0) return 0;

  const share = Math.min(1, coverage / Math.max(1, discCellCount(rangeInCells(tower.range))));
  if (share <= 0) return 0;

  const damagePerTick = tower.attack / Math.max(1, tower.cooldownTicks);
  const horizon = horizonTicks(profile);

  return (
    damagePerTick *
    horizon *
    ENERGY_PER_LIVE_DAMAGE *
    share *
    towerGrowthFactor(damagePerTick, horizon)
  );
};

/**
 * Плотность вражеского потока в клетке: доля пути, пройденная войсками
 * противника от их базы до неё.
 *
 * Ноль у своей базы, единица у чужой. Смысл в том, что войска выходят
 * из базы в полном составе, а доходят выжившие: чем ближе к их дому,
 * тем гуще поток и тем больше целей у башни.
 *
 * Величина одна на оценку рубежа и на выбор места под постройку —
 * намеренно. Две плотности, посчитанные по-разному, немедленно
 * разошлись бы, и объяснить, почему генерал идёт на один рубеж, а башню
 * ставит по другой мерке, стало бы нечем.
 */
export const flowDensity = (approach: Approach, cell: number): number =>
  approach.shortest <= 0 ? 0 : Math.min(1, (approach.fromHome[cell] ?? 0) / approach.shortest);

/**
 * Ценность МЕСТА под башню: покрытие пути плюс прибавка к живучести.
 *
 * ## Зачем понадобилось второе слагаемое
 *
 * Прежде место выбиралось по одному покрытию, а покрытие считается
 * по ЕЩЁ НЕ накрытым клеткам пути. Из этого прямо следует, что лучшее
 * место — всегда подальше от своих: накрытые ими клетки вычитаются.
 * В мерку была встроена сила, расталкивающая башни, и разброс оказался
 * не случайностью, а замыслом алгоритма. Расплата — две трети башен,
 * потерянных за матч: одиночную сносит толпа.
 *
 * ## Почему величина, а не правило
 *
 * Соблазн велик и его надо отвергнуть явно: правило «ставить не дальше
 * двух клеток от своей башни» — это возврат к счётчику «не больше трёх
 * башен рядом с генералом», который в этом файле уже жил и уже врал.
 * Три башни в скальном горле и три в чистом поле накрывают совершенно
 * разное, и никакой порог этой разницы не знает.
 *
 * Тяга к своим должна быть величиной, которую СРАВНИВАЮТ. Тогда в горле
 * башни соберутся в кучу — там и путь узок, и прикрытие плотное, —
 * а в чистом поле разойдутся, потому что покрытие растёт при удалении
 * быстрее, чем падает прикрытие. Выйдет это само, без единого порога.
 *
 * ## Откуда взялся множитель живучести
 *
 * Не подобран. Атакующие с общим запасом здоровья `A` гибнут у башни
 * за `A / (D + C)` тиков, где `D` — урон самой башни, `C` — урон
 * прикрывающих её соседей. Значит башня переживает во столько же раз
 * больше волн, во сколько суммарный огонь больше её собственного:
 *
 *     множитель живучести = (D + C) / D
 *
 * А башня, живущая вдвое дольше, стоит вдвое дороже как вложение.
 * Отсюда и вид формулы: выгода от покрытия плюс та же выгода,
 * помноженная на отношение прикрытия к своему урону. Новых курсов
 * не заводится: `towerGain` уже переводит урон в энергию теми же
 * курсами, которыми меряется всё остальное в развесовке.
 */
export const siteValue = (
  coverage: number,
  mutualCover: number,
  stats: PlayerStats,
  profile: AiProfile,
): number => {
  const gain = towerGain(coverage, stats, profile);
  if (gain <= 0) return 0;

  const tower = stats.structures[StructureKind.TowerBasic];
  const damagePerTick = tower.attack / Math.max(1, tower.cooldownTicks);
  if (damagePerTick <= 0) return gain;

  return gain + gain * (mutualCover / damagePerTick);
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
  /** Настройка, по которой оцениваются рубежи. */
  readonly profile: AiProfile;
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
  profile: AiProfile,
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
    profile,
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
  const { approach, reach, covered, myStats, profile } = situation;
  const rangeCells = rangeInCells(myStats.structures[StructureKind.TowerBasic].range);
  const fractions = profile.posture.frontierFractions;

  const wanted = fractions.map((fraction) => Math.round(fraction * approach.shortest));
  const best = fractions.map(() => ({ cell: -1, coverage: -1 }));

  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    if (approach.onPath[cell] !== 1) continue;
    if ((reach[cell] ?? UNREACHABLE) === UNREACHABLE) continue;

    const fromHome = approach.fromHome[cell] ?? UNREACHABLE;
    if (fromHome === UNREACHABLE) continue;

    let coverage = -1;

    for (let index = 0; index < wanted.length; index += 1) {
      if (Math.abs(fromHome - (wanted[index] ?? 0)) > profile.posture.bandCells) continue;

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

  fractions.forEach((fraction, index) => {
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
  const radius = cellsToUnits(situation.profile.posture.threatRadiusCells);
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

    ownDamage += structureAttack(baseline, structure.kills) / baseline.cooldownTicks;
  }

  return Math.max(0, enemyDamage - ownDamage);
};

/**
 * Клетки проб вдоль дороги генерала к рубежу, от генерала к рубежу.
 *
 * Берутся спуском по градиенту поля расстояний ОТ генерала — тем же
 * способом, каким генерал и пойдёт. Прямая между двумя точками здесь
 * не годится: она проходит сквозь скалы и застройку, а генерал идёт
 * в обход, и опасен ему именно обход.
 *
 * Спуск идёт от рубежа к генералу (значения поля убывают), поэтому
 * порядок в конце разворачивается: вызывающему нужна дорога в ту сторону,
 * в которую он пойдёт, — от неё зависит, когда он окажется в каждой точке.
 */
export const probeRoute = (reach: Int32Array, from: number, probes: number): readonly number[] => {
  if (probes <= 0) return [];

  const route: number[] = [];
  let current = from;

  // Предохранитель на число шагов: поле убывает строго, поэтому цикл
  // конечен по построению, но цикл без верхней границы — приглашение
  // к зависанию, если поле однажды окажется испорченным.
  for (let step = 0; step < MAP_CELL_COUNT; step += 1) {
    route.push(current);

    const here = reach[current] ?? UNREACHABLE;
    if (here <= 0) break;

    const cx = cellX(current);
    const cy = cellY(current);

    let next = -1;
    let best = here;

    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;

        const x = cx + dx;
        const y = cy + dy;
        if (!isInsideMap(x, y)) continue;

        const cell = cellIndex(x, y);
        const value = reach[cell] ?? UNREACHABLE;
        if (value >= best) continue;

        best = value;
        next = cell;
      }
    }

    if (next < 0) break;
    current = next;
  }

  route.reverse();

  if (route.length <= probes) return route;

  // Пробы раскладываются равномерно по дороге. Последней всегда остаётся
  // клетка рубежа: она и есть место, где генерал остановится.
  const picked: number[] = [];
  for (let index = 1; index <= probes; index += 1) {
    const at = Math.min(route.length - 1, Math.round((route.length - 1) * (index / probes)));
    const cell = route[at];
    if (cell !== undefined) picked.push(cell);
  }

  return picked;
};

/**
 * Урон, накопленный генералом по дороге к рубежу.
 *
 * Накапливается по отрезкам, а не усредняется, и разница принципиальна:
 * генерал проходит КАЖДЫЙ отрезок целиком, поэтому простреливаемый кусок
 * в середине не должен размываться безопасными краями. Усреднение
 * превратило бы дорогу, наполовину идущую под огнём башни, в дорогу
 * с половинной опасностью — а генерал получит на ней полный урон,
 * просто в течение половины времени.
 *
 * Опасность каждой пробы считается на тот тик, когда генерал до неё
 * дойдёт: за это время достроятся башни и подойдут войска.
 */
const roadDamage = (situation: Situation, frontier: Frontier, travelTicks: number): number => {
  const probes = probeRoute(situation.reach, frontier.cell, situation.profile.posture.pathProbes);
  if (probes.length === 0 || travelTicks <= 0) return 0;

  const perSegment = travelTicks / probes.length;

  let damage = 0;
  probes.forEach((cell, index) => {
    const arrival = perSegment * (index + 1);
    const incoming = incomingAt(
      situation.world,
      situation.me,
      situation.enemyStats,
      cellCentre(cell),
      arrival,
    );

    damage += incoming.total * perSegment;
  });

  return damage;
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
  const density = flowDensity(approach, frontier.cell);
  const busy = share * density;

  const reachesEnemyBase =
    squaredDistanceToFootprint(
      point,
      situation.enemyBaseCell,
      STRUCTURE_STATS[StructureKind.Base].footprintRadius,
    ) <=
    tower.range * tower.range;

  const home = cellCentre(situation.homeCell);
  const threatRadius = cellsToUnits(situation.profile.posture.threatRadiusCells);
  const coversHome = distanceSquared(point, home) <= threatRadius * threatRadius;

  const ratePerTick =
    towerDps * ENERGY_PER_LIVE_DAMAGE * busy +
    (reachesEnemyBase ? towerDps * ENERGY_PER_BASE_DAMAGE * (1 - busy) : 0) +
    (coversHome ? pressureOnHome(situation) * ENERGY_PER_BASE_DAMAGE : 0);

  const escape = escapeTicks(myStats);
  const travel = walkTicks(situation.reach[frontier.cell] ?? 0, myStats);
  const productive = Math.max(0, horizonTicks(situation.profile) - travel);

  // Опасность на самом рубеже считается на момент прихода: за время
  // дороги достроятся заложенные башни и подойдут войска.
  const incoming = incomingAt(situation.world, situation.me, enemyStats, point, travel + escape);
  const hold = incoming.fromStructures > 0 ? Math.min(productive, escape) : productive;

  const gain = ratePerTick * hold;

  // Гибнет генерал не только СТОЯ на рубеже, но и ИДЯ к нему. Прежняя
  // оценка считала только точку назначения и потому объявляла гибель
  // невозможной в 88% решений — при том, что пятую часть матча генерал
  // проводил мёртвым. Дорога добавляется к урону на месте, а не заменяет
  // его: обе опасности реальны и складываются.
  const taken = roadDamage(situation, frontier, travel) + incoming.total * escape;
  const deathChance = Math.min(1, taken / Math.max(1, situation.generalHealth));

  const risk = deathChance * generalDeathCost(myStats, approach.fromHome[frontier.cell] ?? 0);

  return { frontier, score: gain - risk, gain, risk, deathChance };
};

/**
 * Оценки всех рубежей-кандидатов.
 *
 * Отделено от выбора не для красоты. Разбор поведения требует знать
 * оценки ВСЕХ рубежей, а не только победившего: если выбранный обошёл
 * соседний на два процента, это дрожь, а не решение, и лечится она совсем
 * не тем, чем «выбрал не тот рубеж». Противник считает их все и так —
 * отдельная функция лишь позволяет забрать посчитанное, не считая заново.
 */
export const rankFrontiers = (situation: Situation): readonly Verdict[] =>
  frontiersOf(situation).map((frontier) => scoreFrontier(situation, frontier));

/**
 * Выбор лучшего из оценённых.
 *
 * Обычный случай — наибольшая оценка. Особый случай — когда накрывать
 * нечего нигде: положительной выгоды нет ни у одного рубежа, а значит
 * стоять на месте бессмысленно. Тогда генерал едет к чужой базе, выбирая
 * самый дальний рубеж, гибель на котором не предрешена. По дороге
 * открываются ненакрытые клетки пути, выгода снова становится
 * положительной, и строительство возобновляется само.
 */
export const pickVerdict = (verdicts: readonly Verdict[]): Verdict | undefined => {
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

/**
 * Лучший рубеж — оценить кандидатов и выбрать.
 *
 * Обёртка над двумя шагами выше. Существует потому, что вызывающему
 * обычно нужен только результат; разбору поведения нужны и оценки,
 * и он берёт их отдельно, не считая ничего заново.
 */
export const chooseFrontier = (situation: Situation): Verdict | undefined =>
  pickVerdict(rankFrontiers(situation));
