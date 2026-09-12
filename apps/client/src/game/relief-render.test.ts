import { afterEach, describe, expect, it, vi } from 'vitest';
import { Container, Sprite } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import { MAP_CELL_COUNT, Terrain } from '@td/shared';
import type { GameMap } from '@td/sim';
import {
  bakeRockCell,
  disposeGrainTexture,
  mountRockDiagonal,
  replaceRockDetail,
} from './relief-render.js';

const backend = vi.hoisted(() => ({
  meshes: [] as { destroy: ReturnType<typeof vi.fn> }[],
  textures: [] as {
    destroy: ReturnType<typeof vi.fn>;
    source: { updateMipmaps: ReturnType<typeof vi.fn> };
  }[],
}));
vi.mock('pixi.js', () => {
  class Texture {
    source = { updateMipmaps: vi.fn() };
    destroy = vi.fn();
    static from(): Texture {
      return new Texture();
    }
    static create(): Texture {
      const texture = new Texture();
      backend.textures.push(texture);
      return texture;
    }
  }
  class Container {
    children: Container[] = [];
    position = { set: vi.fn() };
    destroy = vi.fn();
    addChild(child: Container): void {
      this.children.push(child);
    }
    removeChildren(): Container[] {
      return this.children.splice(0);
    }
  }
  class Sprite extends Container {
    constructor(public texture: Texture) {
      super();
    }
  }
  class Mesh {
    destroy = vi.fn();
    constructor() {
      backend.meshes.push(this);
    }
  }
  return {
    Container,
    Sprite,
    Mesh,
    Texture,
    RenderTexture: Texture,
    Geometry: class {},
    Shader: class {},
    GlProgram: { from: vi.fn() },
  };
});

const map: GameMap = { cells: new Uint8Array(MAP_CELL_COUNT).fill(Terrain.Rock), baseCells: [] };
const colors = { rock: 0, sky: 0 };
const renderer = (render = vi.fn()): Renderer => ({ render }) as unknown as Renderer;
const bake = (r = renderer()) => bakeRockCell(r, map, 20, 20, colors, 2);

afterEach(() => {
  disposeGrainTexture();
  backend.meshes.length = 0;
  backend.textures.length = 0;
  vi.unstubAllGlobals();
});

const canvas = (): void => {
  vi.stubGlobal('document', {
    createElement: () => ({
      getContext: () => ({
        createImageData: (w: number, h: number) => ({ data: new Uint8Array(w * h * 4) }),
        putImageData: vi.fn(),
      }),
    }),
  });
};

describe('поклеточное запекание', () => {
  it('печёт отражение перед телом, строит mip один раз и освобождает сетки', () => {
    canvas();
    const render = vi.fn();
    const result = bake(renderer(render));
    expect(render.mock.calls.map(([call]) => call.clear)).toEqual([true, false]);
    expect(render.mock.calls[0]?.[0].container).toBe(backend.meshes[1]);
    expect(render.mock.calls[1]?.[0].container).toBe(backend.meshes[0]);
    expect(result.texture.source.updateMipmaps).toHaveBeenCalledTimes(1);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    for (const mesh of backend.meshes) expect(mesh.destroy).toHaveBeenCalledWith(true);
    expect(result.texture.destroy).not.toHaveBeenCalled();
  });

  it('при ошибке прохода освобождает текстуру и обе сетки', () => {
    canvas();
    expect(() =>
      bake(
        renderer(
          vi.fn(() => {
            throw new Error('render');
          }),
        ),
      ),
    ).toThrow('render');
    for (const mesh of backend.meshes) expect(mesh.destroy).toHaveBeenCalledWith(true);
    expect(backend.textures[0]?.destroy).toHaveBeenCalledWith(true);
  });

  it('заменяет только подробность, сохраняет базу и соседей слоя', () => {
    canvas();
    const base = bake();
    const first = bake();
    const second = bake();
    const layer = new Container();
    const neighbour = new Container();
    const sprite = new Sprite(base.texture);
    layer.addChild(neighbour);
    layer.addChild(sprite);
    const cell = { base, sprite };
    replaceRockDetail(cell, first);
    expect(base.texture.destroy).not.toHaveBeenCalled();
    replaceRockDetail(cell, second);
    expect(first.texture.destroy).toHaveBeenCalledWith(true);
    expect(base.texture.destroy).not.toHaveBeenCalled();
    replaceRockDetail(cell);
    expect(sprite.texture).toBe(base.texture);
    expect(second.texture.destroy).toHaveBeenCalledWith(true);
    expect(base.texture.destroy).not.toHaveBeenCalled();
    expect(layer.children).toEqual([neighbour, sprite]);
    expect(neighbour.destroy).not.toHaveBeenCalled();
  });

  it('сохраняет синхронное начальное построение диагонали', () => {
    canvas();
    const layer = new Container();
    mountRockDiagonal(layer, renderer(), map, 0, colors, 1);
    expect(layer.children).toHaveLength(1);
    expect(backend.textures).toHaveLength(1);
  });
});
