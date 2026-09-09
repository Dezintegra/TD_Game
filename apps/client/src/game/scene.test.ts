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
import { mountRockDiagonal } from './relief-render.js';
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
  return { Container, Graphics, Sprite: Container, Application: class {} };
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
  const baked = vi.mocked(mountRockDiagonal).mock.calls.length;
  expect(baseline).toBe(1);
  expect(baked).toBe(TERRAIN_DIAGONAL_COUNT);
  for (let frame = 0; frame < 100; frame += 1) {
    stimulate(frame);
    scene.setMap(world.map, LOCAL_PLAYER);
    expect(scene.bakeTerrain(0)).toBe(false);
    scene.render(world, LOCAL_PLAYER, intent);
    observe(frame);
    expect(scene.terrainRebuildCount).toBe(baseline);
    expect(mountRockDiagonal).toHaveBeenCalledTimes(baked);
  }
  expect(drawEntities).toHaveBeenCalledTimes(100);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(drawEntities).mockReset();
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
    expect(isPassable(map.cells[cell] as Terrain)).toBe(true);
  });
});
