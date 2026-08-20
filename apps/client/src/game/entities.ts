import type { Graphics } from 'pixi.js';
import { StructureKind, UnitType, unitsToCells } from '@td/shared';
import type { PlayerId } from '@td/shared';
import type { StructureState, UnitState, WorldState } from '@td/sim';
import { cellX, cellY, playerStats, structureMaxHealth } from '@td/sim';
import { ELEVATION_PX_PER_CELL, worldToScreen } from './iso.js';
import { blend, drawPrism, tracePolygon } from './prism.js';
import type { Prism } from './prism.js';

/**
 * Отрисовка живого содержимого поля: построек, юнитов, генералов,
 * следов выстрелов.
 *
 * От отрисовки территории здесь два отличия.
 *
 * Первое: геометрия перестраивается каждый кадр. Территория статична
 * и строится один раз, а юниты движутся. Чтобы это не съедало кадр,
 * всё, что вне экрана, отбрасывается ДО построения геометрии — при видимой
 * десятой части карты это отсекает примерно девять объектов из десяти.
 *
 * Второе: порядок отрисовки считается каждый кадр. Объёмные тела
 * перекрывают друг друга, и рисовать их надо от дальнего к ближнему.
 * Для статичных скал хватало обхода по диагоналям, но юниты стоят
 * не в клетках, а между ними, поэтому здесь честная сортировка
 * по сумме координат.
 */

export interface EntityColors {
  readonly self: number;
  readonly enemy: number;
  readonly hullDark: number;
  readonly health: number;
  readonly healthLow: number;
  readonly shot: number;
  readonly shotLethal: number;
}

export interface ViewBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/**
 * Запас на отсечение, в экранных пикселях.
 *
 * Точка объекта — это его основание, а тело поднимается вверх на несколько
 * десятков пикселей. Без запаса высокая башня у верхней кромки экрана
 * исчезала бы целиком, хотя её верхушку ещё видно.
 */
const CULL_MARGIN_PX = 160;

/** Доля цвета стороны в тёмном корпусе. Подробности в base-structure.ts. */
const HULL_TINT = 0.32;

interface Drawable {
  /** Глубина: чем больше, тем ближе к зрителю и тем позже рисуется. */
  readonly depth: number;
  draw(): void;
}

const cellsOf = (units: number): number => unitsToCells(units);

export const drawEntities = (
  graphics: Graphics,
  world: WorldState,
  view: ViewBounds,
  colors: EntityColors,
  localPlayer: PlayerId,
): void => {
  graphics.clear();

  const stats = world.players.map(playerStats);
  const accentOf = (owner: PlayerId): number =>
    owner === localPlayer ? colors.self : colors.enemy;

  const visible = (x: number, y: number): boolean => {
    const point = worldToScreen(x, y);
    return (
      point.x >= view.minX - CULL_MARGIN_PX &&
      point.x <= view.maxX + CULL_MARGIN_PX &&
      point.y >= view.minY - CULL_MARGIN_PX &&
      point.y <= view.maxY + CULL_MARGIN_PX
    );
  };

  const queue: Drawable[] = [];

  for (const structure of world.structures) {
    // База рисуется вместе с территорией: она неподвижна, и перестраивать
    // её сложную геометрию каждый кадр незачем.
    if (structure.kind === StructureKind.Base) continue;

    const x = cellX(structure.cell);
    const y = cellY(structure.cell);
    if (!visible(x, y)) continue;

    const baseline = stats[structure.owner]?.structures[structure.kind];
    const maxHealth =
      baseline === undefined ? structure.health : structureMaxHealth(baseline, structure.growthPpm);

    queue.push({
      depth: x + y,
      draw: () =>
        drawStructure(graphics, structure, world.tick, x, y, accentOf(structure.owner), colors),
    });
    queue.push({
      depth: x + y + 0.001,
      draw: () =>
        drawHealthBar(
          graphics,
          x + 0.5,
          y + 0.5,
          structureHeight(structure.kind),
          structure.health,
          maxHealth,
          colors,
        ),
    });
  }

  for (const unit of world.units) {
    const x = cellsOf(unit.position.x);
    const y = cellsOf(unit.position.y);
    if (!visible(x, y)) continue;

    const maxHealth = stats[unit.owner]?.units[unit.unitType].health ?? unit.health;
    const accent = accentOf(unit.owner);

    queue.push({
      depth: x + y,
      draw: () => {
        drawUnit(graphics, unit, x, y, accent, colors);
        drawHealthBar(
          graphics,
          x,
          y,
          UNIT_SHAPE[unit.unitType].height,
          unit.health,
          maxHealth,
          colors,
        );
      },
    });
  }

  for (const general of world.generals) {
    if (!general.alive) continue;

    const x = cellsOf(general.position.x);
    const y = cellsOf(general.position.y);
    if (!visible(x, y)) continue;

    const maxHealth = stats[general.owner]?.general.health ?? general.health;
    const accent = accentOf(general.owner);

    queue.push({
      depth: x + y,
      draw: () => {
        drawGeneral(graphics, x, y, accent, colors);
        drawHealthBar(
          graphics,
          x,
          y,
          GENERAL_HEIGHT + GENERAL_SPIRE,
          general.health,
          maxHealth,
          colors,
        );
      },
    });
  }

  // Сортировка устойчивая (так требует стандарт), поэтому объекты
  // с одинаковой глубиной сохраняют порядок добавления — тело перед
  // своей полосой здоровья.
  queue.sort((a, b) => a.depth - b.depth);
  for (const item of queue) item.draw();

  // Трассеры рисуются поверх всего: выстрел — это событие, и прятать его
  // за телами не нужно, иначе бой в толпе перестаёт читаться.
  drawShots(graphics, world, colors, localPlayer);
};

// ─────────────────────────────────────────────────────────────────────────
// Постройки
// ─────────────────────────────────────────────────────────────────────────

interface Shape {
  readonly size: number;
  readonly height: number;
}

const STRUCTURE_SHAPE: Readonly<Record<StructureKind, Shape>> = {
  [StructureKind.Base]: { size: 1, height: 1 },
  // Стена почти во всю клетку и низкая: она перекрывает проход,
  // но не должна загораживать обзор.
  [StructureKind.Wall]: { size: 0.92, height: 0.55 },
  [StructureKind.TowerBasic]: { size: 0.66, height: 0.95 },
  // Снайперская выше и тоньше — силуэт читается издали и говорит
  // о её дальности раньше, чем игрок наведёт на неё курсор.
  [StructureKind.TowerSniper]: { size: 0.5, height: 1.5 },
};

const structureHeight = (kind: StructureKind): number => STRUCTURE_SHAPE[kind].height;

const drawStructure = (
  graphics: Graphics,
  structure: StructureState,
  tick: number,
  x: number,
  y: number,
  accent: number,
  colors: EntityColors,
): void => {
  const shape = STRUCTURE_SHAPE[structure.kind];
  const hull = blend(colors.hullDark, accent, HULL_TINT);
  const inset = (1 - shape.size) / 2;

  // Недостроенное показывается одним контуром: сразу видно, что объект
  // уже мешает пройти, но ещё не в строю.
  const outlineOnly = tick < structure.builtAtTick;

  const body: Prism = {
    x: x + inset,
    y: y + inset,
    width: shape.size,
    depth: shape.size,
    height: shape.height,
  };

  drawPrism(graphics, body, { hull, accent, outlineOnly });

  if (structure.kind === StructureKind.Wall) return;

  // Ствол: узкая насадка сверху. Именно она отличает башню от коробки.
  drawPrism(
    graphics,
    {
      x: x + 0.5 - 0.12,
      y: y + 0.5 - 0.12,
      width: 0.24,
      depth: 0.24,
      height: 0.3,
      base: shape.height,
    },
    { hull, accent, lineWidth: 1, lineAlpha: 0.95 },
  );
};

// ─────────────────────────────────────────────────────────────────────────
// Юниты и генералы
// ─────────────────────────────────────────────────────────────────────────

/**
 * Силуэты юнитов различаются пропорциями, а не цветом: цвет уже занят
 * принадлежностью стороне, и нагружать его ещё и типом нельзя.
 */
const UNIT_SHAPE: Readonly<Record<UnitType, Shape>> = {
  [UnitType.Assault]: { size: 0.34, height: 0.44 },
  // Снайпер тонкий и высокий.
  [UnitType.Sniper]: { size: 0.26, height: 0.56 },
  // Гранатомётчик приземистый и широкий.
  [UnitType.Grenadier]: { size: 0.46, height: 0.36 },
};

const GENERAL_HEIGHT = 0.6;
const GENERAL_SPIRE = 0.55;

const drawUnit = (
  graphics: Graphics,
  unit: UnitState,
  x: number,
  y: number,
  accent: number,
  colors: EntityColors,
): void => {
  const shape = UNIT_SHAPE[unit.unitType];
  const half = shape.size / 2;

  drawPrism(
    graphics,
    { x: x - half, y: y - half, width: shape.size, depth: shape.size, height: shape.height },
    { hull: blend(colors.hullDark, accent, 0.45), accent, lineWidth: 1, lineAlpha: 0.9 },
  );
};

/**
 * Генерал.
 *
 * Он должен опознаваться среди сотни юнитов мгновенно, поэтому у него
 * не просто больший размер, а другой силуэт: корпус со шпилем. Размером
 * от толпы не отличишься — на расстоянии разница в полтора раза
 * не читается, а вертикальная антенна читается сразу.
 */
const drawGeneral = (
  graphics: Graphics,
  x: number,
  y: number,
  accent: number,
  colors: EntityColors,
): void => {
  const hull = blend(colors.hullDark, accent, 0.5);
  const half = 0.26;

  drawPrism(
    graphics,
    { x: x - half, y: y - half, width: half * 2, depth: half * 2, height: GENERAL_HEIGHT },
    { hull, accent, lineWidth: 1.5, lineAlpha: 1 },
  );

  drawPrism(
    graphics,
    {
      x: x - 0.05,
      y: y - 0.05,
      width: 0.1,
      depth: 0.1,
      height: GENERAL_SPIRE,
      base: GENERAL_HEIGHT,
    },
    { hull: accent, accent, lineWidth: 1, lineAlpha: 1 },
  );

  // Точка на вершине шпиля: маленькая, но именно она ловит взгляд
  // при беглом осмотре карты.
  const tip = worldToScreen(x, y);
  graphics
    .circle(tip.x, tip.y - (GENERAL_HEIGHT + GENERAL_SPIRE) * ELEVATION_PX_PER_CELL, 3.5)
    .fill({ color: accent });
};

// ─────────────────────────────────────────────────────────────────────────
// Полосы здоровья и выстрелы
// ─────────────────────────────────────────────────────────────────────────

const HEALTH_BAR_WIDTH_PX = 26;
const HEALTH_BAR_HEIGHT_PX = 3;
const HEALTH_LOW_FRACTION = 0.35;

/**
 * Полоса здоровья рисуется только у повреждённых.
 *
 * У целых она была бы чистым шумом: полсотни одинаковых зелёных чёрточек
 * над строем не несут ни одного бита информации, зато перегружают экран.
 */
const drawHealthBar = (
  graphics: Graphics,
  x: number,
  y: number,
  height: number,
  health: number,
  maxHealth: number,
  colors: EntityColors,
): void => {
  if (maxHealth <= 0 || health >= maxHealth) return;

  const fraction = Math.max(0, Math.min(1, health / maxHealth));
  const anchor = worldToScreen(x, y);
  const top = anchor.y - height * ELEVATION_PX_PER_CELL - 10;
  const left = anchor.x - HEALTH_BAR_WIDTH_PX / 2;

  graphics
    .rect(left, top, HEALTH_BAR_WIDTH_PX, HEALTH_BAR_HEIGHT_PX)
    .fill({ color: 0x000000, alpha: 0.55 });

  graphics
    .rect(left, top, HEALTH_BAR_WIDTH_PX * fraction, HEALTH_BAR_HEIGHT_PX)
    .fill({ color: fraction <= HEALTH_LOW_FRACTION ? colors.healthLow : colors.health });
};

const drawShots = (
  graphics: Graphics,
  world: WorldState,
  colors: EntityColors,
  localPlayer: PlayerId,
): void => {
  for (const shot of world.shots) {
    const from = worldToScreen(cellsOf(shot.from.x), cellsOf(shot.from.y));
    const to = worldToScreen(cellsOf(shot.to.x), cellsOf(shot.to.y));

    // Трассер идёт не от земли, а от «плеча» стрелка: выстрел из-под ног
    // выглядит как подкат, а не как стрельба.
    const lift = 0.35 * ELEVATION_PX_PER_CELL;

    graphics
      .moveTo(from.x, from.y - lift)
      .lineTo(to.x, to.y - lift)
      .stroke({
        width: shot.lethal ? 2 : 1,
        color: shot.lethal ? colors.shotLethal : colors.shot,
        alpha: shot.owner === localPlayer ? 0.75 : 0.5,
      });
  }
};

/** Тонкий контур клетки. Нужен подсказкам поверх поля. */
export const traceCell = (graphics: Graphics, x: number, y: number, inset = 0.08): void => {
  tracePolygon(graphics, [
    worldToScreen(x + inset, y + inset),
    worldToScreen(x + 1 - inset, y + inset),
    worldToScreen(x + 1 - inset, y + 1 - inset),
    worldToScreen(x + inset, y + 1 - inset),
  ]);
};
