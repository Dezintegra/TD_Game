import { describe, expect, it } from 'vitest';
import { RockBakeQueue } from './rock-bake-queue.js';
import type { RockResource, RockView } from './rock-bake-queue.js';
import { rockTextureBytes } from './bake-density.js';

const size = { width: 20, height: 40 };
const view = (resolution = 1, scale = 4, x = 0): RockView => ({
  width: 100,
  height: 100,
  resolution,
  scale,
  bounds: { minX: x, minY: 0, maxX: x + 100, maxY: 100 },
});
interface Resource extends RockResource {
  alive: boolean;
}
const fixture = (resolution = 1, count = 4) => {
  let clock = 0;
  let allocated = 0;
  let enforceLimit = false;
  const resources: Resource[] = [];
  const shown = new Map<number, Resource>();
  const allocations: { bytes: number; limit: number }[] = [];
  const controls = {
    fail: false,
    ready: true,
    finish: () => undefined as void,
    cost: 0,
    leak: false,
  };
  const resource = (density: number): Resource => {
    const bytes = rockTextureBytes(size, density);
    allocated += bytes;
    if (enforceLimit) {
      allocations.push({ bytes: allocated, limit: queue.limitBytes });
      if (!controls.leak) expect(allocated).toBeLessThanOrEqual(queue.limitBytes);
    }
    const result: Resource = {
      density,
      bytes,
      alive: true,
      destroy: () => {
        if (controls.leak) return;
        expect(result.alive).toBe(true);
        result.alive = false;
        allocated -= bytes;
      },
    };
    resources.push(result);
    return result;
  };
  let preparations = 0;
  let cancellations = 0;
  const queue = new RockBakeQueue<Resource>(
    (_cell, density) => {
      preparations += 1;
      let dead = false;
      return {
        advance: () => controls.ready,
        finish: () => {
          clock += controls.cost;
          if (controls.fail) throw new Error('allocation');
          const result = resource(density);
          controls.finish();
          return result;
        },
        destroy: () => {
          expect(dead).toBe(false);
          dead = true;
          cancellations += 1;
        },
      };
    },
    () => clock,
  );
  for (let id = 0; id < count; id += 1) {
    const base = resource(resolution);
    shown.set(id, base);
    queue.add({
      ...size,
      id,
      bounds: { minX: id * 40, maxX: id * 40 + 20, minY: 0, maxY: 40 },
      base,
      install: (next) => {
        expect(shown.get(id)?.alive).toBe(true);
        expect(next.alive).toBe(true);
        shown.set(id, next);
      },
    });
  }
  queue.update(view(resolution));
  enforceLimit = true;
  const live = (): void => {
    for (const next of shown.values()) expect(next.alive).toBe(true);
    expect(allocated).toBe(queue.actualBytes);
    expect(allocated).toBeLessThanOrEqual(queue.limitBytes);
  };
  const drain = (): void => {
    for (let frame = 0; frame < 1000 && queue.remaining > 0; frame += 1) {
      queue.step(8);
      live();
    }
    expect(queue.remaining).toBe(0);
  };
  return {
    queue,
    controls,
    resources,
    shown,
    allocations,
    drain,
    live,
    get allocated() {
      return allocated;
    },
    get preparations() {
      return preparations;
    },
    get cancellations() {
      return cancellations;
    },
  };
};

describe('очередь скальных текстур', () => {
  it('отрицательный контроль освобождения обнаруживает накопление выше предела', () => {
    const f = fixture();
    f.controls.leak = true;
    for (let cycle = 0; cycle < 20; cycle += 1) {
      f.queue.update(view(1, 4));
      for (let frame = 0; frame < 5; frame += 1) f.queue.step(8);
      f.queue.update(view(1, 1));
      f.queue.step(8);
    }
    expect(f.allocated).toBeGreaterThan(f.queue.limitBytes);
    expect(f.allocations.some((allocation) => allocation.bytes > allocation.limit)).toBe(true);
    expect(() => f.live()).toThrow();
    f.controls.leak = false;
    f.queue.destroy();
    for (const resource of f.resources) if (resource.alive) resource.destroy();
    expect(f.allocated).toBe(0);
  });
  it('выброс выше 8 мс допускает одну пробу каждый четвёртый свободный кадр и выходит из окна', () => {
    const f = fixture(1, 12);
    f.queue.update({ ...view(), width: 1000, bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 100 } });
    f.controls.cost = 12;
    f.queue.step(8);
    expect(f.queue.completed).toBe(1);
    expect(f.queue.overruns).toBe(1);
    expect(f.queue.estimate(4)).toBe(15);
    f.controls.cost = 1;
    for (let i = 0; i < 10; i += 1) {
      f.queue.step(0);
      f.queue.step(5);
    }
    expect(f.queue.completed).toBe(1);
    for (let probe = 0; probe < 8; probe += 1) {
      const completed = f.queue.completed;
      for (let frame = 0; frame < 3; frame += 1) {
        f.queue.step(6);
        expect(f.queue.completed).toBe(completed);
      }
      f.queue.step(6);
      expect(f.queue.completed).toBe(completed + 1);
      f.live();
    }
    expect(f.queue.probes).toBe(8);
    expect(f.queue.estimate(4)).toBe(1.25);
    f.drain();
    expect(f.queue.completed).toBe(12);
  });

  it('начальная оценка учитывается, неполная геометрия не выделяет текстуру', () => {
    const f = fixture();
    f.queue.observeInitialBake(10);
    f.controls.ready = false;
    for (let i = 0; i < 10; i += 1) f.queue.step(8);
    expect(f.resources).toHaveLength(4);
    f.controls.ready = true;
    for (let i = 0; i < 3; i += 1) f.queue.step(6);
    expect(f.resources).toHaveLength(4);
    f.queue.step(6);
    expect(f.resources).toHaveLength(5);
  });

  it('объединяет серию pan/zoom и не начинает работу при нулевом бюджете', () => {
    const f = fixture();
    for (let i = 0; i < 100; i += 1) f.queue.update(view(1, i % 2 ? 2 : 4, i % 2 ? 120 : 0));
    f.queue.step(0);
    expect(f.preparations).toBe(0);
    expect(f.queue.cells.size).toBe(4);
    f.drain();
    for (const cell of f.queue.cells.values())
      expect((cell.detail ?? cell.base).density).toBe(f.queue.target(cell));
    const completed = f.queue.completed;
    f.queue.step(8);
    expect(f.queue.completed).toBe(completed);
  });

  it('возвращает ту же живую базу, не хранит историю посещений', () => {
    const f = fixture();
    const bases = [...f.queue.cells.values()].map((cell) => cell.base);
    f.drain();
    expect(f.resources.length).toBeGreaterThan(bases.length);
    for (const x of [120, 0, 120, 0, 500]) {
      f.queue.update(view(1, 4, x));
      f.drain();
    }
    expect(f.allocated).toBe(bases.reduce((sum, base) => sum + base.bytes, 0));
    for (const [id, base] of bases.entries()) {
      expect(base.alive).toBe(true);
      expect(f.shown.get(id)).toBe(base);
    }
  });

  it('ошибка сохраняет изображение и повторяется только в следующем кадре', () => {
    const f = fixture();
    f.controls.fail = true;
    f.queue.step(8);
    expect(f.queue.failures).toBe(1);
    expect(f.preparations).toBe(1);
    f.live();
    f.controls.fail = false;
    f.drain();
  });

  it('не устанавливает результат, устаревший во время операции', () => {
    const f = fixture();
    f.controls.finish = () => f.queue.update(view(1, 1, 500));
    f.queue.step(8);
    expect(f.queue.completed).toBe(0);
    expect(f.resources.at(-1)?.alive).toBe(false);
    f.live();
  });

  it.each([
    [1, 3],
    [3, 1],
  ])('мигрирует базы %s → %s без исчезновения и с проверкой каждого выделения', (before, after) => {
    const f = fixture(before);
    f.drain();
    const bases = [...f.queue.cells.values()].map((cell) => cell.base);
    f.queue.update(view(after));
    let observedMixed = false;
    while ([...f.queue.cells.values()].some((cell) => cell.base.density !== after)) {
      f.queue.step(8);
      f.live();
      const cells = [...f.queue.cells.values()];
      if (
        cells.some((cell) => cell.base.density === before) &&
        cells.some((cell) => cell.base.density === after)
      ) {
        observedMixed = true;
        expect(cells.every((cell) => !cell.detail)).toBe(true);
      }
    }
    expect(observedMixed).toBe(true);
    for (const base of bases) expect(base.alive).toBe(false);
    expect(f.queue.limitBytes).toBe(f.queue.newLimitBytes);
    f.drain();
    expect(f.allocations.length).toBeGreaterThan(4);
  });

  it('resize сохраняет базы; повторный resolution отменяет незавершённую подготовку', () => {
    const f = fixture();
    f.drain();
    const base = f.queue.cells.get(0)!.base;
    f.queue.update({ ...view(), width: 50, height: 50 });
    f.drain();
    expect(f.queue.cells.get(0)!.base).toBe(base);
    f.queue.update(view(3));
    f.queue.step(8);
    f.controls.ready = false;
    f.queue.step(8);
    const before = f.cancellations;
    f.queue.update(view(2));
    expect(f.cancellations).toBe(before + 1);
    f.controls.ready = true;
    f.drain();
    for (const cell of f.queue.cells.values()) expect(cell.base.density).toBe(2);
    expect(f.queue.limitBytes).toBe(f.queue.newLimitBytes);
  });

  it('смена pan не перезапускает незавершённую миграцию базы', () => {
    const f = fixture();
    f.queue.update(view(3));
    f.controls.ready = false;
    f.queue.step(8);
    f.queue.update(view(3, 2, 120));
    expect(f.cancellations).toBe(0);
    f.controls.ready = true;
    f.drain();
  });

  it('destroy освобождает базы, подробности и подготовку и безопасен повторно', () => {
    const f = fixture();
    f.queue.step(8);
    f.controls.ready = false;
    f.queue.step(8);
    f.queue.destroy();
    f.queue.destroy();
    expect(f.allocated).toBe(0);
    expect(f.resources.every((r) => !r.alive)).toBe(true);
    expect(f.queue.cells.size).toBe(0);
  });

  it('destroy во время завершения освобождает и поздний результат', () => {
    const f = fixture();
    f.controls.finish = () => f.queue.destroy();
    f.queue.step(8);
    expect(f.allocated).toBe(0);
    expect(f.resources.every((r) => !r.alive)).toBe(true);
  });
});
