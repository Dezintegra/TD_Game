import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderLoop } from './loop.js';

/**
 * Цикл отрисовки меряет промежуток между кадрами.
 *
 * Проверяется здесь именно промежуток, а не число кадров в секунду:
 * последнее усредняет, а рывок живёт в хвосте. Один кадр длиной
 * в двести миллисекунд опускает шестьдесят кадров до пятидесяти пяти —
 * то есть в частоту почти не попадает, — а в распределении виден сразу.
 */

/** Ручной `requestAnimationFrame`: кадры подаются по одному, со своим временем. */
const stubFrames = () => {
  const pending: ((now: number) => void)[] = [];

  vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => {
    pending.push(callback);
    return pending.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);

  return {
    /** Выдать один кадр в указанный момент. */
    tick(nowMs: number) {
      const next = pending.shift();
      next?.(nowMs);
    },
  };
};

let frames: ReturnType<typeof stubFrames>;

beforeEach(() => {
  frames = stubFrames();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('цикл отрисовки', () => {
  it('промежутки меряются между соседними кадрами', () => {
    const gaps: number[] = [];
    const loop = createRenderLoop({ onFrame: () => undefined, onFrameGap: (ms) => gaps.push(ms) });

    loop.start();
    frames.tick(1000);
    frames.tick(1016);
    frames.tick(1216);

    // У первого кадра промежутка нет: мерить его не от чего.
    expect(gaps).toStrictEqual([16, 200]);
  });

  it('после остановки отсчёт начинается заново', () => {
    // Иначе первый промежуток после паузы показал бы длительность
    // самой паузы, а не рывок отрисовки, — и хвост распределения
    // заполнился бы тем, чего игрок не видел.
    const gaps: number[] = [];
    const loop = createRenderLoop({ onFrame: () => undefined, onFrameGap: (ms) => gaps.push(ms) });

    loop.start();
    frames.tick(1000);
    frames.tick(1016);
    loop.stop();

    loop.start();
    frames.tick(9000);
    frames.tick(9016);

    expect(gaps).toStrictEqual([16, 16]);
  });

  it('без обработчика промежутков цикл работает по-прежнему', () => {
    let drawn = 0;
    const loop = createRenderLoop({
      onFrame: () => {
        drawn += 1;
      },
    });

    loop.start();
    frames.tick(1000);
    frames.tick(1016);

    expect(drawn).toBe(2);
  });
});
