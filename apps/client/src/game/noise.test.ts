import { describe, expect, it } from 'vitest';
import { hash3, hashOf, noiseFrom } from './noise.js';

/**
 * Две версии одного хеша обязаны совпадать.
 *
 * `hash3` заведён ради скорости: решётчатый шум рельефа спрашивает хеш
 * узла порядка тридцати пяти миллионов раз на карту, и массив на каждый
 * вызов стоил дороже самого счёта. Но рельеф выводится из этого числа
 * целиком, поэтому расхождение версий означало бы другую карту —
 * молча и во всей игре сразу.
 */
describe('хеш координат', () => {
  it('от трёх чисел совпадает с хешем массива', () => {
    // Границы взяты не наугад: узлы решётки бывают отрицательными
    // (шум спрашивают и за краем карты), а зерно бывает большим.
    const values = [-1000, -7, -1, 0, 1, 2, 41, 4096, 0x7fff_ffff, -0x8000_0000];

    for (const a of values) {
      for (const b of values) {
        for (const seed of [0, 3, 11, 71, 0x1234_5678]) {
          expect(hash3(a, b, seed)).toBe(hashOf([a, b, seed]));
        }
      }
    }
  });

  it('различает порядок чисел', () => {
    // Иначе узел (3, 5) и узел (5, 3) получили бы одну высоту, и гряда
    // вышла бы симметричной относительно диагонали.
    expect(hash3(3, 5, 0)).not.toBe(hash3(5, 3, 0));
  });

  it('меняется от зерна', () => {
    expect(hash3(3, 5, 0)).not.toBe(hash3(3, 5, 1));
  });
});

describe('поток чисел', () => {
  it('повторяется от одного зерна', () => {
    const first = noiseFrom(42);
    const second = noiseFrom(42);

    for (let index = 0; index < 32; index += 1) {
      expect(first()).toBe(second());
    }
  });

  it('держится в границах [-1, 1)', () => {
    const stream = noiseFrom(1);

    for (let index = 0; index < 4096; index += 1) {
      const value = stream();
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThan(1);
    }
  });
});
