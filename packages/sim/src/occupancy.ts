import { MAP_CELL_COUNT, STRUCTURE_STATS, Terrain } from '@td/shared';
import { cellIndex, cellX, cellY, isInsideMap } from './map.js';
import type { GameMap } from './map.js';
import type { StructureState } from './world.js';

/**
 * Сетка занятости клеток.
 *
 * Проверять «занята ли клетка» перебором всех построек значило бы платить
 * длиной списка построек за каждый шаг каждого юнита. Сетка строится один
 * раз за тик и отвечает за одно обращение по индексу.
 *
 * Перестраивать её каждый тик дешевле, чем поддерживать инкрементально:
 * девять тысяч записей — это доли миллисекунды, а инкрементальное
 * обновление пришлось бы аккуратно откатывать вместе с состоянием мира.
 */
export interface Occupancy {
  /** Ноль — свободно, единица — занято скалой или постройкой. */
  readonly blocked: Uint8Array;
  /** Индекс постройки в массиве структур, либо -1. */
  readonly structureAt: Int32Array;
}

export const NO_STRUCTURE = -1;

/**
 * Обходит все клетки основания постройки.
 *
 * Основание квадратное и задаётся радиусом: ноль — одна клетка,
 * единица — площадка три на три. Радиус, а не ширина, потому что
 * постройка задаётся центром, и с радиусом не возникает вопроса,
 * куда девать чётную ширину.
 */
export const forEachFootprintCell = (
  centre: number,
  radius: number,
  visit: (cell: number) => void,
): void => {
  if (radius === 0) {
    visit(centre);
    return;
  }

  const cx = cellX(centre);
  const cy = cellY(centre);

  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (isInsideMap(x, y)) visit(cellIndex(x, y));
    }
  }
};

export const footprintCells = (centre: number, radius: number): readonly number[] => {
  const cells: number[] = [];
  forEachFootprintCell(centre, radius, (cell) => cells.push(cell));
  return cells;
};

export const buildOccupancy = (map: GameMap, structures: readonly StructureState[]): Occupancy => {
  const blocked = new Uint8Array(MAP_CELL_COUNT);
  const structureAt = new Int32Array(MAP_CELL_COUNT).fill(NO_STRUCTURE);

  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    if (map.cells[cell] !== Terrain.Ground) blocked[cell] = 1;
  }

  structures.forEach((structure, index) => {
    const radius = STRUCTURE_STATS[structure.kind].footprintRadius;

    forEachFootprintCell(structure.cell, radius, (cell) => {
      blocked[cell] = 1;
      structureAt[cell] = index;
    });
  });

  return { blocked, structureAt };
};
