import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'pixi.js';
import { MAP_CELL_COUNT, Terrain, asPlayerId, isPassable } from '@td/shared';
import { cellIndex, cellX, cellY } from '@td/sim';
import type { GameMap } from '@td/sim';
import { createScene } from './scene.js';
import type { RendererHost, Scene } from './scene.js';
import { TERRAIN_DIAGONAL_COUNT } from './terrain.js';
import { mountRockDiagonal } from './relief-render.js';
import type * as TerrainModule from './terrain.js';
import type * as ReliefModule from './relief-render.js';
import type * as MinimapModule from './minimap.js';

// Граница графики сохраняет дерево и преобразования, но не требует WebGL.
vi.mock('pixi.js', () => {
  class Point {
    constructor(
      public x = 0,
      public y = 0,
    ) {}
    set(x: number, y = x): void {
      this.x = x;
      this.y = y;
    }
  }
  class Container {
    children: Container[] = [];
    position = new Point();
    scale = new Point(1, 1);
    x = 0;
    y = 0;
    addChild(...children: Container[]): Container | undefined {
      this.children.push(...children);
      return children[0];
    }
    removeChildren(): Container[] {
      return this.children.splice(0);
    }
    destroy(): void {
      for (const child of this.removeChildren()) child.destroy();
    }
  }
  class Graphics extends Container {
    clear(): void {}
  }
  return { Container, Graphics, Sprite: Container, Application: class {} };
});
vi.mock('./terrain.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TerrainModule>()),
  drawGround: vi.fn(),
}));
vi.mock('./relief-render.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ReliefModule>()),
  mountRockDiagonal: vi.fn(),
}));
vi.mock('./base-structure.js', () => ({ placeBase: vi.fn() }));
vi.mock('./machine-sprites.js', () => ({ createMachineSprites: vi.fn() }));
vi.mock('./structure-sprites.js', () => ({ createStructureSprites: vi.fn() }));
vi.mock('./icon-sprites.js', () => ({ createIconBaker: () => ({ step: () => null }) }));
vi.mock('./arc-render.js', () => ({
  createArcSprites: () => ({
    layer: new Container(),
    begin: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  }),
}));
vi.mock('./entities.js', () => ({ drawEntities: vi.fn() }));
vi.mock('./shots.js', () => ({ drawShots: vi.fn() }));
vi.mock('./blasts.js', () => ({ drawBlasts: () => 0, shakeOffset: () => ({ x: 0, y: 0 }) }));
vi.mock('./overlays.js', () => ({ drawOverlays: vi.fn() }));
vi.mock('./touch-stick.js', () => ({ drawTouchStick: vi.fn() }));
vi.mock('./minimap.js', async (importOriginal) => ({
  ...(await importOriginal<typeof MinimapModule>()),
  drawMinimapEntities: vi.fn(),
  drawMinimapTerrain: vi.fn(),
}));

const LOCAL_PLAYER = asPlayerId(0);
const scenes: Scene[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('document', { documentElement: {} });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
});
afterEach(() => {
  try {
    for (const scene of scenes.splice(0)) scene.destroy();
  } finally {
    vi.unstubAllGlobals();
  }
});

const makeScene = (): Scene => {
  // Остальные поля хозяина нужны только созданию рендерера и прогреву спрайтов.
  const host = {
    app: {
      stage: new Container(),
      screen: { width: 800, height: 600 },
      renderer: {},
      ticker: { start: vi.fn(), stop: vi.fn() },
    },
    machines: {},
    structures: {},
    density: 1,
  } as unknown as RendererHost;
  const scene = createScene(host);
  scenes.push(scene);
  return scene;
};
const makeMap = (): GameMap => {
  const cells = new Uint8Array(MAP_CELL_COUNT).fill(Terrain.Ground);
  cells[cellIndex(20, 20)] = Terrain.Rock;
  return { cells, baseCells: [cellIndex(5, 5), cellIndex(45, 45)] };
};

const finishBaking = (scene: Scene, map: GameMap): void => {
  const before = vi.mocked(mountRockDiagonal).mock.calls.length;
  let pending = true;
  for (let attempt = 0; attempt <= TERRAIN_DIAGONAL_COUNT && pending; attempt += 1) {
    pending = scene.bakeTerrain(0);
  }
  expect(pending).toBe(false);
  const calls = vi.mocked(mountRockDiagonal).mock.calls.slice(before);
  expect(calls).toHaveLength(TERRAIN_DIAGONAL_COUNT);
  expect(new Set(calls.map((call) => call[3])).size).toBe(TERRAIN_DIAGONAL_COUNT);
  for (const call of calls) expect(call[2]).toBe(map);
  expect(scene.bakeTerrain(0)).toBe(false);
  expect(mountRockDiagonal).toHaveBeenCalledTimes(before + TERRAIN_DIAGONAL_COUNT);
};

const builtScene = (): { scene: Scene; map: GameMap } => {
  const scene = makeScene();
  const map = makeMap();
  expect(scene.terrainRebuildCount).toBe(0);
  expect(isPassable(map.cells[cellIndex(20, 20)] ?? Terrain.Ground)).toBe(false);
  scene.setMap(map, LOCAL_PLAYER);
  expect(scene.terrainRebuildCount).toBe(1);
  finishBaking(scene, map);
  return { scene, map };
};

describe('инвалидация территории настоящей сцены', () => {
  it('подтверждает начальное построение и завершение запекания', () => {
    builtScene();
  });

  it('изменение проходимости вызывает одно перестроение и новое запекание', () => {
    const { scene, map } = builtScene();
    const cell = cellIndex(21, 20);
    const cells = map.cells.slice();
    cells[cell] = Terrain.Rock;
    const changed = { ...map, cells };
    expect(changed).not.toBe(map);
    expect(changed.cells).not.toBe(map.cells);
    expect(isPassable(map.cells[cell] ?? Terrain.Rock)).toBe(true);
    expect(isPassable(changed.cells[cell] ?? Terrain.Ground)).toBe(false);
    const baseline = scene.terrainRebuildCount;
    const baked = vi.mocked(mountRockDiagonal).mock.calls.length;
    scene.setMap(changed, LOCAL_PLAYER);
    expect(scene.terrainRebuildCount).toBe(baseline + 1);
    finishBaking(scene, changed);
    const diagonal = vi
      .mocked(mountRockDiagonal)
      .mock.calls.slice(baked)
      .find((call) => call[3] === cellX(cell) + cellY(cell));
    expect(diagonal?.[2]).toBe(changed);
    expect(diagonal?.[2].cells[cell]).toBe(Terrain.Rock);
    scene.setMap(changed, LOCAL_PLAYER);
    expect(scene.bakeTerrain(0)).toBe(false);
    expect(scene.terrainRebuildCount).toBe(baseline + 1);
    expect(mountRockDiagonal).toHaveBeenCalledTimes(baked + TERRAIN_DIAGONAL_COUNT);
    expect(isPassable(map.cells[cell] ?? Terrain.Rock)).toBe(true);
  });
});
