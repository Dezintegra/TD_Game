import type { Graphics } from 'pixi.js';
import {
  NUKE_DELAY_TICKS,
  NUKE_RADIUS_CELLS,
  StructureKind,
  TICKS_PER_SECOND,
  unitsToCells,
} from '@td/shared';
import type { PlayerId, StructureKind as StructureKindType } from '@td/shared';
import { cellX, cellY, playerStats } from '@td/sim';
import type { WorldState } from '@td/sim';
import { ELEVATION_PX_PER_CELL, worldToScreen } from './iso.js';
import { traceCell } from './entities.js';

/**
 * Подсказки поверх поля: радиус строительства, метка цели, места ядерных
 * ударов, предпросмотр постройки.
 *
 * Это отдельный слой, а не часть отрисовки сущностей, и на то есть причина:
 * подсказки зависят не от состояния мира, а от того, что игрок сейчас
 * делает — держит ли режим строительства, куда навёл курсор. Мир и намерение
 * игрока меняются по разным законам, и мешать их в одном слое значит
 * перестраивать оба, когда изменился один.
 */

export interface OverlayColors {
  readonly self: number;
  readonly enemy: number;
  readonly valid: number;
  readonly invalid: number;
  readonly danger: number;
}

export interface OverlayIntent {
  /** Что игрок собирается строить, либо null. */
  readonly buildKind: StructureKindType | null;
  /** Игрок наводит ядерный удар. */
  readonly aimingNuke: boolean;
  /** Клетка под курсором, либо -1. */
  readonly hoverCell: number;
  /** Можно ли выполнить задуманное в клетке под курсором. */
  readonly hoverAllowed: boolean;
  /** Клетка с выделенным объектом, либо -1. */
  readonly selectedCell: number;
}

/** Сколько точек берётся на окружность. Больше — глаже, дороже. */
const CIRCLE_STEPS = 56;

export const drawOverlays = (
  graphics: Graphics,
  world: WorldState,
  localPlayer: PlayerId,
  intent: OverlayIntent,
  colors: OverlayColors,
): void => {
  graphics.clear();

  drawBuildRadius(graphics, world, localPlayer, intent, colors);
  drawTargetMarker(graphics, world, localPlayer, colors);
  drawNukes(graphics, world, localPlayer, colors);
  drawSelection(graphics, intent, colors);
  drawHover(graphics, intent, colors);
};

/**
 * Окружность в мировых координатах.
 *
 * Проекция линейна, но круг она превращает в наклонный эллипс, поэтому
 * рисовать его средствами PixiJS (`circle`) нельзя — получится круг
 * на экране, а не на земле. Считаем точки в мире и проецируем каждую.
 */
const traceWorldCircle = (
  graphics: Graphics,
  centreX: number,
  centreY: number,
  radiusCells: number,
): void => {
  for (let index = 0; index <= CIRCLE_STEPS; index += 1) {
    const angle = (index / CIRCLE_STEPS) * Math.PI * 2;
    const point = worldToScreen(
      centreX + Math.cos(angle) * radiusCells,
      centreY + Math.sin(angle) * radiusCells,
    );

    if (index === 0) graphics.moveTo(point.x, point.y);
    else graphics.lineTo(point.x, point.y);
  }
};

/**
 * Радиус строительства вокруг своего генерала.
 *
 * Показывается только в режиме строительства. Постоянно висящий круг
 * быстро перестаёт читаться и превращается в фон — а он должен отвечать
 * на конкретный вопрос «дотянусь ли я отсюда».
 */
const drawBuildRadius = (
  graphics: Graphics,
  world: WorldState,
  localPlayer: PlayerId,
  intent: OverlayIntent,
  colors: OverlayColors,
): void => {
  if (intent.buildKind === null) return;

  const general = world.generals[localPlayer];
  if (general === undefined || !general.alive) return;

  const player = world.players[localPlayer];
  if (player === undefined) return;

  const radius = unitsToCells(playerStats(player).general.buildRadius);

  traceWorldCircle(
    graphics,
    unitsToCells(general.position.x),
    unitsToCells(general.position.y),
    radius,
  );
  graphics.stroke({ width: 1.5, color: colors.self, alpha: 0.45 });
};

/**
 * Метка назначенной цели.
 *
 * Цель одна на всех юнитов, поэтому она должна быть видна всегда,
 * а не только при наведении: игрок обязан в любой момент понимать,
 * куда идёт его армия.
 */
const drawTargetMarker = (
  graphics: Graphics,
  world: WorldState,
  localPlayer: PlayerId,
  colors: OverlayColors,
): void => {
  const player = world.players[localPlayer];
  if (player === undefined) return;

  const target = world.structures.find((structure) => structure.id === player.targetStructure);
  if (target === undefined) return;

  const x = cellX(target.cell);
  const y = cellY(target.cell);
  const radius = target.kind === StructureKind.Base ? 2.2 : 1;

  traceWorldCircle(graphics, x + 0.5, y + 0.5, radius);
  graphics.stroke({ width: 2, color: colors.enemy, alpha: 0.9 });

  // Перекрестие: одна окружность на карте, полной построек, теряется.
  const centre = worldToScreen(x + 0.5, y + 0.5);
  const arm = 10;
  graphics
    .moveTo(centre.x - arm, centre.y)
    .lineTo(centre.x + arm, centre.y)
    .moveTo(centre.x, centre.y - arm)
    .lineTo(centre.x, centre.y + arm)
    .stroke({ width: 1.5, color: colors.enemy, alpha: 0.9 });
};

/**
 * Места ядерных ударов.
 *
 * Метка видна обеим сторонам — в этом весь смысл задержки: удар обязан
 * быть угрозой, на которую можно ответить, а не наказанием без права хода.
 * Кольцо сжимается по мере приближения взрыва, поэтому оставшееся время
 * читается без цифр.
 */
const drawNukes = (
  graphics: Graphics,
  world: WorldState,
  localPlayer: PlayerId,
  colors: OverlayColors,
): void => {
  for (const nuke of world.nukes) {
    const x = cellX(nuke.cell) + 0.5;
    const y = cellY(nuke.cell) + 0.5;
    const remaining = Math.max(0, nuke.detonateAtTick - world.tick);
    const progress = 1 - remaining / NUKE_DELAY_TICKS;

    traceWorldCircle(graphics, x, y, NUKE_RADIUS_CELLS);
    graphics.stroke({ width: 2, color: colors.danger, alpha: 0.85 });

    traceWorldCircle(graphics, x, y, NUKE_RADIUS_CELLS * (1 - progress));
    graphics.stroke({ width: 3, color: colors.danger, alpha: 0.6 });

    // Столб в эпицентре: сверху вниз он читается быстрее, чем круг
    // на земле, а при взгляде вскользь только он и заметен.
    const centre = worldToScreen(x, y);
    graphics
      .moveTo(centre.x, centre.y)
      .lineTo(centre.x, centre.y - 3 * ELEVATION_PX_PER_CELL)
      .stroke({
        width: 3,
        color: colors.danger,
        alpha: nuke.owner === localPlayer ? 0.9 : 0.7,
      });

    const seconds = Math.ceil(remaining / TICKS_PER_SECOND);
    graphics
      .circle(centre.x, centre.y - 3 * ELEVATION_PX_PER_CELL, 3 + seconds)
      .stroke({ width: 2, color: colors.danger, alpha: 0.9 });
  }
};

/** Клетка под курсором: зелёная, если действие возможно, красная иначе. */
const drawHover = (graphics: Graphics, intent: OverlayIntent, colors: OverlayColors): void => {
  if (intent.hoverCell < 0) return;
  if (intent.buildKind === null && !intent.aimingNuke) return;

  const x = cellX(intent.hoverCell);
  const y = cellY(intent.hoverCell);
  const colour = intent.hoverAllowed ? colors.valid : colors.invalid;

  traceCell(graphics, x, y);
  graphics.fill({ color: colour, alpha: 0.18 });
  traceCell(graphics, x, y);
  graphics.stroke({ width: 1.5, color: colour, alpha: 0.9 });

  if (intent.aimingNuke) {
    traceWorldCircle(graphics, x + 0.5, y + 0.5, NUKE_RADIUS_CELLS);
    graphics.stroke({ width: 2, color: colour, alpha: 0.7 });
  }
};

/**
 * Подсветка выделенной постройки.
 *
 * Рисуется под подсказкой курсора, а не поверх: подсказка отвечает
 * на «что будет, если нажать», и перекрывать её не должно ничто.
 *
 * Своей рамкой, а не заливкой: заливка спорила бы с подсветкой клетки
 * под курсором, а игрок вполне может навести курсор на выделенное.
 */
const drawSelection = (
  graphics: Graphics,
  intent: OverlayIntent,
  colors: OverlayColors,
): void => {
  if (intent.selectedCell < 0) return;

  const x = cellX(intent.selectedCell);
  const y = cellY(intent.selectedCell);

  traceCell(graphics, x, y);
  graphics.stroke({ width: 2.5, color: colors.self, alpha: 0.95 });
};