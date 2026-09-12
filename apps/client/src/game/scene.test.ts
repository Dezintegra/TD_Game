import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'pixi.js';
import {
  DIRECTION_SOUTH,
  FIXED_POINT_SCALE,
  MAP_CELL_COUNT,
  Terrain,
  UnitType,
  asEntityId,
  asPlayerId,
  asTickNumber,
  isPassable,
} from '@td/shared';
import { cellCentre, cellIndex, cellX, cellY, createWorld } from '@td/sim';
import type { GameMap, WorldState } from '@td/sim';
import { createScene } from './scene.js';
import type { RendererHost, Scene } from './scene.js';
import { TERRAIN_DIAGONAL_COUNT, drawField, drawGrid } from './terrain.js';
import { bakeRockCell, countRockCells, disposeGrainTexture } from './relief-render.js';
import type * as TerrainModule from './terrain.js';
import type * as ReliefModule from './relief-render.js';
import type * as MinimapModule from './minimap.js';
import { drawEntities } from './entities.js';
import { worldToScreen } from './iso.js';
import type { OverlayIntent } from './overlays.js';

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
    visible = true;
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
  class Texture {
    destroyed = false;
    source = { destroyed: false, updateMipmaps: vi.fn() };
    static from(): Texture {
      return new Texture();
    }
    static create(): Texture {
      return new Texture();
    }
    destroy(): void {
      this.destroyed = true;
      this.source.destroyed = true;
    }
  }
  class Sprite extends Container {
    constructor(public texture: Texture) {
      super();
    }
  }
  return {
    Container,
    Graphics,
    Sprite,
    Texture,
    RenderTexture: Texture,
    Mesh: class {
      destroy(): void {}
    },
    Geometry: class {},
    Shader: class {},
    GlProgram: { from: vi.fn() },
    Application: class {},
  };
});
vi.mock('./terrain.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TerrainModule>()),
  drawField: vi.fn(),
  drawGrid: vi.fn(),
}));
vi.mock('./clouds-render.js', () => ({
  createCloudLayer: () => ({
    layer: new Container(),
    update: vi.fn(),
    destroy: vi.fn(),
  }),
}));
vi.mock('./relief-render.js', async (importOriginal) => {
  const original = await importOriginal<typeof ReliefModule>();
  return { ...original, bakeRockCell: vi.fn(original.bakeRockCell) };
});
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
const hosts = new WeakMap<Scene, RendererHost>();
const INTENT: OverlayIntent = {
  building: false,
  touch: null,
  buildKind: null,
  aimingNuke: false,
  hoverCell: -1,
  hoverAllowed: false,
  nukeRadiusCells: 0,
  selectedCell: -1,
};

const frameWorld = (map: GameMap): WorldState => ({ ...createWorld(4242), map });

const stableFrames = (
  scene: Scene,
  world: WorldState,
  stimulate: (frame: number) => void,
  observe: (frame: number) => void = () => undefined,
  intent: OverlayIntent = INTENT,
): void => {
  const baseline = scene.terrainRebuildCount;
  const baked = vi.mocked(bakeRockCell).mock.calls.length;
  expect(baseline).toBe(1);
  expect(baked).toBe(countRockCells(world.map));
  for (let frame = 0; frame < 100; frame += 1) {
    stimulate(frame);
    scene.setMap(world.map, LOCAL_PLAYER);
    expect(scene.bakeTerrain(0)).toBe(false);
    scene.render(world, LOCAL_PLAYER, intent);
    scene.adaptRocks(8);
    observe(frame);
    expect(scene.terrainRebuildCount).toBe(baseline);
    expect(bakeRockCell).toHaveBeenCalledTimes(baked);
  }
  expect(drawEntities).toHaveBeenCalledTimes(100);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(drawEntities).mockReset();
  vi.stubGlobal('document', {
    documentElement: {},
    createElement: () => ({
      getContext: () => ({
        createImageData: (w: number, h: number) => ({ data: new Uint8Array(w * h * 4) }),
        putImageData: vi.fn(),
      }),
    }),
  });
  vi.spyOn(performance, 'now').mockReturnValue(0);
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
});
afterEach(() => {
  try {
    for (const scene of scenes.splice(0)) scene.destroy();
  } finally {
    disposeGrainTexture();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

const makeScene = (): Scene => {
  // Остальные поля хозяина нужны только созданию рендерера и прогреву спрайтов.
  const host = {
    app: {
      stage: new Container(),
      screen: { width: 800, height: 600 },
      renderer: { resolution: 1, render: vi.fn() },
      resize: vi.fn(),
      ticker: { start: vi.fn(), stop: vi.fn() },
    },
    machines: {},
    structures: {},
    density: 1,
  } as unknown as RendererHost;
  const scene = createScene(host);
  hosts.set(scene, host);
  scenes.push(scene);
  return scene;
};
const makeMap = (): GameMap => {
  const cells = new Uint8Array(MAP_CELL_COUNT).fill(Terrain.Ground);
  cells[cellIndex(20, 20)] = Terrain.Rock;
  return { cells, baseCells: [cellIndex(5, 5), cellIndex(45, 45)] };
};

const finishBaking = (scene: Scene, map: GameMap): void => {
  const before = vi.mocked(bakeRockCell).mock.calls.length;
  let pending = true;
  for (let attempt = 0; attempt <= TERRAIN_DIAGONAL_COUNT && pending; attempt += 1)
    pending = scene.bakeTerrain(0);
  expect(pending).toBe(false);
  const calls = vi.mocked(bakeRockCell).mock.calls.slice(before);
  expect(calls).toHaveLength(countRockCells(map));
  expect(new Set(calls.map((call) => cellIndex(call[2], call[3]))).size).toBe(countRockCells(map));
  for (const call of calls) expect(call[1]).toBe(map);
  expect(scene.bakeTerrain(0)).toBe(false);
  scene.adaptRocks(0);
};

const builtScene = (): { scene: Scene; map: GameMap } => {
  const scene = makeScene();
  const map = makeMap();
  expect(scene.terrainRebuildCount).toBe(0);
  expect(isPassable(map.cells[cellIndex(20, 20)] as Terrain)).toBe(false);
  scene.setMap(map, LOCAL_PLAYER);
  expect(scene.terrainRebuildCount).toBe(1);
  finishBaking(scene, map);
  return { scene, map };
};

describe('инвалидация территории настоящей сцены', () => {
  it('сто переключений строительства меняют видимость сетки без перестроения', () => {
    const { scene, map } = builtScene();
    expect(drawField).toHaveBeenCalledTimes(1);
    expect(drawGrid).toHaveBeenCalledTimes(1);
    // Берём именно слой, построенный сценой, не подменяя настоящий showGrid.
    const grid = vi.mocked(drawGrid).mock.calls[0]![0];
    const field = vi.mocked(drawField).mock.calls[0]![0];
    expect(grid).not.toBe(field);
    expect(grid.visible).toBe(false);
    const intent = { ...INTENT };
    const modes = new Set<boolean>();
    stableFrames(
      scene,
      frameWorld(map),
      (frame) => {
        intent.building = frame % 2 === 0;
        expect(grid.visible).toBe(!intent.building);
        modes.add(intent.building);
      },
      () => {
        expect(grid.visible).toBe(intent.building);
        expect(field.visible).toBe(true);
        expect(drawField).toHaveBeenCalledTimes(1);
        expect(drawGrid).toHaveBeenCalledTimes(1);
      },
      intent,
    );
    expect(modes).toEqual(new Set([true, false]));
  });

  it('движение камеры сто кадров не перестраивает территорию', () => {
    const { scene, map } = builtScene();
    scene.centreOnCell(cellIndex(30, 30));
    stableFrames(scene, frameWorld(map), (frame) => {
      const before = scene.viewCentre;
      scene.panBy(frame % 2 === 0 ? 4 : -4, 0);
      expect(scene.viewCentre).not.toEqual(before);
    });
  });

  it('движение существующего юнита сто кадров не перестраивает территорию', () => {
    const { scene, map } = builtScene();
    scene.centreOnCell(cellIndex(30, 30));
    const unit = {
      id: asEntityId(600),
      owner: LOCAL_PLAYER,
      unitType: UnitType.Assault,
      position: cellCentre(cellIndex(30, 30)),
      health: 100,
      facing: DIRECTION_SOUTH,
      readyAtTick: asTickNumber(0),
      kills: 0,
    };
    const world = { ...frameWorld(map), units: [unit] };
    const samples: { id: number; x: number; y: number }[][] = [];
    vi.mocked(drawEntities).mockImplementation((_layers, drawn, bounds) => {
      // Копии не позволят следующему перемещению переписать свидетельство кадра.
      samples.push(drawn.units.map(({ id, position }) => ({ id, ...position })));
      for (const { position } of drawn.units) {
        const point = worldToScreen(position.x / FIXED_POINT_SCALE, position.y / FIXED_POINT_SCALE);
        expect(point.x).toBeGreaterThan(bounds.minX);
        expect(point.x).toBeLessThan(bounds.maxX);
        expect(point.y).toBeGreaterThan(bounds.minY);
        expect(point.y).toBeLessThan(bounds.maxY);
      }
    });
    stableFrames(
      scene,
      world,
      (frame) => {
        unit.position = cellCentre(cellIndex(frame % 2 === 0 ? 31 : 30, 30));
      },
      (frame) => {
        expect(samples[frame]).toEqual([{ id: unit.id, ...unit.position }]);
        if (frame > 0) expect(samples[frame]).not.toEqual(samples[frame - 1]);
      },
    );
    expect(samples).toHaveLength(100);
  });

  it('смена масштаба сто кадров не перестраивает территорию', () => {
    const { scene, map } = builtScene();
    scene.centreOnCell(cellIndex(30, 30));
    const baseScale = scene.scale;
    stableFrames(scene, frameWorld(map), (frame) => {
      const target = frame % 2 === 0 ? 1.5 : 2;
      const before = scene.scale;
      scene.zoomBy(target / scene.zoom, 400, 300);
      expect(scene.zoom).toBeCloseTo(target);
      expect(scene.scale).toBeCloseTo(baseScale * target);
      expect(scene.scale).not.toBe(before);
    });
  });

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
    expect(isPassable(map.cells[cell] as Terrain)).toBe(true);
    expect(isPassable(changed.cells[cell] as Terrain)).toBe(false);
    const baseline = scene.terrainRebuildCount;
    const baked = vi.mocked(bakeRockCell).mock.calls.length;
    scene.setMap(changed, LOCAL_PLAYER);
    expect(scene.terrainRebuildCount).toBe(baseline + 1);
    finishBaking(scene, changed);
    const diagonal = vi
      .mocked(bakeRockCell)
      .mock.calls.slice(baked)
      .find((call) => call[2] === cellX(cell) && call[3] === cellY(cell));
    expect(diagonal?.[1]).toBe(changed);
    expect(diagonal?.[1].cells[cell]).toBe(Terrain.Rock);
    scene.setMap(changed, LOCAL_PLAYER);
    expect(scene.bakeTerrain(0)).toBe(false);
    expect(scene.terrainRebuildCount).toBe(baseline + 1);
    expect(bakeRockCell).toHaveBeenCalledTimes(baked + countRockCells(changed));
    expect(isPassable(map.cells[cell] as Terrain)).toBe(true);
  });
});

const settle = (scene: Scene): void => {
  scene.adaptRocks(0);
  for (let frame = 0; frame < 200 && scene.rockDensity.remaining > 0; frame += 1) {
    scene.adaptRocks(8);
    expect(scene.rockDensity.error).toBeNull();
    expect(scene.rockDensity.cells.every((cell) => cell.alive)).toBe(true);
    expect(scene.rockDensity.actualBytes).toBeLessThanOrEqual(scene.rockDensity.limitBytes);
  }
  expect(scene.rockDensity.remaining).toBe(0);
};

describe('подключение плотности к настоящей сцене', () => {
  it('камера меняется немедленно, а повышение догоняет её позже', () => {
    const { scene } = builtScene();
    scene.centreOnCell(cellIndex(20, 20));
    const before = scene.scale;
    scene.zoomBy(4, 400, 300);
    expect(scene.scale).toBeGreaterThan(before);
    scene.adaptRocks(0);
    expect(scene.rockDensity.remaining).toBeGreaterThan(0);
    expect(scene.rockDensity.cells[0]!.density).toBe(1);
    settle(scene);
    expect(scene.rockDensity.cells[0]!.density).toBeGreaterThanOrEqual(scene.scale);
    expect(scene.terrainRebuildCount).toBe(1);
    expect(scene.bakeTerrain(0)).toBe(false);
  });

  it('resize сохраняет базу, смена resolution мигрирует её без исчезновения', () => {
    const { scene } = builtScene();
    const host = hosts.get(scene)!;
    scene.centreOnCell(cellIndex(20, 20));
    settle(scene);
    const completed = scene.rockDensity.completed;
    host.app.screen.width = 700;
    scene.resize();
    settle(scene);
    expect(scene.rockDensity.completed).toBe(completed);
    for (const resolution of [3, 1]) {
      host.app.renderer.resolution = resolution;
      scene.adaptRocks(0);
      expect(scene.rockDensity.cells.every((cell) => cell.alive)).toBe(true);
      settle(scene);
      expect(scene.rockDensity.cells.every((cell) => cell.base === resolution)).toBe(true);
      expect(scene.terrainRebuildCount).toBe(1);
    }
  });
});
