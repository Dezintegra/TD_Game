import { describe, expect, it } from 'vitest';
import {
  DIRECTION_SOUTH,
  MAP_CELL_COUNT,
  MAP_HEIGHT_CELLS,
  PPM_ONE,
  StructureKind,
  asEntityId,
  asPlayerId,
  asTickNumber,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { cellIndex } from './map.js';
import { NO_STRUCTURE } from './occupancy.js';
import type { Occupancy } from './occupancy.js';
import { UNREACHABLE, bestStep, buildNavField, dijkstraField } from './navigation.js';
import type { StructureState } from './world.js';

/**
 * Навигация проверяется на синтетических картах, а не на сгенерированных.
 *
 * Причина простая: утверждения вроде «обход длиннее пролома» требуют
 * точно известной геометрии. На случайной карте такой тест проверял бы
 * не алгоритм, а удачу конкретного seed.
 */

const ME = asPlayerId(0);
const ENEMY = asPlayerId(1);

/** Пустая занятость: вся карта проходима. */
const emptyOccupancy = (): { blocked: Uint8Array; structureAt: Int32Array } => ({
  blocked: new Uint8Array(MAP_CELL_COUNT),
  structureAt: new Int32Array(MAP_CELL_COUNT).fill(NO_STRUCTURE),
});

const structure = (
  index: number,
  owner: PlayerId,
  cell: number,
  kind: StructureKind,
  health: number,
): StructureState => ({
  id: asEntityId(index + 1),
  owner,
  kind,
  cell,
  health,
  growthPpm: PPM_ONE,
  readyAtTick: asTickNumber(0),
  builtAtTick: asTickNumber(0),
  demolishAtTick: asTickNumber(0),
  facing: DIRECTION_SOUTH,
});

const uniformCost = (blocked: Uint8Array): Int32Array => {
  const cost = new Int32Array(MAP_CELL_COUNT);
  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    cost[cell] = blocked[cell] === 1 ? 0 : 1;
  }
  return cost;
};

describe('поле расстояний', () => {
  it('растёт по мере удаления от цели', () => {
    const occupancy = emptyOccupancy();
    const seed = cellIndex(10, 10);

    const distances = dijkstraField(uniformCost(occupancy.blocked), [seed]);

    expect(distances[seed]).toBe(0);
    expect(distances[cellIndex(11, 10)]).toBe(1);
    expect(distances[cellIndex(15, 10)]).toBe(5);
    expect(distances[cellIndex(15, 10)] ?? 0).toBeLessThan(distances[cellIndex(20, 10)] ?? 0);
  });

  it('диагональ считается одним шагом', () => {
    // Осознанное упрощение: восемь направлений с одинаковой ценой шага.
    // Точнее было бы взвесить прямые и диагонали как 10 и 14, но на
    // читаемость поведения это не влияет — см. design.md.
    const distances = dijkstraField(uniformCost(emptyOccupancy().blocked), [cellIndex(10, 10)]);

    expect(distances[cellIndex(11, 11)]).toBe(1);
  });

  it('обходит препятствие, а не проходит сквозь', () => {
    const occupancy = emptyOccupancy();
    // Стена по вертикали x = 5 с единственным проходом посреди карты.
    // Координаты считаются от размера карты, а не вписаны числами:
    // при уменьшении карты вписанные молча уехали бы за её край.
    const gapY = MAP_HEIGHT_CELLS / 2;

    for (let y = 0; y < MAP_HEIGHT_CELLS; y += 1) {
      if (y === gapY) continue;
      occupancy.blocked[cellIndex(5, y)] = 1;
    }

    const distances = dijkstraField(uniformCost(occupancy.blocked), [cellIndex(10, 10)]);

    // До клетки за стеной путь есть, но он много длиннее прямой линии
    // в десять клеток: приходится сделать крюк к единственному проходу.
    const behind = distances[cellIndex(0, 10)] ?? UNREACHABLE;
    expect(behind).not.toBe(UNREACHABLE);
    expect(behind).toBeGreaterThan(20);
  });

  it('не пропускает сквозь диагональный стык', () => {
    const occupancy = emptyOccupancy();
    // Всё непроходимо, кроме двух клеток по диагонали: (0,0) и (1,1).
    occupancy.blocked.fill(1);
    occupancy.blocked[cellIndex(0, 0)] = 0;
    occupancy.blocked[cellIndex(1, 1)] = 0;

    const distances = dijkstraField(uniformCost(occupancy.blocked), [cellIndex(0, 0)]);

    expect(distances[cellIndex(1, 1)]).toBe(UNREACHABLE);
  });
});

describe('пролом преград', () => {
  // Ряд, на котором стоят старт и цель, и два прохода на равном удалении
  // от него: слабый выше, прочный ниже. Считается от размера карты.
  const MIDDLE_Y = MAP_HEIGHT_CELLS / 2;
  const GAP_OFFSET = 8;
  const WEAK_Y = MIDDLE_Y - GAP_OFFSET;
  const STRONG_Y = MIDDLE_Y + GAP_OFFSET;

  const START = cellIndex(0, MIDDLE_Y);

  /**
   * Карта: сплошная стена по вертикали x = 5 из вражеских построек.
   * Два прохода на равном удалении от старта и от цели: слабый и прочный.
   * Обычного пути до цели нет вовсе.
   */
  const sealedWorld = (): {
    occupancy: Occupancy;
    structures: StructureState[];
    target: StructureState;
  } => {
    const occupancy = emptyOccupancy();
    const structures: StructureState[] = [];

    for (let y = 0; y < MAP_HEIGHT_CELLS; y += 1) {
      const cell = cellIndex(5, y);
      occupancy.blocked[cell] = 1;

      if (y === WEAK_Y) {
        occupancy.structureAt[cell] = structures.length;
        structures.push(structure(structures.length, ENEMY, cell, StructureKind.Wall, 100));
        continue;
      }
      if (y === STRONG_Y) {
        occupancy.structureAt[cell] = structures.length;
        structures.push(structure(structures.length, ENEMY, cell, StructureKind.Wall, 3000));
        continue;
      }
      // Остальная стена — скала: непроходима и неразрушима.
    }

    const targetCell = cellIndex(10, MIDDLE_Y);
    const target = structure(structures.length, ENEMY, targetCell, StructureKind.TowerBasic, 200);
    structures.push(target);
    occupancy.blocked[targetCell] = 1;
    occupancy.structureAt[targetCell] = structures.length - 1;

    return { occupancy, structures, target };
  };

  it('обычное поле не находит пути через запечатанную стену', () => {
    const { occupancy, structures, target } = sealedWorld();

    const field = buildNavField(occupancy, structures, ME, target, 1, asTickNumber(0));

    expect(field.walk[START]).toBe(UNREACHABLE);
  });

  it('поле пролома находит путь и предпочитает слабую преграду', () => {
    const { occupancy, structures, target } = sealedWorld();

    const field = buildNavField(occupancy, structures, ME, target, 1, asTickNumber(0));

    expect(field.breach[START]).not.toBe(UNREACHABLE);
    // Подход к слабой преграде обходится дешевле, чем к прочной,
    // хотя расстояния до них от цели одинаковы.
    expect(field.breach[cellIndex(4, WEAK_Y)] ?? 0).toBeLessThan(
      field.breach[cellIndex(4, STRONG_Y)] ?? 0,
    );
  });

  it('юнит доходит до слабой преграды и упирается именно в неё', () => {
    const { occupancy, structures, target } = sealedWorld();
    const field = buildNavField(occupancy, structures, ME, target, 1, asTickNumber(0));

    let cell = START;
    let blocker = NO_STRUCTURE;

    for (let guard = 0; guard < 200 && blocker === NO_STRUCTURE; guard += 1) {
      const next = bestStep(field.breach, occupancy, structures, ME, cell, true);
      if (next.cell < 0) break;

      cell = next.cell;
      blocker = next.structureIndex;
    }

    expect(blocker).not.toBe(NO_STRUCTURE);
    expect(structures[blocker]?.cell).toBe(cellIndex(5, WEAK_Y));
  });

  it('свои постройки юнит не ломает', () => {
    const { occupancy, structures, target } = sealedWorld();
    // Обе преграды становятся своими — ломать их юнит не станет,
    // и путь пропадает даже в поле пролома.
    const mine = structures.map((entry) =>
      entry.kind === StructureKind.Wall ? { ...entry, owner: ME } : entry,
    );

    const field = buildNavField(occupancy, mine, ME, target, 1, asTickNumber(0));

    expect(field.breach[START]).toBe(UNREACHABLE);
  });
});

describe('выбор шага', () => {
  it('ведёт в сторону уменьшения расстояния', () => {
    const occupancy = emptyOccupancy();
    const from = cellIndex(20, 10);
    const distances = dijkstraField(uniformCost(occupancy.blocked), [cellIndex(10, 10)]);

    const step = bestStep(distances, occupancy, [], ME, from, false);

    // Проверяется свойство, а не конкретная клетка: при равных
    // расстояниях у нескольких соседей выбор между ними произволен,
    // и требовать определённую клетку значило бы закрепить в тесте
    // порядок перебора соседей.
    expect(step.cell).toBeGreaterThanOrEqual(0);
    expect(distances[step.cell] ?? 0).toBeLessThan(distances[from] ?? 0);
  });

  it('приводит к цели, если идти по нему до упора', () => {
    const occupancy = emptyOccupancy();
    const target = cellIndex(10, 10);
    const distances = dijkstraField(uniformCost(occupancy.blocked), [target]);

    let cell = cellIndex(30, 25);
    for (let guard = 0; guard < 100; guard += 1) {
      const step = bestStep(distances, occupancy, [], ME, cell, false);
      if (step.cell < 0) break;
      cell = step.cell;
    }

    expect(cell).toBe(target);
  });

  it('стоя на цели, никуда не ведёт', () => {
    const occupancy = emptyOccupancy();
    const distances = dijkstraField(uniformCost(occupancy.blocked), [cellIndex(10, 10)]);

    expect(bestStep(distances, occupancy, [], ME, cellIndex(10, 10), false).cell).toBe(-1);
  });
});
