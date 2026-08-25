import {
  BlastKind,
  DIRECTION_STOP,
  FIXED_POINT_SCALE,
  GENERAL_KILL_REWARD,
  GENERAL_WEAPON,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  SPLASH_FULL_RADIUS,
  SPLASH_OUTER_DIVISOR,
  SPLASH_OUTER_RADIUS,
  STRUCTURE_STATS,
  STRUCTURE_WEAPON,
  ShotSide,
  ShotWeapon,
  StructureKind,
  UNIT_INDIRECT_FIRE,
  UNIT_STATS,
  UNIT_WEAPON,
  asTickNumber,
  directionTowards,
  isArmedStructure,
  veteranRank,
} from '@td/shared';
import type { PlayerId, UnitType, Vec2 } from '@td/shared';
import { cellAt, cellCentre, squaredDistanceToFootprint } from './map.js';
import { hasLineOfSight } from './sight.js';
import {
  statsOf,
  structureAttack,
  structureMaxHealth,
  unitAttack,
  unitMaxHealth,
} from './stats.js';
import type { PlayerStats } from './stats.js';
import { position, recordBlast, recordShot, structurePosition } from './working.js';
import type { Working, WorkingGeneral, WorkingStructure, WorkingUnit } from './working.js';

/**
 * Бой.
 *
 * Попадание мгновенное: снаряда в полёте не существует. Альтернатива
 * со снарядами добавила бы сущностей больше, чем самих юнитов — при двухстах
 * стреляющих и секундной перезарядке в воздухе висели бы сотни снарядов, —
 * а взамен принесла бы только промахи по движущейся цели. Промахи в игре
 * с полной информацией и без укрытий это шум, а не тактика.
 */

export const TargetKind = {
  Unit: 0,
  Structure: 1,
  General: 2,
} as const;

export type TargetKind = (typeof TargetKind)[keyof typeof TargetKind];

export interface Target {
  readonly kind: TargetKind;
  /** Индекс в соответствующем массиве рабочего состояния. */
  readonly index: number;
}

/** Кто стреляет. От этого зависят награды и рост силы. */
export const ShooterKind = {
  Unit: 0,
  Structure: 1,
  General: 2,
} as const;

export type ShooterKind = (typeof ShooterKind)[keyof typeof ShooterKind];

// ─────────────────────────────────────────────────────────────────────────
// Пространственный индекс
// ─────────────────────────────────────────────────────────────────────────

/**
 * Размер корзины индекса в клетках.
 *
 * Перебирать всех врагов для каждого стрелка — это двести на двести
 * сравнений за тик только среди юнитов, шесть миллионов проверок
 * расстояния в секунду. Корзины сводят перебор к соседям.
 *
 * Восемь клеток выбраны под самую большую БАЗОВУЮ дальность в игре —
 * её держит снайперская башня, и после её снижения до восьми клеток
 * размер корзины с этой дальностью совпал ровно. Непрокачанный запрос
 * покрывается сеткой три на три корзины, а сама сетка остаётся
 * маленькой — 6 × 6.
 *
 * Слова «самая большая дальность в игре» здесь когда-то стояли
 * без оговорки, и это было обещание, которого больше нет. Дальность
 * прокачивается — у башен, а теперь и у снайпера с Теслой, — и сверху
 * не ограничена ничем, кроме цены: у стрелков ветка дорожает
 * на двадцать пять процентов за уровень, и потолок здесь экономический,
 * а не абсолютный.
 *
 * Ошибки в поведении это не вносит: границы запроса считаются по самому
 * радиусу (`forEachNear`), а не по обещанию уложиться в три на три.
 * Прокачанный стрелок просто просматривает больше корзин — пять по
 * стороне, потом семь.
 *
 * Меняется только цена, и она посчитана. Двадцать клеток дальности —
 * это тринадцать уровней ветки, около 34 000 энергии, почти час базового
 * дохода: в матче на двенадцать минут недостижимо. Пока это так, правки
 * размер корзины не требует; станет достижимо — потребует.
 */
const BUCKET_CELLS = 8;
const BUCKET_UNITS = BUCKET_CELLS * FIXED_POINT_SCALE;
const BUCKET_COLS = Math.ceil(MAP_WIDTH_CELLS / BUCKET_CELLS);
const BUCKET_ROWS = Math.ceil(MAP_HEIGHT_CELLS / BUCKET_CELLS);

export interface SpatialIndex {
  readonly buckets: readonly number[][];
}

const bucketOf = (x: number, y: number): number => {
  const column = Math.min(BUCKET_COLS - 1, Math.max(0, Math.floor(x / BUCKET_UNITS)));
  const row = Math.min(BUCKET_ROWS - 1, Math.max(0, Math.floor(y / BUCKET_UNITS)));
  return row * BUCKET_COLS + column;
};

export const buildSpatialIndex = (
  count: number,
  positionAt: (index: number) => Vec2 | undefined,
): SpatialIndex => {
  const buckets: number[][] = Array.from({ length: BUCKET_COLS * BUCKET_ROWS }, () => []);

  for (let index = 0; index < count; index += 1) {
    const point = positionAt(index);
    if (point === undefined) continue;

    buckets[bucketOf(point.x, point.y)]?.push(index);
  }

  return { buckets };
};

const forEachNear = (
  index: SpatialIndex,
  centre: Vec2,
  radius: number,
  visit: (item: number) => void,
): void => {
  const minColumn = Math.max(0, Math.floor((centre.x - radius) / BUCKET_UNITS));
  const maxColumn = Math.min(BUCKET_COLS - 1, Math.floor((centre.x + radius) / BUCKET_UNITS));
  const minRow = Math.max(0, Math.floor((centre.y - radius) / BUCKET_UNITS));
  const maxRow = Math.min(BUCKET_ROWS - 1, Math.floor((centre.y + radius) / BUCKET_UNITS));

  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const bucket = index.buckets[row * BUCKET_COLS + column];
      if (bucket === undefined) continue;

      for (const item of bucket) visit(item);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Выбор цели
// ─────────────────────────────────────────────────────────────────────────

export interface CombatIndices {
  readonly units: SpatialIndex;
  readonly structures: SpatialIndex;
}

export const buildCombatIndices = (working: Working): CombatIndices => ({
  units: buildSpatialIndex(working.units.length, (index) => {
    const unit = working.units[index];
    return unit === undefined || !unit.alive ? undefined : { x: unit.x, y: unit.y };
  }),
  structures: buildSpatialIndex(working.structures.length, (index) => {
    const structure = working.structures[index];
    return structure === undefined || !structure.alive ? undefined : cellCentre(structure.cell);
  }),
});

const squaredDistance = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

/**
 * Расстояние до постройки — до её основания, а не до центра.
 *
 * Юниты и генералы остаются точками, постройки занимают площадь. Разница
 * решающая для базы: её основание три на три, и мерка до центра означала бы,
 * что до базы нельзя дострелить, стоя к ней вплотную.
 */
const structureDistance = (from: Vec2, structure: WorkingStructure): number =>
  squaredDistanceToFootprint(from, structure.cell, STRUCTURE_STATS[structure.kind].footprintRadius);

/** Самое крупное основание среди построек, во внутренних единицах. */
const LARGEST_FOOTPRINT =
  (STRUCTURE_STATS[StructureKind.Base].footprintRadius + 1) * FIXED_POINT_SCALE;

interface Candidate {
  target: Target | undefined;
  distance: number;
  /** Идентификатор цели. Разрешает ничьи при равном расстоянии. */
  id: number;
}

const consider = (best: Candidate, target: Target, distance: number, id: number): void => {
  if (best.target !== undefined) {
    if (distance > best.distance) return;
    // Ничья по расстоянию разрешается меньшим идентификатором. Правило
    // нужно не игроку, а детерминизму: без него исход зависел бы
    // от порядка элементов в массиве.
    if (distance === best.distance && id >= best.id) return;
  }

  best.target = target;
  best.distance = distance;
  best.id = id;
};

/** Видно ли точку из точки. Обёртка вокруг линии огня для живых целей. */
const seesPoint = (working: Working, elevated: boolean, origin: Vec2, point: Vec2): boolean =>
  hasLineOfSight(working.sight, elevated, origin, point, cellAt(point), 0);

/** Видно ли постройку. Всё её основание для линии огня прозрачно. */
export const seesStructure = (
  working: Working,
  elevated: boolean,
  origin: Vec2,
  structure: WorkingStructure,
): boolean =>
  hasLineOfSight(
    working.sight,
    elevated,
    origin,
    cellCentre(structure.cell),
    structure.cell,
    STRUCTURE_STATS[structure.kind].footprintRadius,
  );

/** Ближайший видимый вражеский генерал. Ничья — по меньшему индексу. */
const nearestGeneral = (
  working: Working,
  owner: PlayerId,
  origin: Vec2,
  reach: number,
  elevated: boolean,
): Target | undefined => {
  const best: Candidate = { target: undefined, distance: Number.POSITIVE_INFINITY, id: 0 };

  working.generals.forEach((general, index) => {
    if (!general.alive || general.owner === owner) return;

    const point = { x: general.x, y: general.y };
    const distance = squaredDistance(origin, point);
    if (distance > reach) return;
    // Проверка линии дороже проверки расстояния, поэтому кандидата,
    // заведомо худшего текущего, отсеиваем до неё.
    if (best.target !== undefined && distance > best.distance) return;
    if (!seesPoint(working, elevated, origin, point)) return;

    consider(best, { kind: TargetKind.General, index }, distance, index);
  });

  return best.target;
};

/** Ближайший видимый вражеский юнит. */
const nearestUnit = (
  working: Working,
  indices: CombatIndices,
  owner: PlayerId,
  origin: Vec2,
  range: number,
  reach: number,
  elevated: boolean,
): Target | undefined => {
  const best: Candidate = { target: undefined, distance: Number.POSITIVE_INFINITY, id: 0 };

  forEachNear(indices.units, origin, range, (index) => {
    const unit = working.units[index];
    if (unit === undefined || !unit.alive || unit.owner === owner) return;

    const distance = squaredDistance(origin, { x: unit.x, y: unit.y });
    if (distance > reach) return;
    if (best.target !== undefined && distance > best.distance) return;
    if (!seesPoint(working, elevated, origin, { x: unit.x, y: unit.y })) return;

    consider(best, { kind: TargetKind.Unit, index }, distance, unit.id);
  });

  return best.target;
};

/**
 * Ближайшая видимая вражеская постройка.
 *
 * `armedOnly` отбирает только стреляющие. Отдельного обхода рядом
 * не заведено намеренно: два похожих перебора с почти одинаковыми
 * условиями разъехались бы на первой же правке — в одном не забыли бы
 * про основание базы, в другом забыли.
 */
const nearestStructure = (
  working: Working,
  indices: CombatIndices,
  owner: PlayerId,
  origin: Vec2,
  range: number,
  reach: number,
  elevated: boolean,
  armedOnly: boolean,
): Target | undefined => {
  const best: Candidate = { target: undefined, distance: Number.POSITIVE_INFINITY, id: 0 };

  // Радиус поиска расширен на размер самого крупного основания.
  // Корзины индексируют постройку по её центру, а стреляем мы по краю:
  // база с основанием три на три попадала бы в соседнюю корзину и просто
  // не находилась бы среди кандидатов.
  forEachNear(indices.structures, origin, range + LARGEST_FOOTPRINT, (index) => {
    const structure = working.structures[index];
    if (structure === undefined || !structure.alive || structure.owner === owner) return;
    if (armedOnly && !isArmedStructure(structure.kind)) return;

    const distance = structureDistance(origin, structure);
    if (distance > reach) return;
    if (best.target !== undefined && distance > best.distance) return;
    if (!seesStructure(working, elevated, origin, structure)) return;

    consider(best, { kind: TargetKind.Structure, index }, distance, structure.id);
  });

  return best.target;
};

/**
 * Выбор цели по приоритету:
 *   1) назначенная общая цель игрока;
 *   2) вражеский генерал;
 *   3) постройка, перегородившая путь;
 *   4) вражеский юнит;
 *   5) вражеская стреляющая постройка;
 *   6) любая вражеская постройка.
 *
 * Ступени перебираются сверху вниз, и первая, на которой нашлась цель
 * в радиусе и на линии огня, останавливает перебор. Внутри ступени
 * выбирается ближайшая цель, ничья разрешается меньшим идентификатором:
 * без этого исход зависел бы от порядка элементов в массиве.
 *
 * Почему генерал выше юнитов. Раньше он участвовал в общем конкурсе
 * наравне с ними и выигрывал, только будучи строго ближе любого юнита
 * в радиусе. А ходит он там, где идёт бой, то есть в окружении своей
 * пехоты, — и кто-нибудь из неё почти всегда оказывался ближе. В итоге
 * по генералу не стреляли вовсе: механика «хочешь укрепить позицию —
 * приди туда лично и подставься» не работала, а награда за убийство
 * вражеского генерала не выплачивалась никогда.
 *
 * Почему генерал выше преграды. Стена никуда не денется и через секунду
 * будет там же, а генерал уйдёт. К тому же за него дают двадцать
 * стоимостей штурмовика, а стена столько не стоит.
 *
 * Почему назначенная цель всё-таки выше генерала. Это единственный
 * прямой приказ игрока в выборе цели, и автоматика перебивать его
 * не должна.
 *
 * Почему стреляющая постройка отделена от прочих. Внутри ступени
 * выбирается ближайшая цель, а ближе башни почти всегда стоит
 * прикрывающая её стена — на то она и поставлена. Без отдельной ступени
 * юнит, остановившийся ради башни, ломал бы эту стену, пока башня
 * расстреливает его в упор, и правило остановки не работало бы вовсе.
 *
 * Почему она всё же ниже юнитов. Тот же довод, по которому генерал
 * выше преграды, только прочитанный наоборот: живой противник уйдёт,
 * а башня останется там же. Остановке это не мешает — юнит стоит, пока
 * башня жива, и доберётся до неё, разобравшись с пехотой.
 *
 * На каждой ступени цель обязана быть видимой: расстояния мало, нужна
 * ещё и свободная линия. Проверка стоит обхода нескольких клеток
 * и делается последней — после отсева по расстоянию, который куда дешевле.
 */
export const chooseTarget = (
  working: Working,
  indices: CombatIndices,
  owner: PlayerId,
  origin: Vec2,
  range: number,
  globalTargetIndex: number,
  blockedBy: number,
  elevation: Elevation,
): Target | undefined => {
  if (range <= 0) return undefined;

  const reach = range * range;

  const structureInReach = (index: number): boolean => {
    const structure = working.structures[index];
    if (structure === undefined || !structure.alive || structure.owner === owner) return false;
    if (structureDistance(origin, structure) > reach) return false;

    return seesStructure(working, elevation.structures, origin, structure);
  };

  if (globalTargetIndex >= 0 && structureInReach(globalTargetIndex)) {
    return { kind: TargetKind.Structure, index: globalTargetIndex };
  }

  const general = nearestGeneral(working, owner, origin, reach, elevation.living);
  if (general !== undefined) return general;

  if (blockedBy >= 0 && structureInReach(blockedBy)) {
    return { kind: TargetKind.Structure, index: blockedBy };
  }

  return (
    nearestUnit(working, indices, owner, origin, range, reach, elevation.living) ??
    nearestStructure(working, indices, owner, origin, range, reach, elevation.structures, true) ??
    nearestStructure(working, indices, owner, origin, range, reach, elevation.structures, false)
  );
};

/**
 * Что стрелок видит поверх стен.
 *
 * Флага два, а не один, и разошлись они из-за Теслы: по постройкам она
 * бьёт навесом, поверх стен, а по живым — прямой наводкой, и стена их
 * от неё прячет. У всех прочих стрелков оба значения совпадают: башня
 * и база видят поверх стен всё, пехота и генерал — ничего.
 *
 * Скала не проходит ни при одном значении: сетки непрозрачности две,
 * и скала есть в обеих (`sight.ts`).
 */
export interface Elevation {
  /** Видны ли поверх стен живые цели: юниты и генералы. */
  readonly living: boolean;
  /** Видны ли поверх стен постройки. */
  readonly structures: boolean;
}

/** Стрелок, который поверх стен не видит ничего: пехота и генерал. */
const ON_THE_GROUND: Elevation = { living: false, structures: false };

/** Стрелок выше стен во всём: башня и база. */
const ABOVE_WALLS: Elevation = { living: true, structures: true };

/**
 * Что видит юнит. У Теслы постройки — поверх стен, живые — нет;
 * у остальных не видно ничего.
 */
export const unitElevation = (unitType: UnitType): Elevation =>
  UNIT_INDIRECT_FIRE[unitType] ? { living: false, structures: true } : ON_THE_GROUND;

/**
 * Есть ли в радиусе живой противник, по которому можно стрелять.
 *
 * Нужен движению: юнит останавливается, встретив противника, но только
 * такого, до которого дострелит. Без проверки линии юнит замирал бы перед
 * стеной, за которой стоит недосягаемый враг, и стоял бы там до конца
 * матча.
 *
 * Индекс сюда передаётся построенный ДО движения — по положениям
 * на начало тика. Иначе ответ зависел бы от того, кто в массиве юнитов
 * идёт раньше, а от порядка перебора в детерминированном ядре зависеть
 * не должно ничего.
 */
export const hasHostileInSight = (
  working: Working,
  units: SpatialIndex,
  owner: PlayerId,
  origin: Vec2,
  range: number,
): boolean => {
  if (range <= 0) return false;

  const reach = range * range;
  let found = false;

  forEachNear(units, origin, range, (index) => {
    if (found) return;

    const unit = working.units[index];
    if (unit === undefined || !unit.alive || unit.owner === owner) return;
    if (squaredDistance(origin, { x: unit.x, y: unit.y }) > reach) return;
    if (!seesPoint(working, false, origin, { x: unit.x, y: unit.y })) return;

    found = true;
  });

  if (found) return true;

  for (const general of working.generals) {
    if (!general.alive || general.owner === owner) continue;
    if (squaredDistance(origin, { x: general.x, y: general.y }) > reach) continue;
    if (!seesPoint(working, false, origin, { x: general.x, y: general.y })) continue;

    return true;
  }

  return false;
};

/**
 * Есть ли в радиусе вражеская СТРЕЛЯЮЩАЯ постройка, по которой можно
 * стрелять.
 *
 * Нужен движению ровно затем же, зачем `hasHostileInSight` выше: юнит
 * останавливается, встретив башню, и снимает её, вместо того чтобы
 * пройти строй башен насквозь под их огнём. Стена сюда не попадает —
 * она не стреляет, и сносить её просто так незачем.
 *
 * Радиус — САМОГО юнита, а не постройки. Правило «останавливаться,
 * когда башня достаёт до тебя» выглядит справедливее, но означало бы
 * остановку вне собственного радиуса: юнит встал бы и не выстрелил.
 * И оно же отменило бы Теслу, которая обязана расстреливать башню,
 * не входя в её круг.
 *
 * `elevated` — высота стрельбы ПО ПОСТРОЙКАМ, не по живым. У Теслы это
 * навес поверх стен: башню за стеной она достаёт, а значит, и стоять
 * ради неё обязана. Пехота за той же стеной башни не видит и потому
 * идёт дальше.
 *
 * Индекс, как и у живых, передаётся построенный ДО движения: иначе ответ
 * зависел бы от порядка обхода массива, а от него в детерминированном
 * ядре зависеть не должно ничто. Постройки за время движения и так
 * не сдвигаются, но брать оба индекса из одного места дешевле, чем
 * помнить, что одно из двух правил исключение.
 */
export const hasArmedStructureInSight = (
  working: Working,
  structures: SpatialIndex,
  owner: PlayerId,
  origin: Vec2,
  range: number,
  elevated: boolean,
): boolean => {
  if (range <= 0) return false;

  const reach = range * range;
  let found = false;

  // Расширение радиуса поиска — то же и по той же причине, что
  // в `nearestStructure`: корзины индексируют постройку по центру,
  // а расстояние меряется до края основания.
  forEachNear(structures, origin, range + LARGEST_FOOTPRINT, (index) => {
    if (found) return;

    const structure = working.structures[index];
    if (structure === undefined || !structure.alive || structure.owner === owner) return;
    if (!isArmedStructure(structure.kind)) return;
    if (structureDistance(origin, structure) > reach) return;
    if (!seesStructure(working, elevated, origin, structure)) return;

    found = true;
  });

  return found;
};

// ─────────────────────────────────────────────────────────────────────────
// Урон
// ─────────────────────────────────────────────────────────────────────────

export const targetPosition = (working: Working, target: Target): Vec2 | undefined => {
  switch (target.kind) {
    case TargetKind.Unit: {
      const unit = working.units[target.index];
      return unit === undefined ? undefined : { x: unit.x, y: unit.y };
    }
    case TargetKind.Structure: {
      const structure = working.structures[target.index];
      return structure === undefined ? undefined : cellCentre(structure.cell);
    }
    case TargetKind.General: {
      const general = working.generals[target.index];
      return general === undefined ? undefined : { x: general.x, y: general.y };
    }
  }
};

/** Базовая стоимость убитого — она же награда генералу за убийство. */
const bounty = (working: Working, target: Target): number => {
  switch (target.kind) {
    case TargetKind.Unit: {
      const unit = working.units[target.index];
      return unit === undefined ? 0 : UNIT_STATS[unit.unitType].cost;
    }
    case TargetKind.Structure: {
      const structure = working.structures[target.index];
      return structure === undefined ? 0 : STRUCTURE_STATS[structure.kind].cost;
    }
    case TargetKind.General:
      return GENERAL_KILL_REWARD;
  }
};

/**
 * Ветеранский ранг за убийства.
 *
 * Ранг выводится из числа убийств таблицей порогов, поэтому награда —
 * это прибавленные убийства. Множитель к атаке и максимальному
 * здоровью посчитается сам, когда о характеристиках спросят.
 *
 * Прочность растёт и в максимуме, и в текущем значении на ту же
 * величину — иначе награда оборачивалась бы понижением доли здоровья:
 * объект становится крепче, а полоса над ним короче, и выглядит это
 * как повреждение в награду за победу.
 *
 * Пересчёт делается только при СМЕНЕ ранга. Убийство внутри ранга
 * характеристик не меняет, и лишний обход таблицы здесь ни к чему.
 * Поэтому же награда принимает СЧЁТ, а не вызывается по разу
 * на убитого: залп по толпе меняет ранг один раз, а не пять.
 */
const rewardStructure = (structure: WorkingStructure, stats: PlayerStats, count: number): void => {
  // Стена не стреляет вовсе, а растущая база означала бы матч, который
  // нельзя закончить: она и без того самый прочный объект на карте.
  if (structure.kind === StructureKind.Base || structure.kind === StructureKind.Wall) return;

  const baseline = stats.structures[structure.kind];
  const before = structure.kills;
  structure.kills += count;

  if (veteranRank(structure.kills) === veteranRank(before)) return;

  structure.health +=
    structureMaxHealth(baseline, structure.kills) - structureMaxHealth(baseline, before);
};

/** То же для машины. Ветеранство перестало быть привилегией обороны. */
const rewardUnit = (unit: WorkingUnit, stats: PlayerStats, count: number): void => {
  const baseline = stats.units[unit.unitType];
  const before = unit.kills;
  unit.kills += count;

  if (veteranRank(unit.kills) === veteranRank(before)) return;

  unit.health += unitMaxHealth(baseline, unit.kills) - unitMaxHealth(baseline, before);
};

/**
 * Награда стрелку за состоявшийся выстрел.
 *
 * Считаются ВСЕ убитые этим выстрелом, включая накрытие. Разряд Теслы,
 * положивший пятерых, приносит ей пять убийств.
 *
 * Прежде здесь стояло обратное правило — «не больше одного за выстрел», —
 * и отменено оно сознательно. Довод был такой: оружие против толпы
 * не должно получать за толпу ещё и ранг. Но это ровно то, чем Тесла
 * и является: смысл урона по площади в том, чтобы класть многих сразу,
 * и не засчитывать ей это значило отнимать заслугу за то, ради чего
 * её покупают. Счётчик обязан быть честным.
 *
 * Быстрый набор ранга ограничен не счётом, а таблицей: у машины потолок
 * полтора, а не два — см. `VETERAN_UNIT_PPM` в балансе. Именно там
 * и решается вопрос «сколько», а здесь — вопрос «за что».
 *
 * Вызывается всё равно один раз на выстрел, но со счётом убитых:
 * ранг при этом пересчитывается однократно.
 *
 * Генерала здесь нет намеренно: его награда за личное участие
 * выплачивается энергией, и она уже есть. Дав ему ещё и ранг, мы удвоили
 * бы плату за один и тот же риск, а накопленное им не сгорало бы
 * никогда — генерал возрождается.
 */
const rewardShooter = (
  working: Working,
  statsTable: readonly PlayerStats[],
  shooter: Shooter,
  count: number,
): void => {
  if (count <= 0) return;

  const stats = statsOf(statsTable, shooter.owner);

  if (shooter.kind === ShooterKind.Structure) {
    const structure = working.structures[shooter.index];
    if (structure !== undefined) rewardStructure(structure, stats, count);
    return;
  }

  if (shooter.kind === ShooterKind.Unit) {
    const unit = working.units[shooter.index];
    if (unit !== undefined) rewardUnit(unit, stats, count);
  }
};

export interface Shooter {
  readonly kind: ShooterKind;
  readonly index: number;
  readonly owner: PlayerId;
}

/**
 * Нанесение урона и всё, что за ним следует: гибель цели и награда
 * генералу энергией.
 *
 * Возвращает признак того, что цель погибла — вызывающему коду это нужно
 * дважды: для следа выстрела (добивающий рисуется ярче) и для награды
 * рангом.
 *
 * Ранга здесь НЕ выдаётся, и это не забывчивость. Накрытие идёт через
 * эту же функцию, и убитых за один выстрел бывает десяток; ранг же
 * пересчитывается по таблице порогов, и делать это по разу на убитого
 * значило бы пять раз пересчитать то, что меняется однажды. Поэтому
 * `fire` собирает счёт и награждает один раз — но на ПОЛНОЕ число
 * убитых, а не на одного.
 *
 * С энергией генералу так же: она платится за каждого убитого. Десять
 * машин, снятых одним залпом, стоят ровно десяти машин.
 */
export const dealDamage = (
  working: Working,
  statsTable: readonly PlayerStats[],
  shooter: Shooter,
  target: Target,
  amount: number,
): boolean => {
  if (amount <= 0) return false;

  const killed = damageEntity(working, statsTable, target, amount);
  if (!killed) return false;

  if (shooter.kind === ShooterKind.General) {
    // Награда энергией даётся только генералу — это плата за то,
    // что игрок рискнул им лично.
    const player = working.players.find((entry) => entry.id === shooter.owner);
    if (player !== undefined) player.energy += bounty(working, target);
  }

  return true;
};

/**
 * Вычет прочности со всеми последствиями: гибель, запись взрыва, уход
 * генерала на возрождение. Возвращает признак «цель погибла».
 *
 * Экспортируется ради ядерного удара. Через `dealDamage` тому идти
 * нельзя: она требует стрелка, а у взрыва стрелка нет — подделать его
 * нечем, индекс пришлось бы выдумать, и генерал получил бы за убийства
 * взрывом энергию, которой по замыслу не получает.
 *
 * Копировать её в `step.ts` тоже нельзя, и это не вкусовщина: две копии
 * правил гибели разъедутся на первой же правке, и генерал начнёт
 * исчезать молча ровно от одной из причин.
 */
export const damageEntity = (
  working: Working,
  statsTable: readonly PlayerStats[],
  target: Target,
  amount: number,
): boolean => {
  switch (target.kind) {
    case TargetKind.Unit: {
      const unit = working.units[target.index];
      if (unit === undefined || !unit.alive) return false;

      unit.health -= amount;
      if (unit.health > 0) return false;

      unit.alive = false;
      recordBlast(working, BlastKind.Unit, unit.owner, position(unit));
      return true;
    }
    case TargetKind.Structure: {
      const structure = working.structures[target.index];
      if (structure === undefined || !structure.alive) return false;

      structure.health -= amount;
      if (structure.health > 0) return false;

      structure.alive = false;
      working.structuresDirty = true;
      recordBlast(working, BlastKind.Structure, structure.owner, structurePosition(structure));
      return true;
    }
    case TargetKind.General: {
      const general = working.generals[target.index];
      if (!general?.alive) return false;

      general.health -= amount;
      if (general.health > 0) return false;

      killGeneral(working, statsTable, general);
      return true;
    }
  }
};

/**
 * Гибель генерала.
 *
 * Смерть не окончательна: наказание — потерянная позиция и время,
 * а не проигрыш. Время возрождения берётся из прокачки владельца.
 *
 * Взрыв записывается здесь, а не у трёх мест вызова — огонь, ядерный удар
 * и появившаяся поверх генерала постройка. Разъехаться три копии одной
 * строчки успели бы уже на следующей правке, и генерал начал бы исчезать
 * молча ровно от одной из причин.
 */
export const killGeneral = (
  working: Working,
  statsTable: readonly PlayerStats[],
  general: WorkingGeneral,
): void => {
  general.alive = false;
  general.health = 0;
  general.direction = 0;
  general.respawnAtTick = asTickNumber(
    working.tick + statsOf(statsTable, general.owner).general.respawnTicks,
  );

  recordBlast(working, BlastKind.General, general.owner, position(general));
};

// ─────────────────────────────────────────────────────────────────────────
// Один тик стрельбы
// ─────────────────────────────────────────────────────────────────────────

const damageAgainst = (
  working: Working,
  target: Target,
  attack: number,
  structureDamagePercent: number,
): number => {
  if (target.kind !== TargetKind.Structure) return attack;

  // Урон по постройкам может отличаться от урона по живым: снайпер бьёт
  // по ним в десятую силу, и это то, что делает его противопехотным.
  return Math.max(1, Math.floor((attack * structureDamagePercent) / 100));
};

/**
 * Накрытие: урон всем живым противникам вокруг точки попадания.
 *
 * Полный урон — в ближнем радиусе, доля — в дальнем, дальше не задевает
 * вовсе. Числа и вывод к ним лежат в балансе; здесь только правило.
 *
 * Кого НЕ задевает и почему:
 *
 * - свои. Строем игрок не управляет, и дружественный огонь наказывал бы
 *   его за то, чего он не выбирал;
 * - постройки. Иначе стеновая линия оседает веером, а база с основанием
 *   три на три получает урон по разу за каждую накрытую клетку;
 * - прямую цель. Она уже получила своё, и без этой проверки получила бы
 *   дважды.
 *
 * Линия огня здесь не проверяется, и это сознательно: накрытие —
 * последствие попадания, а не отдельный выстрел. Машина за стеной
 * в полутора клетках от точки удара свою долю получит. Проверять линию
 * до каждого задетого означало бы десятки обходов клеток на один
 * выстрел, а проверка линии — самая дорогая часть выбора цели.
 *
 * Перебор идёт по пространственному индексу, а не по всем юнитам подряд,
 * как у ядерного удара: тот случается раз за полторы тысячи энергии,
 * а этот — каждые три с небольшим секунды у каждой Теслы. Индекс
 * построен один раз за тик, до стрельбы, поэтому в нём остаются убитые
 * в этом же тике — `alive` проверяется у каждого.
 *
 * Возвращает ЧИСЛО убитых накрытием. Нужно награде рангом: залп по толпе
 * приносит столько убийств, скольких положил, — в этом и смысл урона
 * по площади. Считает `fire`, а не каждое попадание, чтобы ранг
 * пересчитался один раз, а не по разу на убитого.
 */
const splash = (
  working: Working,
  statsTable: readonly PlayerStats[],
  indices: CombatIndices,
  shooter: Shooter,
  aim: Vec2,
  direct: Target,
  attack: number,
): number => {
  let killed = 0;
  const share = Math.floor(attack / SPLASH_OUTER_DIVISOR);
  const full = SPLASH_FULL_RADIUS * SPLASH_FULL_RADIUS;
  const outer = SPLASH_OUTER_RADIUS * SPLASH_OUTER_RADIUS;

  const amountAt = (distance: number): number => (distance <= full ? attack : share);

  forEachNear(indices.units, aim, SPLASH_OUTER_RADIUS, (index) => {
    if (direct.kind === TargetKind.Unit && direct.index === index) return;

    const unit = working.units[index];
    if (unit === undefined || !unit.alive || unit.owner === shooter.owner) return;

    const distance = squaredDistance(aim, { x: unit.x, y: unit.y });
    if (distance > outer) return;

    if (
      dealDamage(working, statsTable, shooter, { kind: TargetKind.Unit, index }, amountAt(distance))
    ) {
      killed += 1;
    }
  });

  working.generals.forEach((general, index) => {
    if (direct.kind === TargetKind.General && direct.index === index) return;
    if (!general.alive || general.owner === shooter.owner) return;

    const distance = squaredDistance(aim, { x: general.x, y: general.y });
    if (distance > outer) return;

    if (
      dealDamage(
        working,
        statsTable,
        shooter,
        { kind: TargetKind.General, index },
        amountAt(distance),
      )
    ) {
      killed += 1;
    }
  });

  return killed;
};

const fire = (
  working: Working,
  statsTable: readonly PlayerStats[],
  indices: CombatIndices,
  shooter: Shooter,
  origin: Vec2,
  target: Target,
  attack: number,
  structureDamagePercent: number,
  weapon: ShotWeapon,
  side: ShotSide,
): void => {
  const aim = targetPosition(working, target);
  if (aim === undefined) return;

  const lethal = dealDamage(
    working,
    statsTable,
    shooter,
    target,
    damageAgainst(working, target, attack, structureDamagePercent),
  );

  // Накрытие опознаётся по оружию, а не по типу юнита: разряд и площадь —
  // одно и то же оружие, и раздавать их порознь было бы двумя правилами
  // там, где хватает одного.
  const splashed =
    weapon === ShotWeapon.Arc
      ? splash(working, statsTable, indices, shooter, aim, target, attack)
      : 0;

  // Ранг выдаётся здесь: это то место, где известны границы выстрела
  // и полный счёт унесённых им жизней. Считаются ВСЕ — в этом и смысл
  // урона по площади.
  rewardShooter(working, statsTable, shooter, (lethal ? 1 : 0) + splashed);

  // След выстрела ярче только когда погибла ПРЯМАЯ цель: игрок целился
  // в неё, и подтверждение нужно по ней.
  recordShot(working, shooter.owner, origin, aim, lethal, weapon, side);
};

const globalTargetIndexOf = (working: Working, owner: PlayerId): number => {
  const player = working.players.find((entry) => entry.id === owner);
  if (player === undefined) return -1;

  return working.structures.findIndex(
    (structure) => structure.alive && structure.id === player.targetStructure,
  );
};

/**
 * Стрельба всех, кто может стрелять, за один тик.
 *
 * Порядок фиксирован: сначала постройки, затем юниты, затем генералы.
 * Порядок влияет на исход — кто выстрелил первым, тот может добить цель
 * раньше, — поэтому менять его нельзя без обновления эталона детерминизма.
 */
export const resolveCombat = (
  working: Working,
  statsTable: readonly PlayerStats[],
  indices: CombatIndices,
): void => {
  const globalTargets = working.players.map((player) => globalTargetIndexOf(working, player.id));
  const targetFor = (owner: PlayerId): number =>
    globalTargets[working.players.findIndex((player) => player.id === owner)] ?? -1;

  working.structures.forEach((structure, index) => {
    fireStructure(working, statsTable, indices, structure, index, targetFor(structure.owner));
  });

  working.units.forEach((unit, index) => {
    fireUnit(working, statsTable, indices, unit, index, targetFor(unit.owner));
  });

  working.generals.forEach((general, index) => {
    fireGeneral(working, statsTable, indices, general, index, targetFor(general.owner));
  });
};

const fireStructure = (
  working: Working,
  statsTable: readonly PlayerStats[],
  indices: CombatIndices,
  structure: WorkingStructure,
  index: number,
  globalTarget: number,
): void => {
  if (!structure.alive) return;
  // Недостроенная постройка не стреляет: она уже мешает пройти,
  // но воевать ещё не умеет.
  if (working.tick < structure.builtAtTick) return;
  if (working.tick < structure.readyAtTick) return;

  const baseline = statsOf(statsTable, structure.owner).structures[structure.kind];
  const attack = structureAttack(baseline, structure.kills);
  if (attack <= 0 || baseline.range <= 0) return;

  const origin = cellCentre(structure.cell);
  const target = chooseTarget(
    working,
    indices,
    structure.owner,
    origin,
    baseline.range,
    globalTarget,
    -1,
    // Башня и база выше стены и стреляют поверх неё. Именно это делает
    // стену перед башней укреплением, а не просто занятой клеткой.
    ABOVE_WALLS,
  );
  if (target === undefined) return;

  // Турель разворачивается на цель ровно тем же кодом, что и машина.
  // Разворот мгновенный и на выстрел не влияет: сектора обстрела в игре
  // нет, башня бьёт куда угодно. Он нужен затем, чтобы по башне было
  // видно, что она сейчас дерётся и с какой стороны к ней подошли.
  structure.facing = aimFacing(working, target, origin.x, origin.y, structure.facing);
  structure.readyAtTick = asTickNumber(working.tick + baseline.cooldownTicks);
  fire(
    working,
    statsTable,
    indices,
    { kind: ShooterKind.Structure, index, owner: structure.owner },
    origin,
    target,
    attack,
    100,
    STRUCTURE_WEAPON[structure.kind],
    ShotSide.Centre,
  );
};

/**
 * Разворот стрелка на цель.
 *
 * Стрельба идёт после движения, поэтому этот разворот перебивает разворот
 * по ходу шага — и это правильный порядок: доехавший до врага и открывший
 * огонь смотрит на врага, а не на последнюю точку маршрута.
 *
 * На исход выстрела не влияет никак: разворот мгновенный, стрелять можно
 * в любую сторону. Это облик, а не механика.
 */
const aimFacing = (
  working: Working,
  target: Target,
  fromX: number,
  fromY: number,
  current: number,
): number => {
  const aim = targetPosition(working, target);
  if (aim === undefined) return current;

  const heading = directionTowards(aim.x - fromX, aim.y - fromY);
  return heading === DIRECTION_STOP ? current : heading;
};

const fireUnit = (
  working: Working,
  statsTable: readonly PlayerStats[],
  indices: CombatIndices,
  unit: WorkingUnit,
  index: number,
  globalTarget: number,
): void => {
  if (!unit.alive) return;
  if (working.tick < unit.readyAtTick) return;

  const baseline = statsOf(statsTable, unit.owner).units[unit.unitType];
  const origin = { x: unit.x, y: unit.y };

  const target = chooseTarget(
    working,
    indices,
    unit.owner,
    origin,
    baseline.range,
    globalTarget,
    unit.blockedBy,
    unitElevation(unit.unitType),
  );
  if (target === undefined) return;

  unit.facing = aimFacing(working, target, unit.x, unit.y, unit.facing);
  unit.readyAtTick = asTickNumber(working.tick + baseline.cooldownTicks);
  fire(
    working,
    statsTable,
    indices,
    { kind: ShooterKind.Unit, index, owner: unit.owner },
    origin,
    target,
    // Атака с учётом ветеранского ранга — как у башни. Перезарядка
    // и дальность берутся паспортные: ранг их не трогает.
    unitAttack(baseline, unit.kills),
    baseline.structureDamagePercent,
    UNIT_WEAPON[unit.unitType],
    ShotSide.Centre,
  );
};

const fireGeneral = (
  working: Working,
  statsTable: readonly PlayerStats[],
  indices: CombatIndices,
  general: WorkingGeneral,
  index: number,
  globalTarget: number,
): void => {
  if (!general.alive) return;
  if (working.tick < general.readyAtTick) return;

  const baseline = statsOf(statsTable, general.owner).general;
  const origin = { x: general.x, y: general.y };

  const target = chooseTarget(
    working,
    indices,
    general.owner,
    origin,
    baseline.range,
    globalTarget,
    -1,
    ON_THE_GROUND,
  );
  if (target === undefined) return;

  general.facing = aimFacing(working, target, general.x, general.y, general.facing);
  general.readyAtTick = asTickNumber(working.tick + baseline.cooldownTicks);

  // Борт переключается ровно здесь — после того, как выстрел признан
  // состоявшимся. Все выходы «цели нет» и «перезарядка не вышла» уже
  // позади, и промолчавший генерал очередь бортов не сбивает.
  const side = general.nextMissileSide;
  general.nextMissileSide = side === ShotSide.Left ? ShotSide.Right : ShotSide.Left;

  fire(
    working,
    statsTable,
    indices,
    { kind: ShooterKind.General, index, owner: general.owner },
    origin,
    target,
    baseline.attack,
    baseline.structureDamagePercent,
    GENERAL_WEAPON,
    side,
  );
};
