import { describe, expect, it } from 'vitest';
import {
  STRUCTURE_STATS,
  StructureKind,
  TICKS_PER_SECOND,
  UnitType,
  asEntityId,
  asPlayerId,
  asTickNumber,
  cellsToUnits,
  PPM_ONE,
} from '@td/shared';
import { createWorld } from '@td/sim';
import type { StructureState, UnitState, WorldState } from '@td/sim';
import { sidesOf } from './sides.js';

/**
 * Числа в верхней полосе — единственное, чем игрок оценивает соперника
 * не глядя. Ошибка здесь не выглядит ошибкой: полоса покажет уверенное
 * число, просто не то. Поэтому проверяется не «функция что-то вернула»,
 * а совпадение с составом мира по каждой стороне отдельно.
 */

const world = createWorld(1234);

const unit = (owner: number, unitType: UnitType, id: number): UnitState => ({
  id: asEntityId(id),
  owner: asPlayerId(owner),
  unitType,
  position: { x: cellsToUnits(10), y: cellsToUnits(10) },
  health: 100,
  facing: 1,
  readyAtTick: asTickNumber(0),
});

const structure = (owner: number, kind: StructureKind, id: number): StructureState => ({
  id: asEntityId(id),
  owner: asPlayerId(owner),
  kind,
  cell: id,
  health: STRUCTURE_STATS[kind].health,
  growthPpm: PPM_ONE,
  readyAtTick: asTickNumber(0),
  builtAtTick: asTickNumber(0),
  demolishAtTick: asTickNumber(0),
  facing: 1,
});

const withEntities = (
  units: readonly UnitState[],
  extraStructures: readonly StructureState[],
): WorldState => ({
  ...world,
  units,
  structures: [...world.structures, ...extraStructures],
});

describe('состав сторон', () => {
  it('юниты считаются по типу и по владельцу отдельно', () => {
    const sides = sidesOf(
      withEntities(
        [
          unit(0, UnitType.Assault, 101),
          unit(0, UnitType.Assault, 102),
          unit(0, UnitType.Assault, 103),
          unit(0, UnitType.Sniper, 104),
          unit(1, UnitType.Tesla, 105),
          unit(1, UnitType.Tesla, 106),
        ],
        [],
      ),
    );

    expect(sides[0]?.unitCounts[UnitType.Assault]).toBe(3);
    expect(sides[0]?.unitCounts[UnitType.Sniper]).toBe(1);
    expect(sides[0]?.unitCounts[UnitType.Tesla]).toBe(0);

    expect(sides[1]?.unitCounts[UnitType.Assault]).toBe(0);
    expect(sides[1]?.unitCounts[UnitType.Tesla]).toBe(2);
  });

  it('постройки считаются по виду и по владельцу отдельно', () => {
    const sides = sidesOf(
      withEntities(
        [],
        [
          structure(0, StructureKind.Wall, 201),
          structure(0, StructureKind.Wall, 202),
          structure(0, StructureKind.TowerBasic, 203),
          structure(1, StructureKind.TowerSniper, 204),
        ],
      ),
    );

    expect(sides[0]?.structureCounts[StructureKind.Wall]).toBe(2);
    expect(sides[0]?.structureCounts[StructureKind.TowerBasic]).toBe(1);
    expect(sides[0]?.structureCounts[StructureKind.TowerSniper]).toBe(0);

    expect(sides[1]?.structureCounts[StructureKind.TowerSniper]).toBe(1);
    expect(sides[1]?.structureCounts[StructureKind.Wall]).toBe(0);
  });

  it('прочность базы берётся у своего владельца, а не у первой попавшейся', () => {
    // Базы у обеих сторон стоят с начала матча, и перепутать их владельцев
    // легко: обе одного вида и обе целые. Разводим их по здоровью.
    const damaged = world.structures.map((entry) =>
      entry.kind === StructureKind.Base && entry.owner === 1 ? { ...entry, health: 777 } : entry,
    );

    const sides = sidesOf({ ...world, structures: damaged });

    expect(sides[0]?.baseHealth).toBe(STRUCTURE_STATS[StructureKind.Base].health);
    expect(sides[1]?.baseHealth).toBe(777);
  });

  it('разрушенная база даёт ноль прочности, а не предел', () => {
    const withoutSecondBase = world.structures.filter(
      (entry) => !(entry.kind === StructureKind.Base && entry.owner === 1),
    );

    const sides = sidesOf({ ...world, structures: withoutSecondBase });

    expect(sides[1]?.baseHealth).toBe(0);
    // Предел остаётся: он свойство вида, а не уцелевшей постройки,
    // и полоса прочности без него не рисуется.
    expect(sides[1]?.baseMaxHealth).toBeGreaterThan(0);
  });

  it('павший генерал показывает секунды до возрождения', () => {
    const generals = world.generals.map((general, index) =>
      index === 1
        ? { ...general, alive: false, respawnAtTick: asTickNumber(TICKS_PER_SECOND * 4) }
        : general,
    );

    const sides = sidesOf({ ...world, generals, tick: asTickNumber(TICKS_PER_SECOND) });

    expect(sides[0]?.generalAlive).toBe(true);
    expect(sides[0]?.respawnInSeconds).toBe(0);

    expect(sides[1]?.generalAlive).toBe(false);
    expect(sides[1]?.respawnInSeconds).toBe(3);
  });

  it('в начале матча у обеих сторон пусто, но базы целы', () => {
    const sides = sidesOf(world);

    expect(sides).toHaveLength(2);

    for (const side of sides) {
      expect(side.unitCounts.every((value) => value === 0)).toBe(true);
      expect(side.structureCounts[StructureKind.Wall]).toBe(0);
      expect(side.baseHealth).toBe(side.baseMaxHealth);
      expect(side.generalAlive).toBe(true);
    }
  });
});
