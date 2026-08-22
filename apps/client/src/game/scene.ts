import { Application, Container, Graphics } from 'pixi.js';
import { MAP_HEIGHT_CELLS, MAP_WIDTH_CELLS } from '@td/shared';
import type { PlayerId } from '@td/shared';
import { cellIndex } from '@td/sim';
import type { GameMap, WorldState } from '@td/sim';
import { clampCamera, createCamera, moveCamera } from './camera.js';
import type { Camera } from './camera.js';
import { TERRAIN_DIAGONAL_COUNT, drawGround, drawTerrainDiagonal } from './terrain.js';
import type { TerrainColors } from './terrain.js';
import { drawEntities } from './entities.js';
import type { EntityColors, EntityLayers, ViewBounds } from './entities.js';
import { drawShots } from './shots.js';
import type { ShotColors, ShotLayers } from './shots.js';
import { drawBlasts, shakeOffset } from './blasts.js';
import type { BlastColors, BlastLayers } from './blasts.js';
import { createFrameClock } from './clock.js';
import { drawOverlays } from './overlays.js';
import type { OverlayColors, OverlayIntent } from './overlays.js';
import {
  drawMinimapEntities,
  drawMinimapTerrain,
  minimapCellAt,
  minimapLayout,
} from './minimap.js';
import type { MinimapColors, MinimapLayout } from './minimap.js';
import { screenToWorld, worldToScreen } from './iso.js';
import type { CellPoint } from './iso.js';

/**
 * Сцена PixiJS: всё, что рисуется на игровом поле.
 *
 * React сюда не заглядывает. Это принципиально: поле обновляется каждый
 * кадр, и прогон таких обновлений через виртуальный DOM съел бы весь бюджет
 * времени. PixiJS рисует через WebGL и держит тысячи объектов на стабильных
 * 60 кадрах.
 *
 * Слои разделены по частоте изменения:
 *
 *   земля       — перестраивается при смене карты, то есть почти никогда;
 *   территория  — то же самое, но разложена по диагоналям;
 *   сущности    — каждый кадр;
 *   трассеры    — каждый кадр, поверх всех тел;
 *   поверх тел  — каждый кадр: то, чему прятаться за телами нельзя;
 *   подсказки   — каждый кадр, но зависят от намерения игрока, а не мира;
 *   миникарта   — несколько раз в секунду и в экранных координатах.
 *
 * Разделение по частоте важнее разделения по смыслу: слой, который
 * не изменился, не должен платить за соседа, который изменился.
 *
 * Но одного разделения по частоте мало. Первая версия держала всю
 * территорию одним слоем под слоем сущностей, и юнит за скалой рисовался
 * поверх неё: порядок «ближний перекрывает дальнего» действовал внутри
 * каждого слоя и не действовал между ними.
 *
 * Поэтому территория и сущности чередуются по полосам глубины. Слой
 * территории с номером `d` содержит клетки диагонали `x + y = d`, то есть
 * объекты глубины ровно `d + 1`. Слой сущностей с номером `k` собирает
 * объекты глубины из полуинтервала `[k, k + 1)`. Выставленные в порядке
 *
 *   сущности[0], территория[0], сущности[1], территория[1], ...
 *
 * они дают ровно тот порядок, который нужен: сущности слоя `d` дальше
 * скалы диагонали `d` и рисуются раньше неё, сущности слоя `d + 1` ближе
 * и рисуются позже.
 *
 * Совпадение глубины возможно только у объектов одной диагонали, а такие
 * в аксонометрии стоят на экране бок о бок и не перекрываются вовсе —
 * их взаимный порядок безразличен.
 *
 * Геометрия территории при этом по-прежнему строится один раз на карту:
 * разложить её по слоям — не то же самое, что перестраивать её на кадре.
 *
 * Цвета берутся из тех же дизайн-токенов, что и HUD, — читаются из CSS.
 * Так палитра остаётся в одном месте, а не расползается по двум рендерерам.
 */
export interface Scene {
  /** Показывает карту. Геометрия перестраивается только при смене карты. */
  setMap(map: GameMap): void;
  /** Рисует текущее состояние мира и подсказки. */
  render(world: WorldState, localPlayer: PlayerId, intent: OverlayIntent): void;
  /** Сдвигает камеру на заданное число экранных пикселей и снимает слежение. */
  panBy(dx: number, dy: number): void;
  /** Ставит камеру в клетку карты и снимает слежение. */
  centreOnCell(cell: number): void;
  /** Включает слежение камеры за точкой (в клетках). */
  follow(point: CellPoint | undefined): void;
  setFollowing(enabled: boolean): void;
  readonly following: boolean;
  /** Клетка карты под точкой экрана, либо -1. */
  cellAtScreen(screenX: number, screenY: number): number;
  /** Клетка карты под точкой миникарты, либо -1. */
  minimapCellAtScreen(screenX: number, screenY: number): number;
  resize(): void;
  destroy(): void;
  /** Сколько раз перестраивалась геометрия территории. Нужно тестам. */
  readonly terrainRebuildCount: number;
  readonly viewportSize: { readonly width: number; readonly height: number };
}

const readToken = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
};

/** Переводит цвет из CSS в число, понятное PixiJS. */
const toPixiColor = (cssColor: string, fallback: number): number => {
  const match = /^#([0-9a-f]{6})$/i.exec(cssColor);
  return match?.[1] === undefined ? fallback : Number.parseInt(match[1], 16);
};

const token = (name: string, fallback: number): number =>
  toPixiColor(readToken(name, ''), fallback);

const readTerrainColors = (): TerrainColors => ({
  grid: token('--td-border-subtle', 0x3a3a3a),
  gridMajor: token('--td-border-control', 0x4d4d4d),
  rock: token('--td-rock', 0x6e6a63),
  rockFacet: token('--td-rock-facet', 0x817b71),
  rockEdge: token('--td-rock-edge', 0x4a4741),
  rockSnow: token('--td-rock-snow', 0xdfe6ef),
  border: token('--td-text-muted-4', 0x6b6b6b),
  // Читаем --td-accent, а не --td-player-self: последний объявлен через
  // var(), и получить из него готовый цвет средствами getComputedStyle
  // надёжно не выйдет.
  baseSelf: token('--td-accent', 0x00ff29),
  baseEnemy: token('--td-player-enemy', 0xd264ff),
});

const readEntityColors = (): EntityColors => ({
  self: token('--td-accent', 0x00ff29),
  enemy: token('--td-player-enemy', 0xd264ff),
  hullDark: token('--td-hull-dark', 0x23271f),
  // Цвет поверхности — тот же, которым залит фон сцены. Земля рисуется
  // линиями и заливок не имеет, поэтому под отражением всегда именно он.
  ground: token('--td-bg-page', 0x191919),
  health: token('--td-health-full', 0x00ff29),
  healthLow: token('--td-health-low', 0xff5c5c),
});

/**
 * Цвета выстрела.
 *
 * Огонь, дым и белое ядро берутся из тех же токенов, что у взрыва,
 * и это требование, а не экономия: пламя на дульном срезе и пламя
 * горящей машины — один и тот же огонь, и разойдись они хоть на оттенок,
 * поле распалось бы на два разных мира.
 */
const readShotColors = (): ShotColors => ({
  self: token('--td-accent', 0x00ff29),
  enemy: token('--td-player-enemy', 0xd264ff),
  hullDark: token('--td-hull-dark', 0x23271f),
  shot: token('--td-projectile', 0xeaffef),
  shotLethal: token('--td-health-low', 0xff5c5c),
  core: token('--td-blast-core', 0xfff6e0),
  fire: token('--td-blast-fire', 0xff8a2b),
  smoke: token('--td-blast-smoke', 0x2b2622),
});

const readBlastColors = (): BlastColors => ({
  self: token('--td-accent', 0x00ff29),
  enemy: token('--td-player-enemy', 0xd264ff),
  hullDark: token('--td-hull-dark', 0x23271f),
  core: token('--td-blast-core', 0xfff6e0),
  fire: token('--td-blast-fire', 0xff8a2b),
  smoke: token('--td-blast-smoke', 0x2b2622),
});

const readOverlayColors = (): OverlayColors => ({
  self: token('--td-accent', 0x00ff29),
  enemy: token('--td-player-enemy', 0xd264ff),
  valid: token('--td-build-valid', 0x00ff29),
  invalid: token('--td-build-invalid', 0xff5c5c),
  danger: token('--td-strike', 0xff5c5c),
});

const readMinimapColors = (): MinimapColors => ({
  background: token('--td-bg-panel', 0x141414),
  border: token('--td-border-control', 0x4d4d4d),
  rock: token('--td-rock', 0x6e6a63),
  self: token('--td-accent', 0x00ff29),
  enemy: token('--td-player-enemy', 0xd264ff),
  viewport: token('--td-text-secondary', 0xc4c4c4),
});

/**
 * Как часто перерисовывается миникарта, в кадрах.
 *
 * Раз в шесть кадров — это десять обновлений в секунду. От шестидесяти
 * человек их не отличит, а рисовать там приходится сотни точек.
 */
const MINIMAP_EVERY_FRAMES = 6;

export const createScene = async (host: HTMLElement): Promise<Scene> => {
  const app = new Application();

  await app.init({
    background: token('--td-bg-page', 0x191919),
    antialias: true,
    // Учитываем плотность пикселей монитора, иначе на ретине картинка мылит.
    resolution: window.devicePixelRatio,
    autoDensity: true,
    resizeTo: host,
  });

  host.appendChild(app.canvas);

  // Мировой контейнер несёт камеру, внешний — только тряску. Разделение
  // не косметическое: положение мирового контейнера читает наведение,
  // и подмешивать в него дрожание нельзя. Подробности у `applyShake`.
  const shakeContainer = new Container();
  const worldContainer = new Container();
  shakeContainer.addChild(worldContainer);

  const groundGraphics = new Graphics();
  worldContainer.addChild(groundGraphics);

  // Слоёв получается около четырёхсот. Это дёшево: пустой Graphics ничего
  // не рисует, а обход четырёхсот детей на кадр не измеряется. Заливок
  // при этом не прибавляется ни одной — они просто разъехались по разным
  // объектам.
  const terrainBands: Graphics[] = [];
  const entityBands: Graphics[] = [];

  for (let band = 0; band <= TERRAIN_DIAGONAL_COUNT; band += 1) {
    const entities = new Graphics();
    entityBands.push(entities);
    worldContainer.addChild(entities);

    if (band < TERRAIN_DIAGONAL_COUNT) {
      const terrain = new Graphics();
      terrainBands.push(terrain);
      worldContainer.addChild(terrain);
    }
  }

  // Порядок слоёв эффектов снизу вверх:
  //
  //   дым и обломки взрывов
  //   дым выстрелов и корпуса ракет
  //   свет выстрелов          (сложение)
  //   свет взрывов            (сложение)
  //
  // Дым — это тело: его можно заслонить, и вспышка, случившаяся перед
  // ним, должна быть видна. Свет заслонить нельзя ничем, поэтому оба
  // светящихся слоя лежат выше всех дымов сразу, а не каждый над своим.
  //
  // Свет взрыва выше света выстрела намеренно: взрыв — событие более
  // крупное, и перекрывать его вспышками очередей незачем.
  const blastDebrisGraphics = new Graphics();
  const shotTrailGraphics = new Graphics();
  const shotGlowGraphics = new Graphics();
  const blastGlowGraphics = new Graphics();

  // Сложение цвета вместо закрашивания: две пересёкшиеся искры ярче одной,
  // а вспышка высветляет то, что под ней. Задаётся слою целиком — ровно
  // поэтому светящееся и несветящееся здесь разложены по разным слоям.
  shotGlowGraphics.blendMode = 'add';
  blastGlowGraphics.blendMode = 'add';

  const flashGraphics = new Graphics();
  flashGraphics.blendMode = 'add';

  // Слой поверх тел лежит выше выстрелов: полосы прочности баз показывают
  // положение дел в матче, и перечёркивать их линиями выстрелов незачем.
  const overheadGraphics = new Graphics();
  const overlayGraphics = new Graphics();
  worldContainer.addChild(
    blastDebrisGraphics,
    shotTrailGraphics,
    shotGlowGraphics,
    blastGlowGraphics,
    overheadGraphics,
    overlayGraphics,
  );

  /**
   * Слои сущностей, в которые что-то попало на прошлом кадре.
   *
   * Очищаются только они. Обходить все четыреста ради полудюжины занятых
   * значило бы платить за пустоту каждый кадр.
   */
  const usedBands: number[] = [];
  const bandUsed = new Uint8Array(entityBands.length);

  const layers: EntityLayers = {
    band(index) {
      if (bandUsed[index] === 0) {
        bandUsed[index] = 1;
        usedBands.push(index);
      }
      // Полоса гарантированно существует: её номер уже прижат к диапазону
      // на стороне отрисовки сущностей.
      return entityBands[index] as Graphics;
    },
    overhead: overheadGraphics,
  };

  const shotLayers: ShotLayers = {
    trails: shotTrailGraphics,
    glow: shotGlowGraphics,
  };

  const blastLayers: BlastLayers = {
    debris: blastDebrisGraphics,
    glow: blastGlowGraphics,
    flash: flashGraphics,
  };

  const clearEntityLayers = (): void => {
    for (const band of usedBands) {
      entityBands[band]?.clear();
      bandUsed[band] = 0;
    }
    usedBands.length = 0;
    shotTrailGraphics.clear();
    shotGlowGraphics.clear();
    overheadGraphics.clear();
    blastDebrisGraphics.clear();
    blastGlowGraphics.clear();
    flashGraphics.clear();
  };

  // Миникарта живёт в экранных координатах, поэтому лежит не в мировом
  // контейнере, а прямо на сцене: сдвиг камеры её двигать не должен.
  const minimapContainer = new Container();
  const minimapTerrain = new Graphics();
  const minimapEntities = new Graphics();
  minimapContainer.addChild(minimapTerrain, minimapEntities);

  // Засветка экрана лежит вне мирового контейнера: она не привязана
  // к точке карты и ездить с камерой не должна. Миникарта — выше неё:
  // засветить единственный прибор ориентирования значило бы отнять
  // ориентирование ровно тогда, когда оно нужнее всего.
  app.stage.addChild(shakeContainer, flashGraphics, minimapContainer);

  const terrainColors = readTerrainColors();
  const entityColors = readEntityColors();
  const shotColors = readShotColors();
  const blastColors = readBlastColors();
  const overlayColors = readOverlayColors();
  const minimapColors = readMinimapColors();

  let camera: Camera = createCamera();
  let currentMap: GameMap | undefined;
  let terrainRebuildCount = 0;
  let following = true;
  let layout: MinimapLayout = minimapLayout(app.screen.width, app.screen.height);
  let frame = 0;

  const clock = createFrameClock();

  /**
   * Сдвиг контейнера так, чтобы точка camera оказалась в центре экрана.
   * Это единственное, что происходит при движении камеры: два числа,
   * никакого перестроения геометрии.
   */
  const applyCamera = (): void => {
    camera = clampCamera(camera, app.screen.width, app.screen.height);
    worldContainer.x = Math.round(app.screen.width / 2 - camera.x);
    worldContainer.y = Math.round(app.screen.height / 2 - camera.y);
  };

  /**
   * Тряска от взрыва.
   *
   * Смещается ВНЕШНИЙ контейнер, а не мировой, и это не мелочь. Клетка
   * под курсором считается из положения мирового контейнера (см.
   * `cellAtScreen`); подмешай мы тряску туда, во время взрыва прицел
   * уезжал бы на полклетки — а целится игрок как раз тогда, когда что-то
   * взрывается.
   *
   * Отдельный контейнер, а не запоминание «положения без тряски», выбран
   * намеренно: при запоминании правило держится на том, что каждый будущий
   * читатель положения не забудет взять запомненное. Здесь оно держится
   * на устройстве сцены и забыть о нём нельзя.
   */
  const applyShake = (amplitude: number, time: number): void => {
    const offset = shakeOffset(amplitude, time);
    shakeContainer.x = offset.x;
    shakeContainer.y = offset.y;
  };

  const relayoutMinimap = (): void => {
    layout = minimapLayout(app.screen.width, app.screen.height);
    if (currentMap !== undefined) {
      drawMinimapTerrain(minimapTerrain, currentMap, layout, minimapColors);
    }
  };

  const viewBounds = (): ViewBounds => ({
    minX: camera.x - app.screen.width / 2,
    maxX: camera.x + app.screen.width / 2,
    minY: camera.y - app.screen.height / 2,
    maxY: camera.y + app.screen.height / 2,
  });

  /** Четыре угла экрана в координатах клеток. Нужны рамке на миникарте. */
  const viewCorners = (): readonly CellPoint[] => {
    const bounds = viewBounds();
    return [
      screenToWorld(bounds.minX, bounds.minY),
      screenToWorld(bounds.maxX, bounds.minY),
      screenToWorld(bounds.maxX, bounds.maxY),
      screenToWorld(bounds.minX, bounds.maxY),
    ];
  };

  applyCamera();
  relayoutMinimap();

  return {
    setMap(map) {
      // Перестраиваем только если карта действительно другая. Вызов на
      // каждом кадре с той же картой — обычное дело для игрового цикла,
      // и он не должен стоить ничего.
      if (currentMap === map) return;

      currentMap = map;
      terrainRebuildCount += 1;
      drawGround(groundGraphics, terrainColors);
      terrainBands.forEach((graphics, diagonal) => {
        drawTerrainDiagonal(graphics, map, diagonal, terrainColors);
      });
      drawMinimapTerrain(minimapTerrain, map, layout, minimapColors);
    },

    render(world, localPlayer, intent) {
      clearEntityLayers();

      // Дробный номер тика: мир идёт тридцать раз в секунду, кадров вдвое
      // больше, и эффект, посчитанный от целого номера, дёргался бы через
      // кадр. Снимается один раз на кадр — он же и отмечает смену тика.
      const time = clock.sample(world.tick, performance.now());
      const bounds = viewBounds();

      drawEntities(layers, world, bounds, entityColors, localPlayer);

      // Выстрелы поверх всех тел: выстрел — это событие, и прятать его
      // за телами не нужно, иначе бой в толпе перестаёт читаться.
      drawShots(shotLayers, world, time, bounds, shotColors, localPlayer);

      // Размах тряски приходит оттуда же, откуда взрывы: слоями владеет
      // сцена, а решает, насколько тряхнуть, тот, кто знает про взрывы.
      const shake = drawBlasts(
        blastLayers,
        world,
        time,
        bounds,
        { width: app.screen.width, height: app.screen.height },
        blastColors,
        localPlayer,
      );
      applyShake(shake, time);

      drawOverlays(overlayGraphics, world, localPlayer, intent, overlayColors);

      frame += 1;
      if (frame % MINIMAP_EVERY_FRAMES === 0) {
        drawMinimapEntities(
          minimapEntities,
          world,
          localPlayer,
          viewCorners(),
          layout,
          minimapColors,
        );
      }
    },

    panBy(dx, dy) {
      following = false;
      camera = moveCamera(camera, dx, dy);
      applyCamera();
    },

    centreOnCell(cell) {
      following = false;
      const point = worldToScreen(
        (cell % MAP_WIDTH_CELLS) + 0.5,
        Math.floor(cell / MAP_WIDTH_CELLS) + 0.5,
      );
      camera = { x: point.x, y: point.y };
      applyCamera();
    },

    follow(point) {
      if (!following || point === undefined) return;

      const screen = worldToScreen(point.x, point.y);
      camera = { x: screen.x, y: screen.y };
      applyCamera();
    },

    setFollowing(enabled) {
      following = enabled;
    },

    get following() {
      return following;
    },

    cellAtScreen(screenX, screenY) {
      // Читается положение мирового контейнера, а не внешнего: тряска
      // живёт во внешнем и на наведение влиять не должна.
      const point = screenToWorld(screenX - worldContainer.x, screenY - worldContainer.y);
      const x = Math.floor(point.x);
      const y = Math.floor(point.y);

      if (x < 0 || y < 0 || x >= MAP_WIDTH_CELLS || y >= MAP_HEIGHT_CELLS) return -1;

      return cellIndex(x, y);
    },

    minimapCellAtScreen(screenX, screenY) {
      return minimapCellAt(screenX, screenY, layout);
    },

    resize() {
      // Сначала пересчитывается сам рендерер, и только потом всё, что
      // от его размеров зависит.
      //
      // Порядок важен. PixiJS с `resizeTo` подписан на событие resize
      // ОКНА, а размер контейнера меняется и без него: полосы интерфейса
      // задают его отступами, и смена высоты тулбара окна не трогает.
      // Без этой строки `app.screen` остался бы прежним, и камера
      // с миникартой улеглись бы по размерам, которых уже нет.
      app.resize();

      applyCamera();
      relayoutMinimap();
    },

    destroy() {
      app.destroy(true, { children: true });
    },

    get terrainRebuildCount() {
      return terrainRebuildCount;
    },

    get viewportSize() {
      return { width: app.screen.width, height: app.screen.height };
    },
  };
};
