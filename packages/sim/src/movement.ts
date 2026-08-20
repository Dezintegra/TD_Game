import {
  DIRECTION_SCALE,
  DIRECTION_STOP,
  DIRECTION_VECTORS,
  FIXED_POINT_SCALE,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  STRUCTURE_STATS,
} from '@td/shared';
import type { PlayerId, Vec2 } from '@td/shared';
import { cellAt, cellCentre, cellIndex, squaredDistanceToFootprint } from './map.js';
import { hasHostileInSight, seesStructure } from './combat.js';
import type { SpatialIndex } from './combat.js';
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

const MAP_MAX_X = MAP_WIDTH_CELLS * FIXED_POINT_SCALE - 1;
const MAP_MAX_Y = MAP_HEIGHT_CELLS * FIXED_POINT_SCALE - 1;

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
 * Юнит останавливается в трёх случаях: назначенная цель уже в радиусе
 * его атаки и видна, в радиусе есть живой противник, по которому он
 * дострелит, либо следующий шаг упирается в преграду, которую он ломает.
 * Во всех прочих случаях он идёт, в том числе ведя огонь на ходу.
 *
 * Вражеская постройка на пути юнита не останавливает, и это правило —
 * то, ради чего существует гранатомётчик: его дальность на клетку больше
 * дальности базовой башни, поэтому, остановившись у назначенной цели,
 * он расстреливает её, оставаясь вне досягаемости. Если бы юниты
 * останавливались у любой постройки, он залипал бы на первой встречной
 * стене и никогда не доходил до назначенной цели.
 *
 * А вот живой противник останавливает: две армии, прошедшие друг сквозь
 * друга и разошедшиеся дальше по своим делам, — это не тактика, а просто
 * отсутствие события. Требование видимости здесь обязательно: без него
 * юнит замирал бы перед стеной, за которой стоит недосягаемый враг.
 */
export const moveUnits = (
  working: Working,
  statsTable: readonly PlayerStats[],
  hostiles: SpatialIndex,
): void => {
  const targets = new Map<PlayerId, WorkingStructure>();

  for (const player of working.players) {
    const target = working.structures.find(
      (structure) => structure.alive && structure.id === player.targetStructure,
    );
    if (target !== undefined) targets.set(player.id, target);
  }

  for (const unit of working.units) {
    if (!unit.alive) continue;

    unit.blockedBy = NO_STRUCTURE;

    const baseline = statsOf(statsTable, unit.owner).units[unit.unitType];
    const origin = { x: unit.x, y: unit.y };

    const target = targets.get(unit.owner);
    if (
      target !== undefined &&
      // Расстояние до основания, а не до центра: у базы основание три
      // на три, и по её центру юнит не достанет, даже упёршись в стену.
      squaredDistanceToFootprint(unit, target.cell, STRUCTURE_STATS[target.kind].footprintRadius) <=
        baseline.range * baseline.range &&
      seesStructure(working, false, origin, target)
    ) {
      // Цель в радиусе и на линии огня — дальше идти незачем.
      continue;
    }

    if (hasHostileInSight(working, hostiles, unit.owner, origin, baseline.range)) continue;

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
