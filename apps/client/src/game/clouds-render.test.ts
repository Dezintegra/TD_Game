import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Renderer, Sprite, TextureSource } from 'pixi.js';
import { armourBakeDensity } from './bake-density.js';
import { CLOUD_TEXTURE_SIZE, createCloudLayer } from './clouds-render.js';
import { CLOUD_PUFF_LIMIT, CLOUD_VARIANTS } from './clouds.js';

// Шум проверяется в relief.test.ts; здесь важны размер буфера, загрузка
// готового рисунка и срок жизни GPU-ресурсов, а не миллионы проб шума.
vi.mock('./relief.js', () => ({ fbm: () => 0.5 }));

afterEach(() => vi.unstubAllGlobals());

const fixture = (screenDensity: number) => {
  const canvases: { width: number; height: number; painted: boolean }[] = [];
  vi.stubGlobal('document', {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        painted: false,
        getContext: () => ({
          createImageData: (width: number, height: number) => ({
            data: new Uint8ClampedArray(width * height * 4),
          }),
          putImageData: () => {
            canvas.painted = true;
          },
        }),
      };
      canvases.push(canvas);
      return canvas;
    },
  });
  const sources: TextureSource[] = [];
  const initSource = vi.fn((source: TextureSource) => {
    // Загрузка неизменяемого canvas с этим флагом строит мип-уровни
    // автоматически. Флаг и рисунок должны быть готовы ДО загрузки.
    expect(source.autoGenerateMipmaps).toBe(true);
    expect(canvases[sources.length]?.painted).toBe(true);
    sources.push(source);
  });
  const renderer = { resolution: screenDensity, texture: { initSource } };
  const density = armourBakeDensity(renderer.resolution);
  const clouds = createCloudLayer(renderer as unknown as Renderer, { cloud: 1, deep: 2 }, density);
  return { clouds, canvases, sources, initSource, density };
};

describe('запекание мглы', () => {
  it('повышает физическую плотность без изменения логического и экранного размеров', () => {
    const sizes: number[] = [];
    const spreads: number[][] = [];
    for (const screenDensity of [1, 2]) {
      const { clouds, canvases, sources, density } = fixture(screenDensity);
      expect(canvases).toHaveLength(CLOUD_VARIANTS);
      for (const canvas of canvases) {
        expect(canvas.width).toBe(CLOUD_TEXTURE_SIZE * density);
        expect(canvas.height).toBe(CLOUD_TEXTURE_SIZE * density);
      }
      for (const source of sources) {
        expect(source.width).toBe(256);
        expect(source.height).toBe(256);
        expect(source.resolution).toBe(density);
      }
      sizes.push(canvases[0]!.width);
      clouds.update(1000, { x: 0, y: 0 }, { width: 1280, height: 720 });
      expect(clouds.layer.children).toHaveLength(CLOUD_PUFF_LIMIT);
      spreads.push(clouds.layer.children.map((child) => (child as Sprite).width));
      clouds.destroy();
    }
    expect(sizes[1]).toBeGreaterThan(sizes[0]!);
    expect(spreads[1]).toEqual(spreads[0]);
    expect(spreads[0]!.every((width) => width > 0)).toBe(true);
  });

  it('загружает каждый вариант с мип-уровнями один раз и освобождает все текстуры', () => {
    const { clouds, sources, initSource } = fixture(1);
    const textures = [...new Set(clouds.layer.children.map((child) => (child as Sprite).texture))];
    const mipUpdates = sources.map((source) => vi.spyOn(source, 'updateMipmaps'));
    expect(textures).toHaveLength(CLOUD_VARIANTS);
    expect(initSource).toHaveBeenCalledTimes(CLOUD_VARIANTS);
    for (let frame = 0; frame < 100; frame += 1) {
      clouds.update(frame * 16, { x: frame, y: frame }, { width: 1280, height: 720 });
    }
    expect(initSource).toHaveBeenCalledTimes(CLOUD_VARIANTS);
    for (const update of mipUpdates) expect(update).not.toHaveBeenCalled();
    clouds.destroy();
    for (const texture of textures) expect(texture.destroyed).toBe(true);
    for (const source of sources) expect(source.destroyed).toBe(true);
    expect(clouds.layer.destroyed).toBe(true);
  });
});
