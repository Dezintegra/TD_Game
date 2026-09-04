import { describe, expect, it } from 'vitest';
import type { Graphics } from 'pixi.js';
import { traceGroundCircle } from './ground-circle.js';
import { GROUND_SQUASH, worldToScreen } from './iso.js';

/**
 * Окружность на земле проверяется числами, а не осмотром: её беда —
 * не «выглядит криво», а «на двух картинках одного удара разные фигуры».
 * Поймать такое глазами нельзя, потому что каждая по отдельности выглядит
 * правдоподобно.
 */

const tracing = (): { graphics: Graphics; points: { x: number; y: number }[] } => {
  const points: { x: number; y: number }[] = [];
  const stub: Record<string, (...args: number[]) => unknown> = {};

  for (const name of ['moveTo', 'lineTo']) {
    stub[name] = (x = 0, y = 0) => {
      points.push({ x, y });
      return stub;
    };
  }

  return { graphics: stub as unknown as Graphics, points };
};

const extentOf = (points: readonly { readonly x: number; readonly y: number }[]) => ({
  width: Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x)),
  height: Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y)),
});

/** Столько отрезков берёт поле; миникарта берёт своё число. */
const FIELD_STEPS = 56;

describe('окружность на земле', () => {
  it('даёт steps + 1 точку и замыкается в исходную', () => {
    // Последняя точка совпадает с первой намеренно: вызывающий волен
    // обвести фигуру, а не залить, и незамкнутая обводка оставила бы
    // прореху шириной в отрезок.
    const { graphics, points } = tracing();
    traceGroundCircle(graphics, 10, 12, 4, worldToScreen, FIELD_STEPS);

    expect(points).toHaveLength(FIELD_STEPS + 1);

    const first = points[0];
    const last = points[points.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first === undefined || last === undefined) return;

    expect(last.x).toBeCloseTo(first.x, 9);
    expect(last.y).toBeCloseTo(first.y, 9);
  });

  it('первая точка лежит на угле ноль', () => {
    // Ломаная обязана совпасть с той, что рисовалась в overlays.ts до
    // выноса: расхождение сдвинуло бы стык обводки, а с ним и вид кольца.
    const { graphics, points } = tracing();
    traceGroundCircle(graphics, 10, 12, 4, worldToScreen, FIELD_STEPS);

    const expected = worldToScreen(14, 12);
    const first = points[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    expect(first.x).toBeCloseTo(expected.x, 9);
    expect(first.y).toBeCloseTo(expected.y, 9);
  });

  it('число отрезков берётся из параметра', () => {
    // Ради этого функция и вынесена: миникарте полсотни отрезков ни к чему,
    // круг там всего пара десятков точек в поперечнике.
    const { graphics, points } = tracing();
    traceGroundCircle(graphics, 10, 12, 4, worldToScreen, 20);

    expect(points).toHaveLength(21);
  });

  it('габарит сплющен ровно настолько, насколько сплющивает проекция', () => {
    // Круг на земле ложится на экран эллипсом: вдоль взгляда земля видна
    // в полную длину, поперёк — укороченной на синус наклона камеры.
    // Ровный круг соврал бы о накрываемой площади.
    const { graphics, points } = tracing();
    traceGroundCircle(graphics, 20, 20, 4, worldToScreen, 360);

    const extent = extentOf(points);
    expect(extent.width / extent.height).toBeCloseTo(1 / GROUND_SQUASH, 3);

    // И это именно эллипс, а не выродившийся отрезок.
    expect(extent.height).toBeGreaterThan(1);
  });

  it('проекция подставляется, а не зашита', () => {
    // Миникарта подставляет ту же проекцию, ужатую под свой размер.
    // Значит, ужатие обязано попадать в габарит один к одному.
    const scale = 0.25;
    const shrunk = (cellsX: number, cellsY: number) => {
      const point = worldToScreen(cellsX, cellsY);
      return { x: point.x * scale + 500, y: point.y * scale + 300 };
    };

    const field = tracing();
    traceGroundCircle(field.graphics, 20, 20, 4, worldToScreen, 360);

    const shrunken = tracing();
    traceGroundCircle(shrunken.graphics, 20, 20, 4, shrunk, 360);

    const onField = extentOf(field.points);
    const onSmall = extentOf(shrunken.points);

    expect(onSmall.width).toBeCloseTo(onField.width * scale, 6);
    expect(onSmall.height).toBeCloseTo(onField.height * scale, 6);
  });
});
