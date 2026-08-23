import { describe, expect, it } from 'vitest';
import type { Graphics } from 'pixi.js';
import { STICK_DEAD_ZONE_PX, drawTouchStick } from './touch-stick.js';
import type { TouchStick } from './controls.js';

/**
 * Невидимый джойстик неотличим от неработающего экрана: игрок, не понявший,
 * что палец уже что-то делает, решит, что игра его не слышит, — и чинить
 * пойдёт не то.
 *
 * Проверяется здесь не красота, а три свойства, каждое из которых
 * при поломке выглядит не поломкой: рисуется ли джойстик вообще, не уходит
 * ли метка за разумный предел и не растягивается ли она по-разному
 * в зависимости от того, куда уехал палец.
 */

interface Shape {
  readonly kind: 'point' | 'circle';
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

const tracing = (): { graphics: Graphics; shapes: Shape[] } => {
  const shapes: Shape[] = [];
  const stub: Record<string, (...args: number[]) => unknown> = {};

  for (const name of ['moveTo', 'lineTo']) {
    stub[name] = (x = 0, y = 0) => {
      shapes.push({ kind: 'point', x, y, radius: 0 });
      return stub;
    };
  }

  stub['circle'] = (x = 0, y = 0, radius = 0) => {
    shapes.push({ kind: 'circle', x, y, radius });
    return stub;
  };

  for (const name of ['fill', 'stroke', 'clear']) {
    stub[name] = () => stub;
  }

  return { graphics: stub as unknown as Graphics, shapes };
};

const colors = { self: 0x00ff29, idle: 0x808080 };

const stick = (x: number, y: number, engaged: boolean): TouchStick => ({
  originX: 100,
  originY: 100,
  x,
  y,
  engaged,
});

describe('отрисовка замирающего свайпа', () => {
  it('без пальца не рисуется ничего', () => {
    const { graphics, shapes } = tracing();
    drawTouchStick(graphics, null, colors);

    expect(shapes).toHaveLength(0);
  });

  it('до порога не рисуется ничего', () => {
    // Тап начинал бы рисовать метку, которая тут же исчезает, и это
    // мельтешение под пальцем читается дрожанием, а не откликом.
    const { graphics, shapes } = tracing();
    drawTouchStick(graphics, stick(105, 103, false), colors);

    expect(shapes).toHaveLength(0);
  });

  it('за порогом видны и точка отсчёта, и метка под пальцем', () => {
    const { graphics, shapes } = tracing();
    drawTouchStick(graphics, stick(160, 100, true), colors);

    const circles = shapes.filter((shape) => shape.kind === 'circle');
    expect(circles.length).toBeGreaterThanOrEqual(3);

    // Кольцо мёртвой зоны стоит ровно на пороге включения: игрок видит,
    // где джойстик перестаёт молчать.
    expect(circles.some((shape) => shape.radius === STICK_DEAD_ZONE_PX)).toBe(true);

    // Точка отсчёта осталась там, где палец её поставил.
    expect(circles.some((shape) => shape.x === 100 && shape.y === 100)).toBe(true);
  });

  it('метка не убегает за предел, как бы далеко ни уехал палец', () => {
    // Палец может уехать через весь экран, а джойстик, растянувшийся
    // следом, залез бы на тулбар и перестал читаться.
    const { graphics, shapes } = tracing();
    drawTouchStick(graphics, stick(2000, 100, true), colors);

    const knob = shapes
      .filter((shape) => shape.kind === 'circle')
      .reduce((far, shape) => (Math.abs(shape.x - 100) > Math.abs(far.x - 100) ? shape : far));

    expect(Math.abs(knob.x - 100)).toBeLessThanOrEqual(100);
  });

  it('обрезка не меняет направление', () => {
    // Обрежь по осям — и диагональ превратилась бы в другую диагональ.
    // Обрезается длина, поэтому угол сохраняется.
    const { graphics, shapes } = tracing();
    drawTouchStick(graphics, stick(1100, 1100, true), colors);

    const knob = shapes
      .filter((shape) => shape.kind === 'circle' && shape.radius < 30)
      .reduce((far, shape) => (Math.abs(shape.x - 100) > Math.abs(far.x - 100) ? shape : far));

    // Палец ушёл ровно по диагонали — метка обязана остаться на ней же.
    expect(knob.x - 100).toBeCloseTo(knob.y - 100, 6);
  });
});
