import type { Graphics } from 'pixi.js';
import {
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  STRUCTURE_STATS,
  StructureKind,
  UNIT_TYPES,
  UNIT_UPGRADE_TARGET,
  UpgradeStat,
  unitsToCells,
  upgradeBranchIndex,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import type { PlayerState, StructureState, WorldState } from '@td/sim';
import { cellX, cellY, playerStats, structureMaxHealth } from '@td/sim';
import { ELEVATION_PX_PER_CELL, worldToScreen } from './iso.js';
import type { Point } from './iso.js';
import { blend, drawPrism, tracePolygon, tracePolygonAt } from './prism.js';
import type { Prism } from './prism.js';
import { baseCrestPoint } from './base-structure.js';
import {
  SIDE_ENEMY,
  SIDE_SELF,
  generalShadow,
  generalSilhouette,
  unitSilhouette,
  weaponTier,
} from './models.js';
import type { Silhouette } from './models.js';

/**
 * Отрисовка живого содержимого поля: построек, юнитов, генералов,
 * следов выстрелов.
 *
 * От отрисовки территории здесь два отличия.
 *
 * Первое: геометрия перестраивается каждый кадр. Территория статична
 * и строится один раз, а юниты движутся. Чтобы это не съедало кадр,
 * всё, что вне экрана, отбрасывается ДО построения геометрии — при видимой
 * доле карты около трети это отсекает большинство объектов.
 *
 * Второе: порядок отрисовки считается каждый кадр. Объёмные тела
 * перекрывают друг друга, и рисовать их надо от дальнего к ближнему.
 * Для статичных скал хватало обхода по диагоналям, но юниты стоят
 * не в клетках, а между ними, поэтому здесь честная сортировка
 * по глубине.
 *
 * Глубина — сумма координат ЦЕНТРА объекта в клетках, и центра, а не угла,
 * не случайно. Юнит стоит в произвольной точке, и его глубина дробная;
 * постройка занимает клетку, и её центр приходится на `x + ½, y + ½`.
 * Считай мы постройку по углу клетки, юнит на клетку севернее оказывался бы
 * с ней вровень и рисовался поверх, хотя стоит за ней.
 *
 * Готовые тела уходят не в один общий слой, а в слой своей полосы глубины.
 * Между полосами сцена вставляет неподвижную территорию, и только благодаря
 * этому юнит прячется за скалой, а не висит поверх неё.
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
  draw(graphics: Graphics): void;
}

/** Слои, в которые сцена принимает нарисованное. */
export interface EntityLayers {
  /** Слой полосы глубины: полоса `k` собирает объекты с глубиной [k, k+1). */
  band(index: number): Graphics;
  /** Слой трассеров. Лежит поверх всего: выстрел — событие, и прятать его незачем. */
  readonly shots: Graphics;
  /**
   * Слой поверх тел — для того, что не имеет права прятаться за ними.
   *
   * Пока здесь живут только полосы прочности баз. Полоса глубины им
   * не годится: нужнее всего они при осаде, когда база обложена толпой,
   * и ровно тогда толпа их и закрыла бы.
   */
  readonly overhead: Graphics;
}

/** Номер последней полосы глубины: дальше юнит уйти не может. */
const LAST_BAND = MAP_WIDTH_CELLS + MAP_HEIGHT_CELLS - 1;

const cellsOf = (units: number): number => unitsToCells(units);

export const drawEntities = (
  layers: EntityLayers,
  world: WorldState,
  view: ViewBounds,
  colors: EntityColors,
  localPlayer: PlayerId,
): void => {
  const stats = world.players.map(playerStats);
  const accentOf = (owner: PlayerId): number =>
    owner === localPlayer ? colors.self : colors.enemy;

  const onScreen = (point: Point): boolean =>
    point.x >= view.minX - CULL_MARGIN_PX &&
    point.x <= view.maxX + CULL_MARGIN_PX &&
    point.y >= view.minY - CULL_MARGIN_PX &&
    point.y <= view.maxY + CULL_MARGIN_PX;

  const visible = (x: number, y: number): boolean => onScreen(worldToScreen(x, y));

  const maxHealthOf = (structure: StructureState): number => {
    const baseline = stats[structure.owner]?.structures[structure.kind];
    return baseline === undefined
      ? structure.health
      : structureMaxHealth(baseline, structure.growthPpm);
  };

  const queue: Drawable[] = [];

  for (const structure of world.structures) {
    const x = cellX(structure.cell);
    const y = cellY(structure.cell);

    // Тело базы рисуется вместе с территорией: она неподвижна, и
    // перестраивать её сложную геометрию каждый кадр незачем. А вот полоса
    // прочности так не умеет — она меняется каждый тик, поэтому живёт
    // здесь, в отрыве от своего тела.
    if (structure.kind === StructureKind.Base) {
      const crest = baseCrestPoint(x, y);

      // Отсекаем по самой полосе, а не по основанию базы: полоса висит
      // намного выше запаса CULL_MARGIN_PX, и по основанию она пропадала бы
      // у нижней кромки экрана задолго до того, как уйдёт из виду.
      if (onScreen(crest)) {
        drawBaseHealthBar(
          layers.overhead,
          crest,
          structure.health,
          maxHealthOf(structure),
          accentOf(structure.owner),
          colors,
        );
      }

      continue;
    }

    if (!visible(x, y)) continue;

    const maxHealth = maxHealthOf(structure);

    // Глубина постройки — по центру её клетки, как и у юнита. Иначе юнит
    // на клетку севернее оказывался бы с ней вровень и рисовался поверх.
    queue.push({
      depth: x + y + 1,
      draw: (graphics) =>
        drawStructure(graphics, structure, world.tick, x, y, accentOf(structure.owner), colors),
    });
    queue.push({
      depth: x + y + 1.001,
      draw: (graphics) =>
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

  // Ступени оружия зависят от прокачки владельца, а не от юнита, поэтому
  // считаются раз на кадр: игроков двое, а юнитов до четырёхсот.
  const tiers = world.players.map(weaponTiersOf);

  for (const unit of world.units) {
    const x = cellsOf(unit.position.x);
    const y = cellsOf(unit.position.y);
    if (!visible(x, y)) continue;

    const maxHealth = stats[unit.owner]?.units[unit.unitType].health ?? unit.health;
    const accent = accentOf(unit.owner);
    const side = unit.owner === localPlayer ? SIDE_SELF : SIDE_ENEMY;
    const tier = tiers[unit.owner]?.[unit.unitType];

    const silhouette = unitSilhouette(
      colors,
      side,
      unit.unitType,
      unit.facing,
      tier?.attack ?? 0,
      tier?.fire ?? 0,
    );
    const anchor = worldToScreen(x, y);

    queue.push({
      depth: x + y,
      draw: (graphics) => {
        paintSilhouette(graphics, silhouette, anchor.x, anchor.y, accent);
        drawHealthBar(graphics, x, y, silhouette.height, unit.health, maxHealth, colors);
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
    const side = general.owner === localPlayer ? SIDE_SELF : SIDE_ENEMY;

    const jet = generalSilhouette(colors, side, general.facing);
    const shadow = generalShadow(colors, general.facing);
    const anchor = worldToScreen(x, y);

    queue.push({
      depth: x + y,
      draw: (graphics) => {
        // Тень сначала: она лежит на земле, а машина идёт над ней.
        paintSilhouette(graphics, shadow, anchor.x, anchor.y, accent, SHADOW_ALPHA);
        paintSilhouette(graphics, jet, anchor.x, anchor.y, accent);
        drawHealthBar(graphics, x, y, jet.height, general.health, maxHealth, colors);
      },
    });
  }

  // Сортировка устойчивая (так требует стандарт), поэтому объекты
  // с одинаковой глубиной сохраняют порядок добавления — тело перед
  // своей полосой здоровья.
  queue.sort((a, b) => a.depth - b.depth);

  for (const item of queue) {
    const band = Math.max(0, Math.min(LAST_BAND, Math.floor(item.depth)));
    item.draw(layers.band(band));
  }

  // Трассеры рисуются поверх всего: выстрел — это событие, и прятать его
  // за телами не нужно, иначе бой в толпе перестаёт читаться.
  drawShots(layers.shots, world, colors, localPlayer);
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

  // Ход возведения показывается растущей высотой тела.
  //
  // Раньше недострой рисовался одним контуром, и полсекунды контура игрок
  // не замечал. Шесть секунд пустого контура — это уже сообщение, и оно
  // неверное: пустой контур читается как «сломано», а не как «строится».
  // Высота — уже работающий язык поля (объект, торчащий вверх, отличается
  // от разметки на земле даже боковым зрением), и растущее тело
  // не добавляет на экран ни одного нового элемента.
  //
  // Доля готовности выводится из `builtAtTick` и тика — обе величины уже
  // есть в снимке мира. Срок берётся из таблицы баланса, а не переписан
  // здесь числом: иначе правка времени возведения молча разошлась бы
  // с ядром.
  const buildTicks = STRUCTURE_STATS[structure.kind].buildTicks;
  const readiness =
    buildTicks <= 0 || tick >= structure.builtAtTick
      ? 1
      : Math.min(1, Math.max(0, (buildTicks - (structure.builtAtTick - tick)) / buildTicks));

  const body: Prism = {
    x: x + inset,
    y: y + inset,
    width: shape.size,
    depth: shape.size,
    // Нижний порог не косметика: совсем плоское тело сливается с землёй,
    // а начатая стройка обязана быть видна с первого тика.
    height: shape.height * Math.max(0.12, readiness),
  };

  drawPrism(graphics, body, { hull, accent });

  // Ствол появляется только у готовой башни. Это второй признак
  // готовности рядом с высотой: почти достроенная башня по высоте
  // от готовой уже почти не отличается, а по стволу — отличается сразу.
  if (structure.kind === StructureKind.Wall || readiness < 1) return;

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
 * Отрисовка готового силуэта из кеша.
 *
 * Вся геометрия построена заранее относительно основания модели, поэтому
 * здесь остаётся сложение двух чисел на точку. Заливки уже склеены
 * по цвету и упорядочены от дальних граней к ближним — порядок вызовов
 * менять нельзя.
 */
const paintSilhouette = (
  graphics: Graphics,
  silhouette: Silhouette,
  anchorX: number,
  anchorY: number,
  accent: number,
  alpha?: number,
): void => {
  for (const run of silhouette.fills) {
    for (const polygon of run.polygons) {
      tracePolygonAt(graphics, polygon, anchorX, anchorY);
    }
    graphics.fill(alpha === undefined ? { color: run.color } : { color: run.color, alpha });
  }

  if (silhouette.outline.length === 0) return;

  // Неоновая окантовка несёт основную нагрузку узнавания: тёмный корпус
  // на тёмной земле сам по себе виден плохо. Обводятся не все детали,
  // а только те, что задают силуэт, — иначе машина в сорок пикселей
  // превращается в клубок светящихся линий.
  for (const polygon of silhouette.outline) {
    tracePolygonAt(graphics, polygon, anchorX, anchorY);
  }
  graphics.stroke({ width: 1, color: accent, alpha: 0.9 });
};

/** Ступени оружия одного игрока по типам юнитов. */
interface WeaponTiers {
  readonly attack: number;
  readonly fire: number;
}

/**
 * Ступени оружия по уровням прокачки владельца.
 *
 * Считаются раз на кадр на игрока, а не на юнита: игроков двое, типов три,
 * а юнитов сотни.
 */
const weaponTiersOf = (player: PlayerState): readonly WeaponTiers[] =>
  UNIT_TYPES.map((unitType) => {
    const target = UNIT_UPGRADE_TARGET[unitType];
    const attack = player.upgrades[upgradeBranchIndex(target, UpgradeStat.Attack)]?.level ?? 0;
    const fire = player.upgrades[upgradeBranchIndex(target, UpgradeStat.FireRate)]?.level ?? 0;

    return { attack: weaponTier(attack), fire: weaponTier(fire) };
  });

/** Тень истребителя. Полупрозрачная: сплошное пятно читалось бы дырой в земле. */
const SHADOW_ALPHA = 0.45;

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

const BASE_BAR_WIDTH_PX = 76;
const BASE_BAR_HEIGHT_PX = 8;

/** Отметки по четвертям. Половина и четверть — рубежи, а не оттенки. */
const BASE_BAR_QUARTERS = [0.25, 0.5, 0.75];

/**
 * Полоса прочности базы.
 *
 * От полос юнитов и башен она отличается тремя вещами, и все три —
 * следствие одного: база это цель матча, а не одна из сотен фигур на поле.
 *
 * Она видна всегда, даже у нетронутой базы. Правило «показывать только
 * повреждённых» бережёт экран там, где полос полсотни, но здесь работает
 * против игрока: «полосы нет» и «база цела» — разные сообщения, а по
 * пустому месту их не различить. Заодно полная длина служит эталоном,
 * без которого доля не читается: заливка в сорок пикселей означает
 * «половина» только рядом с рамкой в восемьдесят.
 *
 * Она крупнее: её читают издали и мельком.
 *
 * И у неё есть отметки по четвертям — рубежи, на которых игрок меняет
 * решение, и различать их на глаз по длине заливки он не обязан.
 */
const drawBaseHealthBar = (
  graphics: Graphics,
  crest: Point,
  health: number,
  maxHealth: number,
  accent: number,
  colors: EntityColors,
): void => {
  if (maxHealth <= 0) return;

  const fraction = Math.max(0, Math.min(1, health / maxHealth));
  const left = crest.x - BASE_BAR_WIDTH_PX / 2;
  const top = crest.y - BASE_BAR_HEIGHT_PX;

  graphics
    .rect(left, top, BASE_BAR_WIDTH_PX, BASE_BAR_HEIGHT_PX)
    .fill({ color: 0x000000, alpha: 0.7 });

  graphics
    .rect(left, top, BASE_BAR_WIDTH_PX * fraction, BASE_BAR_HEIGHT_PX)
    .fill({ color: fraction <= HEALTH_LOW_FRACTION ? colors.healthLow : colors.health });

  for (const quarter of BASE_BAR_QUARTERS) {
    const markX = left + BASE_BAR_WIDTH_PX * quarter;
    graphics
      .moveTo(markX, top)
      .lineTo(markX, top + BASE_BAR_HEIGHT_PX)
      .stroke({ width: 1, color: 0x000000, alpha: 0.5 });
  }

  // Окантовка цветом стороны. Полоса висит высоко и от тела оторвана,
  // поэтому чья она — должно быть видно по ней самой, а не по тому,
  // над чем она оказалась.
  graphics
    .rect(left, top, BASE_BAR_WIDTH_PX, BASE_BAR_HEIGHT_PX)
    .stroke({ width: 1.5, color: accent, alpha: 0.95 });
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
