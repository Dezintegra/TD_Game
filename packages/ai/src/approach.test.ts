import { describe, expect, it } from 'vitest';
import {
  DIRECTION_SOUTH,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  STRUCTURE_STATS,
  StructureKind,
  Terrain,
  asEntityId,
  asPlayerId,
  asTickNumber,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { cellIndex, createWorld } from '@td/sim';
import type { WorldState } from '@td/sim';
import { approachOf, corridorWidthAt, corridorWidths, sealsApproach } from './approach.js';

/**
 * Проверка «не запереть себя».
 *
 * Запечатывание прохода — законный ход, и ядро его не запрещает. Запечатать
 * можно и СЕБЕ: своё войско выходит из своей базы, и стена, закрывшая
 * последнюю щель, останавливает его так же надёжно, как чужое.
 */

const ME: PlayerId = asPlayerId(0);
const SEED = 20260821;

/**
 * Карта с единственным проходом.
 *
 * Всё поле — скала, кроме коридора в одну клетку по строке базы. Такой
 * мир не встретится в игре, и в этом весь смысл: проверяется правило,
 * а не удача расстановки.
 */
const corridor = (): { world: WorldState; gate: number } => {
  const world = createWorld(SEED);
  const cells = Uint8Array.from(world.map.cells).fill(Terrain.Rock);

  const home = world.map.baseCells[ME] ?? 0;
  const enemy = world.map.baseCells[1] ?? 0;

  const hx = home % MAP_WIDTH_CELLS;
  const hy = Math.floor(home / MAP_WIDTH_CELLS);
  const ex = enemy % MAP_WIDTH_CELLS;
  const ey = Math.floor(enemy / MAP_WIDTH_CELLS);

  const clear = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= MAP_WIDTH_CELLS || y >= MAP_HEIGHT_CELLS) return;
    cells[cellIndex(x, y)] = Terrain.Ground;
  };

  // Площадки вокруг обеих баз: без них разлив не начнётся вовсе.
  for (const [bx, by] of [
    [hx, hy],
    [ex, ey],
  ] as const) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) clear(bx + dx, by + dy);
    }
  }

  // Коридор шириной в клетку: сначала по строке своей базы, потом
  // по столбцу чужой.
  for (let x = Math.min(hx, ex); x <= Math.max(hx, ex); x += 1) clear(x, hy);
  for (let y = Math.min(hy, ey); y <= Math.max(hy, ey); y += 1) clear(ex, y);

  // Ворота — клетка строго между площадками баз, где коридор одинарный.
  const gate = cellIndex(Math.round((hx + ex) / 2), hy);

  return { world: { ...world, map: { ...world.map, cells } }, gate };
};

describe('постройка не должна запирать путь между базами', () => {
  it('в единственном проходе постройка запирает путь', () => {
    const { world, gate } = corridor();
    const approach = approachOf(world, ME);
    if (approach === undefined) throw new Error('вероятный путь не посчитан');

    expect(sealsApproach(world, ME, approach, gate)).toBe(true);
  });

  it('на обычной карте одна постройка пути не запирает', () => {
    // Обратная страховка: правило, запрещающее всё подряд, ничем не лучше
    // правила, не запрещающего ничего.
    const world = createWorld(SEED);
    const approach = approachOf(world, ME);
    if (approach === undefined) throw new Error('вероятный путь не посчитан');

    const open = approach.onPath.findIndex((value) => value === 1);
    expect(open).toBeGreaterThan(0);
    expect(sealsApproach(world, ME, approach, open)).toBe(false);
  });

  it('уже стоящие постройки в проверке учтены', () => {
    // Занятость берётся из вероятного пути, а он считается по нынешнему
    // набору построек: проверять надо мир, каким он станет, а не каким был.
    const { world, gate } = corridor();
    const approach = approachOf(world, ME);
    if (approach === undefined) throw new Error('вероятный путь не посчитан');

    const walled: WorldState = {
      ...world,
      structures: [
        ...world.structures,
        {
          id: asEntityId(9500),
          owner: ME,
          kind: StructureKind.Wall,
          cell: gate,
          health: STRUCTURE_STATS[StructureKind.Wall].health,
          kills: 0,
          readyAtTick: asTickNumber(0),
          builtAtTick: asTickNumber(0),
          demolishAtTick: asTickNumber(0),
          facing: DIRECTION_SOUTH,
        },
      ],
    };

    // Проход уже закрыт: вероятного пути между базами не существует вовсе.
    expect(approachOf(walled, ME)).toBeUndefined();
  });
});

/**
 * Карта с двумя раздельными проходами одинаковой глубины — «восьмёрка».
 *
 * Те же ворота, но коридоров два: по строке базы и через две строки
 * от неё, разделённые скалой. Нужна затем, чтобы показать границу мерки
 * ширины: она считает клетки по глубине и о том, что проходов два,
 * не знает.
 */
const twinCorridor = (): { world: WorldState; gate: number } => {
  const world = createWorld(SEED);
  const cells = Uint8Array.from(world.map.cells).fill(Terrain.Rock);

  const home = world.map.baseCells[ME] ?? 0;
  const enemy = world.map.baseCells[1] ?? 0;

  const hx = home % MAP_WIDTH_CELLS;
  const hy = Math.floor(home / MAP_WIDTH_CELLS);
  const ex = enemy % MAP_WIDTH_CELLS;
  const ey = Math.floor(enemy / MAP_WIDTH_CELLS);

  const clear = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= MAP_WIDTH_CELLS || y >= MAP_HEIGHT_CELLS) return;
    cells[cellIndex(x, y)] = Terrain.Ground;
  };

  for (const [bx, by] of [
    [hx, hy],
    [ex, ey],
  ] as const) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) clear(bx + dx, by + dy);
    }
  }

  // Два прохода в клетку шириной, между ними строка скалы.
  for (let x = Math.min(hx, ex); x <= Math.max(hx, ex); x += 1) {
    clear(x, hy);
    clear(x, hy + 2);
  }
  for (let y = Math.min(hy, ey); y <= Math.max(hy, ey); y += 1) clear(ex, y);

  return {
    world: { ...world, map: { ...world.map, cells } },
    gate: cellIndex(Math.round((hx + ex) / 2), hy),
  };
};

describe('ширина коридора по глубине', () => {
  it('в одинарном проходе ширина равна единице', () => {
    const { world, gate } = corridor();
    const approach = approachOf(world, ME);
    if (approach === undefined) throw new Error('вероятный путь не посчитан');

    const widths = corridorWidths(approach);

    expect(corridorWidthAt(approach, widths, gate)).toBe(1);
  });

  it('у своей базы коридор шире, чем в горле', () => {
    // Обратная страховка: мерка, отвечающая единицей везде, ничего
    // не измеряет. У базы расчищена площадка пять на пять, и коридор
    // там заведомо шире одинарного прохода.
    const { world, gate } = corridor();
    const approach = approachOf(world, ME);
    if (approach === undefined) throw new Error('вероятный путь не посчитан');

    const widths = corridorWidths(approach);
    const widest = Math.max(...widths);

    expect(widest).toBeGreaterThan(corridorWidthAt(approach, widths, gate));
  });

  it('два раздельных прохода складываются в одну ширину', () => {
    // Известная граница мерки: она видит узость по глубине, а не топологию.
    // Ошибка безопасная — горло из двух одинарных проходов выглядит вдвое
    // шире, чем оно есть, то есть противник осторожничает там, где мог бы
    // перекрывать. Обратной ошибки — счесть узким широкое место — мерка
    // не делает никогда.
    const { world, gate } = twinCorridor();
    const approach = approachOf(world, ME);
    if (approach === undefined) throw new Error('вероятный путь не посчитан');

    const widths = corridorWidths(approach);

    expect(corridorWidthAt(approach, widths, gate)).toBe(2);
  });
});
