import { describe, expect, it } from 'vitest';
import { MAP_CELL_COUNT, PROJECTION_YAW_DEG } from '@td/shared';
import {
  CELL_SCREEN_AREA_PX,
  MAP_BOUNDS,
  screenToWorld,
  visibleCellCount,
  visibleMapPercent,
  worldToScreen,
} from './iso.js';

describe('проекция поля', () => {
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

  it('оси мира расходятся в разные стороны по горизонтали', () => {
    // Ключевое свойство: движение по одной мировой оси уводит вправо,
    // по другой — влево, и обе уводят вниз.
    expect(worldToScreen(1, 0).x).toBeGreaterThan(0);
    expect(worldToScreen(0, 1).x).toBeLessThan(0);
    expect(worldToScreen(1, 0).y).toBeGreaterThan(0);
    expect(worldToScreen(0, 1).y).toBeGreaterThan(0);
  });

  it('поворот не равен 45 градусам, поэтому оси несимметричны', () => {
    // Это и есть причина отказа от честной изометрии. При 45 градусах
    // обе оси ложились бы на экран зеркально, все рёбра выстраивались бы
    // в одни и те же диагонали, и силуэты соседних объектов сливались бы.
    expect(PROJECTION_YAW_DEG).not.toBe(45);

    const alongX = worldToScreen(1, 0);
    const alongY = worldToScreen(0, 1);

    expect(Math.abs(alongX.x)).not.toBeCloseTo(Math.abs(alongY.x), 1);
    expect(alongX.y).not.toBeCloseTo(alongY.y, 1);
  });

  it('начало координат совпадает с северным углом карты', () => {
    expect(worldToScreen(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it('проекция линейна: прямая в мире остаётся прямой на экране', () => {
    // На этом свойстве держится отрисовка сетки длинными линиями.
    const a = worldToScreen(0, 5);
    const b = worldToScreen(10, 5);
    const middle = worldToScreen(5, 5);

    expect(middle.x).toBeCloseTo((a.x + b.x) / 2, 9);
    expect(middle.y).toBeCloseTo((a.y + b.y) / 2, 9);
  });
});

describe('видимая доля карты', () => {
  it('при окне 1920 × 1080 видно от 7 до 14 процентов карты', () => {
    const percent = visibleMapPercent(1920, 1080);

    expect(percent).toBeGreaterThanOrEqual(7);
    expect(percent).toBeLessThanOrEqual(14);
  });

  it('площадь клетки не зависит от угла поворота, только от наклона', () => {
    // Определитель матрицы проекции равен масштаб² × sin(наклон).
    // Поворот перераспределяет клетку между осями, но не меняет её площадь.
    expect(CELL_SCREEN_AREA_PX).toBeGreaterThan(0);
    expect(visibleCellCount(1920, 1080)).toBeCloseTo((1920 * 1080) / CELL_SCREEN_AREA_PX, 9);
  });

  it('число видимых клеток меньше размера карты', () => {
    expect(visibleCellCount(1920, 1080)).toBeLessThan(MAP_CELL_COUNT);
  });

  it('вдвое большее окно показывает вдвое больше клеток', () => {
    expect(visibleCellCount(1920, 2160)).toBeCloseTo(visibleCellCount(1920, 1080) * 2, 9);
  });
});

describe('габариты карты', () => {
  it('охватывают все четыре угла карты', () => {
    // При повороте, отличном от 45 градусов, карта проецируется в косой
    // параллелограмм, поэтому границы нельзя вывести из размера клетки.
    expect(MAP_BOUNDS.minX).toBeLessThan(0);
    expect(MAP_BOUNDS.maxX).toBeGreaterThan(0);
    expect(MAP_BOUNDS.minY).toBe(0);
    expect(MAP_BOUNDS.maxY).toBeGreaterThan(0);
  });

  it('несимметричны по горизонтали из-за поворота', () => {
    expect(Math.abs(MAP_BOUNDS.minX)).not.toBeCloseTo(MAP_BOUNDS.maxX, 1);
  });
});
