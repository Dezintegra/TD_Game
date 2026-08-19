import { describe, expect, it } from 'vitest';
import { createRng, nextRng, nextRngInt } from './prng.js';

describe('детерминированный генератор', () => {
  it('на одном seed выдаёт одну и ту же последовательность', () => {
    const draw = (seed: number): number[] => {
      let state = createRng(seed);
      const values: number[] = [];
      for (let index = 0; index < 1000; index += 1) {
        const [nextState, value] = nextRng(state);
        state = nextState;
        values.push(value);
      }
      return values;
    };

    expect(draw(12345)).toEqual(draw(12345));
  });

  it('на разных seed выдаёт разные последовательности', () => {
    const [, first] = nextRng(createRng(1));
    const [, second] = nextRng(createRng(2));
    expect(first).not.toBe(second);
  });

  it('не застревает на нулевом seed', () => {
    const [, value] = nextRng(createRng(0));
    expect(value).not.toBe(0);
  });

  it('держит значения в заданных границах', () => {
    let state = createRng(777);
    for (let index = 0; index < 500; index += 1) {
      const [nextState, value] = nextRngInt(state, 6);
      state = nextState;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(6);
    }
  });
});
