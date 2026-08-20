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
  health: token('--td-health-full', 0x00ff29),
  healthLow: token('--td-health-low', 0xff5c5c),
  shot: token('--td-projectile', 0xeaffef),
  shotLethal: token('--td-health-low', 0xff5c5c),
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

  const worldContainer = new Container();

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

  const shotGraphics = new Graphics();
  const overlayGraphics = new Graphics();
  worldContainer.addChild(shotGraphics, overlayGraphics);

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
    shots: shotGraphics,
  };

  const clearEntityBands = (): void => {
    for (const band of usedBands) {
      entityBands[band]?.clear();
      bandUsed[band] = 0;
    }
    usedBands.length = 0;
    shotGraphics.clear();
  };

  // Миникарта живёт в экранных координатах, поэтому лежит не в мировом
  // контейнере, а прямо на сцене: сдвиг камеры её двигать не должен.
  const minimapContainer = new Container();
  const minimapTerrain = new Graphics();
  const minimapEntities = new Graphics();
  minimapContainer.addChild(minimapTerrain, minimapEntities);

  app.stage.addChild(worldContainer, minimapContainer);

  const terrainColors = readTerrainColors();
  const entityColors = readEntityColors();
  const overlayColors = readOverlayColors();
  const minimapColors = readMinimapColors();

  let camera: Camera = createCamera();
  let currentMap: GameMap | undefined;
  let terrainRebuildCount = 0;
  let following = true;
  let layout: MinimapLayout = minimapLayout(app.screen.width, app.screen.height);
  let frame = 0;

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
      clearEntityBands();
      drawEntities(layers, world, viewBounds(), entityColors, localPlayer);
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
