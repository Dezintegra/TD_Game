import { describe, expect, it } from 'vitest';
import {
  DIRECTION_SOUTH,
  MAP_WIDTH_CELLS,
  StructureKind,
  asEntityId,
  asPlayerId,
  asTickNumber,
} from '@td/shared';
import type { StructureState } from '@td/sim';
import { cellIndex } from '@td/sim';
import {
  WALL_LINK_EAST,
  WALL_LINK_NORTH,
  WALL_LINK_SOUTH,
  WALL_LINK_WEST,
  WallShape,
  wallLook,
} from './structures.js';
import { wallLinks } from './walls.js';

/**
 * Связи стен — единственное в облике постройки, что зависит не от неё
 * самой, а от соседей. Поэтому и проверяются они отдельно от геометрии:
 * ошибка здесь выглядит не «стена кривая», а «стена не той формы»,
 * и на картинке её легко списать на вкус.
 */

const TICK = asTickNumber(100);

let nextId = 1;

interface WallOptions {
  readonly owner?: number;
  readonly builtAt?: number;
}

const wall = (x: number, y: number, options: WallOptions = {}): StructureState =>
  ({
    id: asEntityId(nextId++),
    owner: asPlayerId(options.owner ?? 0),
    kind: StructureKind.Wall,
    cell: cellIndex(x, y),
    health: 100,
    kills: 0,
    readyAtTick: asTickNumber(0),
    builtAtTick: asTickNumber(options.builtAt ?? 0),
    demolishAtTick: asTickNumber(0),
    facing: DIRECTION_SOUTH,
  }) as StructureState;

const tower = (x: number, y: number): StructureState =>
  ({ ...wall(x, y), kind: StructureKind.TowerBasic }) as StructureState;

const maskAt = (structures: readonly StructureState[], x: number, y: number): number =>
  wallLinks(structures, TICK).get(cellIndex(x, y)) ?? -1;

describe('связи стен', () => {
  it('ряд читается одной стеной: прогон посередине, оголовки по краям', () => {
    const row = [wall(10, 10), wall(11, 10), wall(12, 10)];

    expect(wallLook(maskAt(row, 11, 10)).shape).toBe(WallShape.Straight);
    expect(wallLook(maskAt(row, 10, 10)).shape).toBe(WallShape.End);
    expect(wallLook(maskAt(row, 12, 10)).shape).toBe(WallShape.End);
  });

  it('четыре соседа дают перекрестье, три — тройник', () => {
    const cross = [wall(10, 10), wall(9, 10), wall(11, 10), wall(10, 9), wall(10, 11)];
    expect(wallLook(maskAt(cross, 10, 10)).shape).toBe(WallShape.Cross);

    const tee = [wall(10, 10), wall(9, 10), wall(11, 10), wall(10, 11)];
    expect(wallLook(maskAt(tee, 10, 10)).shape).toBe(WallShape.Tee);
  });

  it('две стены под углом дают угол', () => {
    const corner = [wall(10, 10), wall(10, 11), wall(9, 10)];
    expect(wallLook(maskAt(corner, 10, 10)).shape).toBe(WallShape.Corner);
  });

  it('стороны света в маске стоят там, где стоят соседи', () => {
    const pair = [wall(10, 10), wall(11, 10)];

    // Ось X растёт на восток, ось Y — на юг (`direction.ts`).
    expect(maskAt(pair, 10, 10)).toBe(WALL_LINK_EAST);
    expect(maskAt(pair, 11, 10)).toBe(WALL_LINK_WEST);

    const column = [wall(10, 10), wall(10, 11)];
    expect(maskAt(column, 10, 10)).toBe(WALL_LINK_SOUTH);
    expect(maskAt(column, 10, 11)).toBe(WALL_LINK_NORTH);
  });

  it('чужая стена связи не даёт', () => {
    // Цвет на поле означает принадлежность, и сплошная линия из чужих
    // и своих сообщала бы ложное.
    const mixed = [wall(10, 10), wall(11, 10, { owner: 1 })];

    expect(maskAt(mixed, 10, 10)).toBe(0);
    expect(maskAt(mixed, 11, 10)).toBe(0);
  });

  it('недостроенная стена не связывается ни с кем', () => {
    // Связь обязана быть взаимной: свяжись достроенная с недостроенной,
    // вышел бы мост в один пролёт, упирающийся в пустоту.
    const pair = [wall(10, 10), wall(11, 10, { builtAt: 500 })];
    const links = wallLinks(pair, TICK);

    expect(links.get(cellIndex(10, 10))).toBe(0);
    expect(links.has(cellIndex(11, 10))).toBe(false);
  });

  it('достройка защёлкивает стену в линию', () => {
    const pair = [wall(10, 10), wall(11, 10, { builtAt: 500 })];

    expect(wallLinks(pair, asTickNumber(499)).get(cellIndex(10, 10))).toBe(0);
    expect(wallLinks(pair, asTickNumber(500)).get(cellIndex(10, 10))).toBe(WALL_LINK_EAST);
  });

  it('диагональ связью не считается', () => {
    // Между стенами, соприкоснувшимися углами, юнит проходит, и перемычка
    // соврала бы о проходимости.
    const diagonal = [wall(10, 10), wall(11, 11)];

    expect(maskAt(diagonal, 10, 10)).toBe(0);
  });

  it('башня рядом со стеной связи не даёт', () => {
    const mixed = [wall(10, 10), tower(11, 10)];

    expect(maskAt(mixed, 10, 10)).toBe(0);
  });

  it('край карты не связывает противоположные ряды', () => {
    // Ловушка, ради которой выход за карту проверяется по обеим осям
    // отдельно: клетка за левым краем ряда — это последняя клетка ряда
    // предыдущего, и одного сравнения индекса с длиной массива мало.
    const edges = [wall(0, 10), wall(MAP_WIDTH_CELLS - 1, 9)];

    expect(maskAt(edges, 0, 10)).toBe(0);
    expect(maskAt(edges, MAP_WIDTH_CELLS - 1, 9)).toBe(0);
  });

  it('пустой матч не стоит ничего и не даёт связей', () => {
    expect(wallLinks([], TICK).size).toBe(0);
    expect(wallLinks([tower(10, 10)], TICK).size).toBe(0);
  });

  it('прошлый расчёт не просачивается в следующий', () => {
    // Раскладка по клеткам переиспользуется между кадрами, и стена,
    // снесённая минуту назад, не имеет права держать связь.
    const before = [wall(10, 10), wall(11, 10)];
    expect(maskAt(before, 10, 10)).toBe(WALL_LINK_EAST);

    const after = [wall(10, 10)];
    expect(maskAt(after, 10, 10)).toBe(0);
  });
});
