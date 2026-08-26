import {
  AttackStance,
  DIRECTION_SCALE,
  DIRECTION_STOP,
  DIRECTION_VECTORS,
  FIXED_POINT_SCALE,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  STRUCTURE_STATS,
  directionTowards,
  onRuleTuningApplied,
} from '@td/shared';
import type { PlayerId, Vec2 } from '@td/shared';
import { cellAt, cellCentre, cellIndex, squaredDistanceToFootprint } from './map.js';
import {
  hasArmedStructureInSight,
  hasHostileInSight,
  seesStructure,
  unitElevation,
} from './combat.js';
import type { CombatIndices } from './combat.js';
import { NO_STRUCTURE } from './occupancy.js';
import { UNREACHABLE, bestStep } from './navigation.js';
import { statsOf } from './stats.js';
import type { PlayerStats } from './stats.js';
import type { Working, WorkingGeneral, WorkingStructure, WorkingUnit } from './working.js';

/**
 * Движение сущностей.
 *
 * Про арифметику отдельно. Здесь встречаются `Math.sqrt` и деление —
 * то есть дробные вычисления, которых в ядре быть не должно. Запрет
 * касается ХРАНИМЫХ величин: в состоянии мира дробей нет, координаты
 * остаются целыми. Промежуточные вычисления безопасны потому, что
 * стандарт IEEE 754 требует корректного округления и для деления,
 * и для квадратного корня: на любой платформе они дают бит в бит
 * одинаковый результат. `Math.hypot` такой гарантии не даёт и потому
 * здесь не используется, хотя выглядел бы аккуратнее.
 */

// Границы поля считаются один раз, а не при каждом обращении: они нужны
// в самом горячем месте тика. Пересчёт заявлен настройке правил — размер
// карты подвижен только до создания первого мира, и оставить здесь `const`
// значило бы удерживать войско в границах ПРЕЖНЕЙ карты.
let MAP_MAX_X = MAP_WIDTH_CELLS * FIXED_POINT_SCALE - 1;
let MAP_MAX_Y = MAP_HEIGHT_CELLS * FIXED_POINT_SCALE - 1;

onRuleTuningApplied(() => {
  MAP_MAX_X = MAP_WIDTH_CELLS * FIXED_POINT_SCALE - 1;
  MAP_MAX_Y = MAP_HEIGHT_CELLS * FIXED_POINT_SCALE - 1;
});

const clamp = (value: number, max: number): number => (value < 0 ? 0 : value > max ? max : value);

/** Двигает точку к цели не дальше чем на `speed`. */
const advance = (
  from: { x: number; y: number },
  towards: Vec2,
  speed: number,
): { x: number; y: number } => {
  const dx = towards.x - from.x;
  const dy = towards.y - from.y;
  const length = Math.sqrt(dx * dx + dy * dy);

  if (length <= speed || length === 0) return { x: towards.x, y: towards.y };

  return {
    x: from.x + Math.round((dx * speed) / length),
    y: from.y + Math.round((dy * speed) / length),
  };
};

const isBlocked = (working: Working, x: number, y: number): boolean => {
  const cell = cellAt({ x, y });
  return working.occupancy.blocked[cell] === 1;
};

/**
 * Движение юнитов по полю потока.
 *
 * Юнит останавливается в четырёх случаях: назначенная цель уже в радиусе
 * его атаки и видна, следующий шаг упирается в преграду, которую он
 * ломает, либо — В РЕЖИМЕ «БОЙ» — в радиусе есть живой противник или
 * вражеская стреляющая постройка, по которым он дострелит. Во всех
 * прочих случаях он идёт, в том числе ведя огонь на ходу.
 *
 * НЕстреляющая вражеская постройка юнита не останавливает, и это правило —
 * то, ради чего существует Тесла: её дальность больше дальности базовой
 * башни, поэтому, остановившись у назначенной цели, она расстреливает
 * эту цель, оставаясь вне досягаемости. Если бы юниты останавливались
 * у любой постройки, она залипала бы на первой встречной стене
 * и никогда не доходила до назначенной цели.
 *
 * Стреляющая постройка — другое дело, и до сих пор её отсутствие в этом
 * списке стоило дорого. Войско, нацеленное на базу, проходило строй башен
 * насквозь под их огнём и не пыталось их снять, а башня за каждое
 * убийство получает прибавку к атаке и прочности, — то есть гибнущее
 * по дороге войско бесплатно усиливало ту оборону, сквозь которую шло.
 * Стена по-прежнему не останавливает: она не стреляет, и сносить её
 * просто так нечего ради.
 *
 * Живой противник и башня останавливают только в режиме «Бой». Правило
 * верное — две армии, прошедшие друг сквозь друга и разошедшиеся
 * по своим делам, это не тактика, а отсутствие события, — но как
 * ЕДИНСТВЕННОЕ оно означало, что осадная волна вязнет в любом заслоне,
 * и решать это за игрока не за что. Требование видимости здесь
 * обязательно: без него юнит замирал бы перед стеной, за которой стоит
 * недосягаемый враг.
 */
export const moveUnits = (
  working: Working,
  statsTable: readonly PlayerStats[],
  indices: CombatIndices,
): void => {
  const targets = new Map<PlayerId, WorkingStructure>();
  const stances = new Map<PlayerId, AttackStance>();

  for (const player of working.players) {
    const target = working.structures.find(
      (structure) => structure.alive && structure.id === player.targetStructure,
    );
    if (target !== undefined) targets.set(player.id, target);

    stances.set(player.id, player.stance);
  }

  for (const unit of working.units) {
    if (!unit.alive) continue;

    unit.blockedBy = NO_STRUCTURE;

    const baseline = statsOf(statsTable, unit.owner).units[unit.unitType];
    const origin = { x: unit.x, y: unit.y };
    const elevation = unitElevation(unit.unitType);

    const target = targets.get(unit.owner);
    if (
      target !== undefined &&
      // Расстояние до основания, а не до центра: у базы основание три
      // на три, и по её центру юнит не достанет, даже упёршись в стену.
      squaredDistanceToFootprint(unit, target.cell, STRUCTURE_STATS[target.kind].footprintRadius) <=
        baseline.range * baseline.range &&
      // Навес учитывается тот же, что и в бою, иначе способность
      // не работала бы вовсе: Тесла, достающая башню поверх стены,
      // всё равно шла бы к стене — «цель не вижу, надо ближе», — упиралась
      // бы в неё и принималась ломать преграду вместо назначенной цели.
      seesStructure(working, elevation.structures, origin, target)
    ) {
      // Цель в радиусе и на линии огня — дальше идти незачем.
      continue;
    }

    // Останавливаться перед встречным или идти дальше — решает режим
    // атаки, а не жёсткое правило. В «Бою» две армии сцепляются, как
    // и раньше; в «Прорыве» волна идёт к цели, ведя огонь на ходу.
    //
    // Огонь на ходу — механика уже существующая, а не новая: стрельба
    // решается отдельно от движения и от него не зависит вовсе. Режим
    // «Прорыв» просто перестаёт мешать ей работать.
    //
    // Встречных здесь два вида, и оба обрабатываются одинаково: живой
    // противник и вражеская стреляющая постройка. Второй вид нужен затем,
    // чтобы войско снимало башни, а не проходило их строй насквозь под
    // огнём. Стена сюда не попадает — она не стреляет.
    //
    // Остальные две остановки от режима НЕ зависят и не должны. Остановка
    // у назначенной цели — единственное, ради чего существует
    // Тесла: она позволяет ей бить башню вне её досягаемости.
    // Остановка перед перегородившей путь постройкой — единственный способ
    // её сломать.
    if (
      stances.get(unit.owner) === AttackStance.Engage &&
      (hasHostileInSight(working, indices.units, unit.owner, origin, baseline.range) ||
        hasArmedStructureInSight(
          working,
          indices.structures,
          unit.owner,
          origin,
          baseline.range,
          elevation.structures,
        ))
    ) {
      continue;
    }

    const field = working.nav[unit.owner];
    if (field === undefined) continue;

    const cell = cellAt(unit);

    // Пролом включается, только когда обычного пути до цели нет вовсе.
    // Пока обход существует, юниты идут в обход, какой бы он ни был
    // длинный: так решил игрок, и так записано в игровом замысле.
    const deadEnd = (field.walk[cell] ?? UNREACHABLE) === UNREACHABLE;
    const distances = deadEnd ? field.breach : field.walk;

    const step = bestStep(
      distances,
      working.occupancy,
      working.structures,
      unit.owner,
      cell,
      deadEnd,
    );
    if (step.cell < 0) continue;

    if (step.structureIndex !== NO_STRUCTURE) {
      // Дорогу перегородила разрушимая постройка. Стоим и ломаем её —
      // выбор цели на этапе стрельбы увидит этот индекс.
      unit.blockedBy = step.structureIndex;
      continue;
    }

    moveUnitTowards(working, unit, cellCentre(step.cell), baseline.speed);
  }
};

const moveUnitTowards = (
  working: Working,
  unit: WorkingUnit,
  towards: Vec2,
  speed: number,
): void => {
  const next = advance(unit, towards, speed);

  // Страховка от прохода сквозь постройку, появившуюся после последнего
  // пересчёта поля: поле может отставать на несколько тиков, занятость —
  // никогда.
  if (isBlocked(working, next.x, next.y)) return;

  // Машина разворачивается по ходу шага — и только если шаг состоялся:
  // упёршийся в стену юнит смотрит туда же, куда смотрел. Румб берётся
  // от цели шага, а не от пройденного за тик расстояния: расстояние
  // за тик мало, и округление его до одного из восьми румбов давало бы
  // дрожание на длинной прямой.
  const heading = directionTowards(towards.x - unit.x, towards.y - unit.y);
  if (heading !== DIRECTION_STOP) unit.facing = heading;

  unit.x = clamp(next.x, MAP_MAX_X);
  unit.y = clamp(next.y, MAP_MAX_Y);
};

/**
 * Движение генералов.
 *
 * Генерал идёт в заданном направлении, пока направление не сменится.
 * Упершись в препятствие по диагонали, он продолжает движение вдоль той
 * оси, которая свободна: без этого генерал намертво залипал бы на углу
 * стены, и управление ощущалось бы сломанным.
 */
export const moveGenerals = (working: Working, statsTable: readonly PlayerStats[]): void => {
  for (const general of working.generals) {
    if (!general.alive || general.direction === DIRECTION_STOP) continue;

    const vector = DIRECTION_VECTORS[general.direction];
    if (vector === undefined) continue;

    // Машина разворачивается туда, куда её ведут. Отдельно от `direction`
    // потому, что тот обнуляется, едва игрок отпустил клавиши, а разворот
    // должен сохраниться.
    general.facing = general.direction;

    const speed = statsOf(statsTable, general.owner).general.speed;
    const stepX = Math.round((vector.x * speed) / DIRECTION_SCALE);
    const stepY = Math.round((vector.y * speed) / DIRECTION_SCALE);

    slide(working, general, stepX, stepY);
  }
};

const slide = (working: Working, general: WorkingGeneral, stepX: number, stepY: number): void => {
  const tryStep = (dx: number, dy: number): boolean => {
    if (dx === 0 && dy === 0) return false;

    const x = clamp(general.x + dx, MAP_MAX_X);
    const y = clamp(general.y + dy, MAP_MAX_Y);
    if (isBlocked(working, x, y)) return false;

    general.x = x;
    general.y = y;
    return true;
  };

  if (tryStep(stepX, stepY)) return;
  // Полный шаг не прошёл — пробуем скользить вдоль каждой из осей.
  if (tryStep(stepX, 0)) return;
  tryStep(0, stepY);
};

/**
 * Ближайшая свободная клетка вокруг заданной.
 *
 * Используется для появления юнитов у базы и возвращения генерала после
 * гибели. Обход идёт кольцами, поэтому найденная клетка — действительно
 * ближайшая, а не первая попавшаяся.
 *
 * `taken` — клетки, уже разобранные в этом тике. Занятость их не отмечает:
 * юниты проходят друг сквозь друга и клетку не блокируют, поэтому без
 * этого набора десяток заказанных разом юнитов появился бы в одной точке.
 */
export const findFreeCellNear = (
  working: Working,
  centre: number,
  maxRadius: number,
  taken?: ReadonlySet<number>,
): number => {
  const free = (cell: number): boolean =>
    working.occupancy.blocked[cell] !== 1 && taken?.has(cell) !== true;

  if (free(centre)) return centre;

  const cx = centre % MAP_WIDTH_CELLS;
  const cy = Math.floor(centre / MAP_WIDTH_CELLS);

  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        // Только периметр кольца: внутренность уже проверена на прошлых шагах.
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;

        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= MAP_WIDTH_CELLS || y >= MAP_HEIGHT_CELLS) continue;

        const cell = cellIndex(x, y);
        if (free(cell)) return cell;
      }
    }
  }

  return -1;
};
