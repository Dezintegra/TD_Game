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
import { tracePolygon, tracePolygonAt } from './prism.js';
import { baseBeaconPoint, baseCrestPoint, beaconGlow } from './base-structure.js';
import {
  MIRROR_SQUASH,
  SIDE_ENEMY,
  SIDE_SELF,
  UNIT_ALTITUDE,
  generalReflection,
  generalSilhouette,
  hoverBob,
  unitReflection,
  unitSilhouette,
  weaponTier,
} from './models.js';
import type { Silhouette } from './models.js';
import { paintStructure, readinessStep, structureSilhouette } from './towers.js';

/**
 * Отрисовка живого содержимого поля: построек, юнитов и генералов.
 *
 * Выстрелы живут отдельно, в `shots.ts`, и это не деление по объёму
 * файла. Тело на поле — это геометрия в порядке удалённости; выстрел —
 * событие со своим возрастом, светом и дымом, и рисуется он поверх всех
 * тел, а не среди них. Правила у них разные настолько, что общего кода
 * между ними не осталось бы ни строчки.
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
  /** Цвет поверхности поля. К нему подмешиваются отражения. */
  readonly ground: number;
  readonly health: number;
  readonly healthLow: number;
  /** Проблесковый огонь на мачте базы. */
  readonly beacon: number;
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

interface Drawable {
  /** Глубина: чем больше, тем ближе к зрителю и тем позже рисуется. */
  readonly depth: number;
  draw(graphics: Graphics): void;
}

/** Слои, в которые сцена принимает нарисованное. */
export interface EntityLayers {
  /** Слой полосы глубины: полоса `k` собирает объекты с глубиной [k, k+1). */
  band(index: number): Graphics;
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

        // Проблесковый огонь на вершине мачты. Единственная часть базы,
        // которая рисуется в кадре: тело её запечено в текстуру, а огонь
        // мигает. Фаза берётся от номера тика — у игроков разная частота
        // кадров, а тик общий.
        drawBeacon(layers.overhead, baseBeaconPoint(x, y), beaconGlow(world.tick), colors.beacon);
      }

      continue;
    }

    if (!visible(x, y)) continue;

    const maxHealth = maxHealthOf(structure);
    const side = structure.owner === localPlayer ? SIDE_SELF : SIDE_ENEMY;
    const accent = accentOf(structure.owner);

    const silhouette = structureSilhouette(
      colors,
      side,
      structure.kind,
      structure.facing,
      readinessStep(readinessOf(structure, world.tick)),
    );

    // Модель построена относительно ЦЕНТРА клетки: постройка занимает
    // клетку целиком, и её турель вращается вокруг центра, а не вокруг
    // угла.
    const anchor = worldToScreen(x + 0.5, y + 0.5);

    // Глубина постройки — по центру её клетки, как и у юнита. Иначе юнит
    // на клетку севернее оказывался бы с ней вровень и рисовался поверх.
    queue.push({
      depth: x + y + 1,
      draw: (graphics) => paintStructure(graphics, silhouette, anchor.x, anchor.y, accent),
    });
    queue.push({
      depth: x + y + 1.001,
      draw: (graphics) =>
        drawHealthBar(
          graphics,
          x + 0.5,
          y + 0.5,
          silhouette.height,
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

    const attackTier = tier?.attack ?? 0;
    const fireTier = tier?.fire ?? 0;
    const silhouette = unitSilhouette(
      colors,
      side,
      unit.unitType,
      unit.facing,
      attackTier,
      fireTier,
    );
    const mirror = unitReflection(colors, side, unit.unitType, unit.facing, attackTier, fireTier);
    const anchor = worldToScreen(x, y);

    // Машина висит над полем и медленно покачивается. Величина считается
    // здесь, а не в кеше силуэтов: кеш общий для всех машин комбинации,
    // а высота своя у каждой.
    const altitude = UNIT_ALTITUDE + hoverBob(unit.id, world.tick);
    const lift = altitude * ELEVATION_PX_PER_CELL;

    queue.push({
      depth: x + y,
      draw: (graphics) => {
        // Отражение первым: оно лежит в поверхности, машина висит над ней.
        paintSilhouette(graphics, mirror, anchor.x, anchor.y + lift * MIRROR_SQUASH, accent);
        paintSilhouette(graphics, silhouette, anchor.x, anchor.y - lift, accent);
        // Полоса здоровья поднимается вместе с машиной, иначе повиснет
        // отдельно от неё.
        drawHealthBar(graphics, x, y, silhouette.height + altitude, unit.health, maxHealth, colors);
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

    const gunship = generalSilhouette(colors, side, general.facing);
    const mirror = generalReflection(colors, side, general.facing);
    const anchor = worldToScreen(x, y);

    // Высота машины генерала зашита в саму модель, поэтому здесь остаётся
    // одно покачивание. Фаза берётся от номера игрока: генералов двое,
    // и качаться в такт им тоже незачем.
    const bob = hoverBob(general.owner, world.tick);
    const lift = bob * ELEVATION_PX_PER_CELL;

    queue.push({
      depth: x + y,
      draw: (graphics) => {
        // Отражение первым: оно лежит в поверхности, машина висит над ней.
        // Тени между ними нет — рядом с отражением она читалась не тенью,
        // а вторым отражением. Клетку показывает радиус строительства.
        paintSilhouette(graphics, mirror, anchor.x, anchor.y + lift * MIRROR_SQUASH, accent);
        paintSilhouette(graphics, gunship, anchor.x, anchor.y - lift, accent);
        drawHealthBar(graphics, x, y, gunship.height + bob, general.health, maxHealth, colors);
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
};

// ─────────────────────────────────────────────────────────────────────────
// Постройки
// ─────────────────────────────────────────────────────────────────────────

/**
 * Доля готовности постройки, от нуля до единицы.
 *
 * Ход возведения показывается растущей высотой тела.
 *
 * Раньше недострой рисовался одним контуром, и полсекунды контура игрок
 * не замечал. Шесть секунд пустого контура — это уже сообщение, и оно
 * неверное: пустой контур читается как «сломано», а не как «строится».
 * Высота — уже работающий язык поля (объект, торчащий вверх, отличается
 * от разметки на земле даже боковым зрением), и растущее тело
 * не добавляет на экран ни одного нового элемента.
 *
 * Доля выводится из `builtAtTick` и тика — обе величины уже есть
 * в снимке мира. Срок берётся из таблицы баланса, а не переписан здесь
 * числом: иначе правка времени возведения молча разошлась бы с ядром.
 */
const readinessOf = (structure: StructureState, tick: number): number => {
  const buildTicks = STRUCTURE_STATS[structure.kind].buildTicks;
  if (buildTicks <= 0 || tick >= structure.builtAtTick) return 1;

  return Math.min(1, Math.max(0, (buildTicks - (structure.builtAtTick - tick)) / buildTicks));
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
): void => {
  for (const run of silhouette.fills) {
    for (const polygon of run.polygons) {
      tracePolygonAt(graphics, polygon, anchorX, anchorY);
    }
    graphics.fill({ color: run.color });
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

/** Радиус огня и его ореола, в экранных пикселях. */
const BEACON_RADIUS_PX = 2.4;
const BEACON_HALO_PX = 7;

/**
 * Проблесковый огонь на вершине мачты.
 *
 * Две окружности: сама лампа и ореол вокруг неё. Ореол — не украшение:
 * лампа в два пикселя на тёмном поле читается как пылинка на экране,
 * а с ореолом — как источник света.
 *
 * Погасший огонь не рисуется вовсе. Тусклая точка на вершине означала бы
 * «горит слабо», а он либо горит, либо нет.
 */
const drawBeacon = (graphics: Graphics, at: Point, glow: number, color: number): void => {
  if (glow <= 0.01) return;

  graphics.circle(at.x, at.y, BEACON_HALO_PX).fill({ color, alpha: 0.22 * glow });
  graphics.circle(at.x, at.y, BEACON_RADIUS_PX).fill({ color, alpha: 0.6 + 0.4 * glow });
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
