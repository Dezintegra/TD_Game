import type { Graphics } from 'pixi.js';
import {
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  StructureKind,
  Terrain,
  unitsToCells,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { cellIndex, cellX, cellY } from '@td/sim';
import type { GameMap, WorldState } from '@td/sim';

/**
 * Миникарта.
 *
 * Тумана войны в игре нет, поэтому миникарта — не схема местности,
 * а инструмент управления вниманием: узкое место игрока не в знании,
 * а в том, что за раз видно около десятой части поля.
 *
 * Рисуется средствами PixiJS в экранных координатах, а не React. Иначе
 * пришлось бы возить позиции сотен сущностей через store, а store
 * по правилам проекта возит только то, что видно в HUD.
 *
 * Проекция здесь прямая, вид сверху, без изометрии. Это сознательное
 * расхождение с полем: миникарта отвечает на вопрос «где что», и квадрат
 * отвечает на него точнее, чем ромб, в котором расстояния по осям
 * выглядят по-разному.
 */

export interface MinimapLayout {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

export interface MinimapColors {
  readonly background: number;
  readonly border: number;
  readonly rock: number;
  readonly self: number;
  readonly enemy: number;
  readonly viewport: number;
}

const PADDING_PX = 16;

/** Отступ миникарты от края экрана и её доля от высоты окна. */
export const minimapLayout = (viewportWidth: number, viewportHeight: number): MinimapLayout => {
  const size = Math.round(Math.min(220, Math.max(140, viewportHeight * 0.22)));

  return { x: viewportWidth - size - PADDING_PX, y: PADDING_PX, size };
};

const scaleOf = (layout: MinimapLayout): number => layout.size / MAP_WIDTH_CELLS;

/**
 * Отрисовка неподвижной части: рамки и скал.
 *
 * Вынесена отдельно, потому что перестраивается только при смене карты.
 * Девять тысяч клеток каждый кадр не стоят ничего полезного.
 */
export const drawMinimapTerrain = (
  graphics: Graphics,
  map: GameMap,
  layout: MinimapLayout,
  colors: MinimapColors,
): void => {
  graphics.clear();

  graphics
    .rect(layout.x, layout.y, layout.size, layout.size)
    .fill({ color: colors.background, alpha: 0.75 })
    .stroke({ width: 1, color: colors.border, alpha: 0.9 });

  const scale = scaleOf(layout);
  const dot = Math.max(1, Math.ceil(scale));

  for (let y = 0; y < MAP_HEIGHT_CELLS; y += 1) {
    for (let x = 0; x < MAP_WIDTH_CELLS; x += 1) {
      if (map.cells[cellIndex(x, y)] === Terrain.Ground) continue;

      graphics.rect(layout.x + x * scale, layout.y + y * scale, dot, dot);
    }
  }

  graphics.fill({ color: colors.rock, alpha: 0.55 });
};

/**
 * Отрисовка подвижной части: построек, юнитов, генералов и рамки обзора.
 *
 * Вызывается не каждый кадр, а несколько раз в секунду: миникарта нужна
 * для оценки обстановки, и десять обновлений в секунду человек не отличит
 * от шестидесяти, а рисовать приходится сотни точек.
 */
export const drawMinimapEntities = (
  graphics: Graphics,
  world: WorldState,
  localPlayer: PlayerId,
  viewCorners: readonly { readonly x: number; readonly y: number }[],
  layout: MinimapLayout,
  colors: MinimapColors,
): void => {
  graphics.clear();

  const scale = scaleOf(layout);
  const toX = (cell: number): number => layout.x + cell * scale;
  const toY = (cell: number): number => layout.y + cell * scale;

  const paint = (owner: PlayerId, plot: () => void): void => {
    plot();
    graphics.fill({ color: owner === localPlayer ? colors.self : colors.enemy, alpha: 0.9 });
  };

  for (const structure of world.structures) {
    const size = structure.kind === StructureKind.Base ? 7 : 3;
    const offset = (size - Math.max(1, scale)) / 2;

    paint(structure.owner, () =>
      graphics.rect(
        toX(cellX(structure.cell)) - offset,
        toY(cellY(structure.cell)) - offset,
        size,
        size,
      ),
    );
  }

  for (const unit of world.units) {
    paint(unit.owner, () =>
      graphics.rect(toX(unitsToCells(unit.position.x)), toY(unitsToCells(unit.position.y)), 2, 2),
    );
  }

  for (const general of world.generals) {
    if (!general.alive) continue;

    paint(general.owner, () =>
      graphics.circle(
        toX(unitsToCells(general.position.x)),
        toY(unitsToCells(general.position.y)),
        4,
      ),
    );
  }

  if (viewCorners.length === 4) {
    const first = viewCorners[0];
    if (first === undefined) return;

    graphics.moveTo(toX(first.x), toY(first.y));
    for (let index = 1; index < viewCorners.length; index += 1) {
      const corner = viewCorners[index];
      if (corner !== undefined) graphics.lineTo(toX(corner.x), toY(corner.y));
    }
    graphics.closePath();
    graphics.stroke({ width: 1, color: colors.viewport, alpha: 0.8 });
  }
};

/**
 * Клетка карты под точкой экрана, либо -1, если точка вне миникарты.
 *
 * Нужна для перевода камеры кликом: раз миникарта показывает, что
 * происходит за краем экрана, по ней должно быть можно туда и перейти.
 */
export const minimapCellAt = (screenX: number, screenY: number, layout: MinimapLayout): number => {
  const scale = scaleOf(layout);
  const x = Math.floor((screenX - layout.x) / scale);
  const y = Math.floor((screenY - layout.y) / scale);

  if (x < 0 || y < 0 || x >= MAP_WIDTH_CELLS || y >= MAP_HEIGHT_CELLS) return -1;

  return cellIndex(x, y);
};
