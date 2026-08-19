import { describe, expect, it } from 'vitest';
import { MAP_CELL_COUNT, TILE_HEIGHT_PX, TILE_WIDTH_PX } from '@td/shared';
import { screenToWorld, visibleCellCount, visibleMapPercent, worldToScreen } from './iso.js';

describe('изометрическая проекция', () => {
  it('прямое и обратное преобразование согласованы', () => {
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [17, 42],
      [95, 95],
    ]) {
      const screen = worldToScreen(x ?? 0, y ?? 0);
      const back = screenToWorld(screen.x, screen.y);

      expect(back.x).toBeCloseTo(x ?? 0, 9);
      expect(back.y).toBeCloseTo(y ?? 0, 9);
    }
  });

  it('соблюдает соотношение сторон 2:1', () => {
    const origin = worldToScreen(0, 0);
    const alongX = worldToScreen(1, 0);

    const horizontal = Math.abs(alongX.x - origin.x);
    const vertical = Math.abs(alongX.y - origin.y);

    expect(horizontal).toBe(vertical * 2);
    expect(horizontal).toBe(TILE_WIDTH_PX / 2);
    expect(vertical).toBe(TILE_HEIGHT_PX / 2);
  });

  it('оси мира расходятся в разные стороны по горизонтали', () => {
    // Ключевое свойство изометрии: движение по одной мировой оси уводит
    // вправо, по другой — влево, и обе одинаково уводят вниз.
    expect(worldToScreen(1, 0).x).toBeGreaterThan(0);
    expect(worldToScreen(0, 1).x).toBeLessThan(0);
    expect(worldToScreen(1, 0).y).toBe(worldToScreen(0, 1).y);
  });

  it('начало координат совпадает с верхним углом карты', () => {
    expect(worldToScreen(0, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe('видимая доля карты', () => {
  it('при окне 1920 × 1080 видно от 7 до 14 процентов карты', () => {
    const percent = visibleMapPercent(1920, 1080);

    expect(percent).toBeGreaterThanOrEqual(7);
    expect(percent).toBeLessThanOrEqual(14);
  });

  it('число видимых клеток согласуется с площадью карты', () => {
    const cells = visibleCellCount(1920, 1080);

    expect(cells).toBeGreaterThan(0);
    expect(cells).toBeLessThan(MAP_CELL_COUNT);
    expect(visibleMapPercent(1920, 1080)).toBeCloseTo((cells * 100) / MAP_CELL_COUNT, 9);
  });

  it('вдвое большее окно показывает вдвое больше клеток', () => {
    expect(visibleCellCount(1920, 2160)).toBeCloseTo(visibleCellCount(1920, 1080) * 2, 9);
  });
});
