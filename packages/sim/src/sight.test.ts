import { describe, expect, it } from 'vitest';
import { MAP_CELL_COUNT, StructureKind, Terrain } from '@td/shared';
import { cellCentre, cellIndex } from './map.js';
import type { GameMap } from './map.js';
import { buildSightGrid, hasLineOfSight } from './sight.js';

/**
 * Линия огня.
 *
 * Правило проверяется на голой карте с одной-двумя вручную выставленными
 * клетками: так видно, что именно перекрывает линию, и тест не зависит
 * ни от генерации мира, ни от баланса.
 */

const emptyMap = (): GameMap => ({ cells: new Uint8Array(MAP_CELL_COUNT), baseCells: [] });

const withRock = (x: number, y: number): GameMap => {
  const map = emptyMap();
  map.cells[cellIndex(x, y)] = Terrain.Rock;
  return map;
};

const wallAt = (x: number, y: number) => ({
  kind: StructureKind.Wall,
  cell: cellIndex(x, y),
});

/** Точка в центре клетки: юниты и постройки стоят именно там. */
const at = (x: number, y: number) => cellCentre(cellIndex(x, y));

/** Цель — точка (юнит или генерал): основание нулевого радиуса. */
const seesPoint = (
  grid: ReturnType<typeof buildSightGrid>,
  elevated: boolean,
  from: readonly [number, number],
  to: readonly [number, number],
): boolean => hasLineOfSight(grid, elevated, at(...from), at(...to), cellIndex(...to), 0);

describe('линия огня', () => {
  it('на пустой карте линия свободна', () => {
    const grid = buildSightGrid(emptyMap(), []);

    expect(seesPoint(grid, false, [10, 10], [16, 10])).toBe(true);
    expect(seesPoint(grid, false, [10, 10], [16, 16])).toBe(true);
  });

  it('скала перекрывает линию и пешему, и башне', () => {
    const grid = buildSightGrid(withRock(13, 10), []);

    expect(seesPoint(grid, false, [10, 10], [16, 10])).toBe(false);
    expect(seesPoint(grid, true, [10, 10], [16, 10])).toBe(false);
  });

  it('стена перекрывает линию пешему, но не башне', () => {
    const grid = buildSightGrid(emptyMap(), [wallAt(13, 10)]);

    expect(seesPoint(grid, false, [10, 10], [16, 10])).toBe(false);
    expect(seesPoint(grid, true, [10, 10], [16, 10])).toBe(true);
  });

  it('разрушенная стена линию не перекрывает', () => {
    const grid = buildSightGrid(emptyMap(), [{ ...wallAt(13, 10), alive: false }]);

    expect(seesPoint(grid, false, [10, 10], [16, 10])).toBe(true);
  });

  it('клетка самой цели не мешает по ней стрелять', () => {
    // Стена — цель юнита. Если бы её собственная клетка перекрывала линию,
    // сломать стену было бы нельзя вообще никогда.
    const grid = buildSightGrid(emptyMap(), [wallAt(13, 10)]);

    expect(hasLineOfSight(grid, false, at(10, 10), at(13, 10), cellIndex(13, 10), 0)).toBe(true);
  });

  it('основание цели прозрачно целиком, а не только её центр', () => {
    // База занимает три на три, а линия ведётся к её центру. Без прозрачности
    // всего основания край базы закрывал бы её же середину, и достать до базы
    // было бы нельзя.
    const grid = buildSightGrid(withRock(13, 10), []);

    expect(hasLineOfSight(grid, false, at(10, 10), at(14, 10), cellIndex(14, 10), 1)).toBe(true);
    // Тот же рельеф, но цель — точка: скала снова мешает.
    expect(hasLineOfSight(grid, false, at(10, 10), at(14, 10), cellIndex(14, 10), 0)).toBe(false);
  });

  it('клетка, из которой ведётся огонь, линию не перекрывает', () => {
    const grid = buildSightGrid(withRock(10, 10), []);

    expect(seesPoint(grid, false, [10, 10], [13, 10])).toBe(true);
  });

  it('соседняя клетка видна всегда', () => {
    const grid = buildSightGrid(withRock(11, 11), []);

    expect(seesPoint(grid, false, [10, 10], [10, 11])).toBe(true);
  });
});
