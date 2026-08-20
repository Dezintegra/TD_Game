import {
  BREACH_HEALTH_PER_STEP,
  MAP_CELL_COUNT,
  MAX_BREACH_COST,
  STRUCTURE_STATS,
  asTickNumber,
} from '@td/shared';
import type { PlayerId, TickNumber } from '@td/shared';
import { cellIndex, cellX, cellY, isInsideMap } from './map.js';
import { NO_STRUCTURE, footprintCells } from './occupancy.js';
import type { Occupancy } from './occupancy.js';
import type { NavField, StructureState } from './world.js';

/**
 * Поиск пути полем потока.
 *
 * Прямолинейный подход — считать маршрут каждому юниту — не проходит
 * по бюджету кадра: двести юнитов при тридцати тиках в секунду дают шесть
 * тысяч поисков в секунду по девяти тысячам клеток каждый.
 *
 * Спасает решение игрового дизайна: цель у всех юнитов игрока одна.
 * Значит, задача переворачивается. Вместо «путь от каждого юнита к цели»
 * считается один раз «расстояние от цели до каждой клетки», а юнит просто
 * идёт в соседнюю клетку с меньшим расстоянием.
 *
 * Один обход карты на игрока вместо двухсот поисков, и юнит стоит O(1).
 */

/** Расстояние, означающее «отсюда до цели пути нет». */
export const UNREACHABLE = 0x7fffffff;

/** Стоимость шага по свободной клетке. */
const STEP_COST = 1;

/**
 * Максимальный вес ребра: обычный шаг плюс самая дорогая плата за пролом.
 * От него зависит число вёдер в очереди — см. ниже.
 */
const MAX_EDGE = STEP_COST + MAX_BREACH_COST;
const BUCKET_COUNT = MAX_EDGE + 1;

/** Смещения к восьми соседям. Порядок фиксирован ради детерминизма. */
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/**
 * Дейкстра на вёдрах (алгоритм Диала).
 *
 * Стоимости рёбер здесь целые и мелкие: единица за обычную клетку и до
 * шестидесяти одной за пролом постройки. При таких весах двоичная куча —
 * избыточность: её логарифм оплачивается указателями и перестановками.
 *
 * Очередь на вёдрах использует простое свойство: новое расстояние всегда
 * больше текущего, но не более чем на максимальный вес ребра. Значит,
 * BUCKET_COUNT вёдер по кругу покрывают все возможные расстояния,
 * и элемент никогда не попадёт в уже обработанное ведро.
 *
 * Массив `cost` задаёт и проходимость, и цену входа: ноль означает
 * «сюда нельзя», положительное число — «войти стоит столько».
 *
 * Обратите внимание на направление: поле считается ОТ цели, а `dist[c]` —
 * это цена дороги от клетки `c` ДО цели. Поэтому при переходе из клетки
 * `cell` в соседа прибавляется цена входа в `cell`, а не в соседа: сосед
 * платит за шаг, которым он войдёт в `cell`.
 */
export const dijkstraField = (cost: Int32Array, seeds: readonly number[]): Int32Array => {
  const dist = new Int32Array(MAP_CELL_COUNT).fill(UNREACHABLE);
  const buckets: number[][] = Array.from({ length: BUCKET_COUNT }, () => []);

  let maxSeen = 0;

  for (const seed of seeds) {
    if (dist[seed] === 0) continue;
    dist[seed] = 0;
    buckets[0]?.push(seed);
  }

  for (let distance = 0; distance <= maxSeen; distance += 1) {
    const bucket = buckets[distance % BUCKET_COUNT];
    if (bucket === undefined) continue;

    while (bucket.length > 0) {
      const cell = bucket.pop();
      if (cell === undefined) break;

      // Устаревшая запись: до этой клетки уже нашли дорогу короче.
      if (dist[cell] !== distance) continue;

      const step = cost[cell] ?? 0;
      if (step <= 0) continue;

      const x = cellX(cell);
      const y = cellY(cell);

      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!isInsideMap(nx, ny)) continue;

        const next = cellIndex(nx, ny);
        if ((cost[next] ?? 0) <= 0) continue;

        // Диагональ не режет углы: без этой проверки юниты просачивались бы
        // сквозь стык двух стен, поставленных углом, и стена переставала бы
        // быть стеной.
        if (dx !== 0 && dy !== 0) {
          if ((cost[cellIndex(nx, y)] ?? 0) <= 0) continue;
          if ((cost[cellIndex(x, ny)] ?? 0) <= 0) continue;
        }

        const candidate = distance + step;
        if (candidate >= (dist[next] ?? UNREACHABLE)) continue;

        dist[next] = candidate;
        buckets[candidate % BUCKET_COUNT]?.push(next);
        if (candidate > maxSeen) maxSeen = candidate;
      }
    }
  }

  return dist;
};

/**
 * Плата за пролом постройки, выраженная в тех же единицах, что и шаги пути.
 *
 * Так прочность переводится в «сколько это стоит по времени», и юнит
 * сравнивает «идти в обход» с «ломать» одним числом. Именно отсюда
 * берётся выбор наиболее выгодной преграды: юнит ничего не сравнивает
 * вручную, стоимость пролома уже заложена в расстояние, и первая преграда
 * на его пути — самая выгодная из возможных по построению.
 */
export const breachPenalty = (health: number): number =>
  Math.min(MAX_BREACH_COST, Math.max(1, Math.floor(health / BREACH_HEALTH_PER_STEP)));

/**
 * Стоимость входа в каждую клетку для обычного движения:
 * только свободная земля.
 */
const walkCostArray = (occupancy: Occupancy, seeds: readonly number[]): Int32Array => {
  const cost = new Int32Array(MAP_CELL_COUNT);

  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    cost[cell] = occupancy.blocked[cell] === 1 ? 0 : STEP_COST;
  }

  // Клетки самой цели проходимы: иначе поле не смогло бы от них начаться.
  // Цена входа обычная — «дойти до цели» стоит один шаг, а не пролом.
  for (const seed of seeds) cost[seed] = STEP_COST;

  return cost;
};

/**
 * Стоимость входа для движения с проломом: дополнительно разрешены клетки
 * с разрушимыми постройками противника, и вход в них тем дороже, чем они
 * прочнее. Свои постройки непроходимы: ломать своё юнит не станет.
 */
const breachCostArray = (
  occupancy: Occupancy,
  structures: readonly StructureState[],
  owner: PlayerId,
  seeds: readonly number[],
): Int32Array => {
  const cost = new Int32Array(MAP_CELL_COUNT);

  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    if (occupancy.blocked[cell] !== 1) {
      cost[cell] = STEP_COST;
      continue;
    }

    const index = occupancy.structureAt[cell] ?? NO_STRUCTURE;
    if (index === NO_STRUCTURE) continue; // скала — непроходима всегда

    const structure = structures[index];
    if (structure === undefined || structure.owner === owner) continue;

    cost[cell] = STEP_COST + breachPenalty(structure.health);
  }

  for (const seed of seeds) cost[seed] = STEP_COST;

  return cost;
};

/** Клетки, от которых расходится поле: всё основание постройки-цели. */
export const targetSeeds = (target: StructureState | undefined): readonly number[] => {
  if (target === undefined) return [];

  return footprintCells(target.cell, STRUCTURE_STATS[target.kind].footprintRadius);
};

export const buildNavField = (
  occupancy: Occupancy,
  structures: readonly StructureState[],
  owner: PlayerId,
  target: StructureState | undefined,
  revision: number,
  tick: TickNumber,
): NavField => {
  const seeds = targetSeeds(target);

  return {
    walk: dijkstraField(walkCostArray(occupancy, seeds), seeds),
    breach: dijkstraField(breachCostArray(occupancy, structures, owner, seeds), seeds),
    revision,
    computedAtTick: tick,
  };
};

/** Пустое поле: всё недостижимо. Нужно, когда цели не существует. */
export const emptyNavField = (revision: number): NavField => ({
  walk: new Int32Array(MAP_CELL_COUNT).fill(UNREACHABLE),
  breach: new Int32Array(MAP_CELL_COUNT).fill(UNREACHABLE),
  revision,
  computedAtTick: asTickNumber(0),
});

export interface StepChoice {
  /** Клетка, в которую следует шагнуть, либо -1. */
  readonly cell: number;
  /** Индекс постройки, стоящей в этой клетке, либо -1. */
  readonly structureIndex: number;
}

export const NO_STEP: StepChoice = { cell: -1, structureIndex: NO_STRUCTURE };

/**
 * Куда шагнуть из данной клетки, чтобы приблизиться к цели.
 *
 * Проходимость берётся из свежей сетки занятости, а расстояния — из поля,
 * которое может отставать на несколько тиков. Расхождение безопасно:
 * юнит никогда не войдёт в занятую клетку, он лишь несколько тиков
 * подержится за слегка устаревший градиент.
 */
export const bestStep = (
  distances: Int32Array,
  occupancy: Occupancy,
  structures: readonly StructureState[],
  owner: PlayerId,
  from: number,
  allowBreach: boolean,
): StepChoice => {
  const x = cellX(from);
  const y = cellY(from);
  const here = distances[from] ?? UNREACHABLE;

  let bestCell = -1;
  let bestStructure = NO_STRUCTURE;
  let bestDistance = UNREACHABLE;

  const enterable = (cell: number): number | undefined => {
    if (occupancy.blocked[cell] !== 1) return NO_STRUCTURE;
    if (!allowBreach) return undefined;

    const index = occupancy.structureAt[cell] ?? NO_STRUCTURE;
    if (index === NO_STRUCTURE) return undefined;

    const structure = structures[index];
    if (structure === undefined || structure.owner === owner) return undefined;

    return index;
  };

  for (const [dx, dy] of NEIGHBOURS) {
    const nx = x + dx;
    const ny = y + dy;
    if (!isInsideMap(nx, ny)) continue;

    const next = cellIndex(nx, ny);
    const structureIndex = enterable(next);
    if (structureIndex === undefined) continue;

    if (dx !== 0 && dy !== 0) {
      if (enterable(cellIndex(nx, y)) === undefined) continue;
      if (enterable(cellIndex(x, ny)) === undefined) continue;
    }

    const distance = distances[next] ?? UNREACHABLE;
    if (distance >= bestDistance) continue;

    bestDistance = distance;
    bestCell = next;
    bestStructure = structureIndex;
  }

  if (bestCell < 0 || bestDistance === UNREACHABLE) return NO_STEP;

  // Никуда не идём, если стоим в локальном минимуме: значит, мы уже
  // настолько близко к цели, насколько поле позволяет.
  if (here !== UNREACHABLE && bestDistance >= here) return NO_STEP;

  return { cell: bestCell, structureIndex: bestStructure };
};
