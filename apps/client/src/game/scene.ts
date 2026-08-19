import { Application, Container, Graphics } from 'pixi.js';
import type { GameMap } from '@td/sim';
import { clampCamera, createCamera, moveCamera } from './camera.js';
import type { Camera } from './camera.js';
import { drawTerrain } from './terrain.js';
import type { TerrainColors } from './terrain.js';

/**
 * Сцена PixiJS: всё, что рисуется на игровом поле.
 *
 * React сюда не заглядывает. Это принципиально: поле обновляется каждый
 * кадр, и прогон таких обновлений через виртуальный DOM съел бы весь бюджет
 * времени. PixiJS рисует через WebGL и держит тысячи объектов на стабильных
 * 60 кадрах.
 *
 * Цвета берутся из тех же дизайн-токенов, что и HUD, — читаются из CSS.
 * Так палитра остаётся в одном месте, а не расползается по двум рендерерам.
 */
export interface Scene {
  /** Показывает карту. Геометрия перестраивается только при смене карты. */
  setMap(map: GameMap): void;
  /** Сдвигает камеру на заданное число экранных пикселей. */
  panBy(dx: number, dy: number): void;
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

const readTerrainColors = (): TerrainColors => ({
  grid: toPixiColor(readToken('--td-border-subtle', '#3a3a3a'), 0x3a3a3a),
  gridMajor: toPixiColor(readToken('--td-border-control', '#4d4d4d'), 0x4d4d4d),
  rock: toPixiColor(readToken('--td-text-muted-3', '#808080'), 0x808080),
  border: toPixiColor(readToken('--td-text-muted-4', '#6b6b6b'), 0x6b6b6b),
  // Читаем --td-accent, а не --td-player-self: последний объявлен через
  // var(), и получить из него готовый цвет средствами getComputedStyle
  // надёжно не выйдет.
  baseSelf: toPixiColor(readToken('--td-accent', '#00ff29'), 0x00ff29),
  baseEnemy: toPixiColor(readToken('--td-player-enemy', '#d264ff'), 0xd264ff),
});

export const createScene = async (host: HTMLElement): Promise<Scene> => {
  const app = new Application();

  await app.init({
    background: toPixiColor(readToken('--td-bg-page', '#191919'), 0x191919),
    antialias: true,
    // Учитываем плотность пикселей монитора, иначе на ретине картинка мылит.
    resolution: window.devicePixelRatio,
    autoDensity: true,
    resizeTo: host,
  });

  host.appendChild(app.canvas);

  const worldContainer = new Container();
  const terrainGraphics = new Graphics();
  worldContainer.addChild(terrainGraphics);
  app.stage.addChild(worldContainer);

  const colors = readTerrainColors();

  let camera: Camera = createCamera();
  let currentMap: GameMap | undefined;
  let terrainRebuildCount = 0;

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

  applyCamera();

  return {
    setMap(map) {
      // Перестраиваем только если карта действительно другая. Вызов на
      // каждом кадре с той же картой — обычное дело для игрового цикла,
      // и он не должен стоить ничего.
      if (currentMap === map) return;

      currentMap = map;
      terrainRebuildCount += 1;
      drawTerrain(terrainGraphics, map, colors);
    },

    panBy(dx, dy) {
      camera = moveCamera(camera, dx, dy);
      applyCamera();
    },

    resize() {
      applyCamera();
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
