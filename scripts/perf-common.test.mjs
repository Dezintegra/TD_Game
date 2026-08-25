import { describe, expect, it } from 'vitest';
import { TICKS_PER_SECOND } from '../packages/shared/src/constants.ts';
import { WORLD_TICKS_PER_SECOND, busySamples, summariseBusy } from './perf-common.mjs';

/**
 * Проверки счётной части замеров.
 *
 * Всё, что трогает машину, — замок, порты, сам прогон Playwright —
 * здесь не проверяется намеренно: такая проверка занимала бы машину
 * ровно тем, от чего замер и страхует.
 */

describe('ход мира', () => {
  it('совпадает с проектным темпом симуляции', () => {
    // Значение продублировано в `perf-common.mjs`, потому что импортировать
    // туда пакет нельзя: `--history` обязан работать и до сборки. Этот тест
    // и есть замена импорта — разъехаться молча они не смогут.
    expect(WORLD_TICKS_PER_SECOND).toBe(TICKS_PER_SECOND);
  });
});

describe('нагрузка за прогон', () => {
  /**
   * Поддельные счётчики процессора.
   *
   * Каждая доля задаёт, сколько времени за очередной промежуток ушло
   * не на простой. Настоящую нагрузку здесь устраивать нельзя: проверка
   * заняла бы машину ровно тем, от чего замер и страхует.
   */
  const cpuReader = (shares) => {
    let idle = 0;
    let total = 0;
    let index = 0;
    return () => {
      if (index > 0) {
        const share = shares[index - 1] ?? 0;
        total += 1000;
        idle += 1000 * (1 - share);
      }
      index += 1;
      return { idle, total };
    };
  };

  const sampleAll = (shares) => {
    const samples = busySamples(cpuReader(shares));
    for (let index = 0; index < shares.length; index += 1) samples.take();
    return samples.summary();
  };

  it('видит нагрузку, пришедшую в середине прогона', () => {
    // Ровно тот случай, ради которого наблюдение и заводится: замер
    // начался в тишине, а на середине пришла чужая сборка.
    const load = sampleAll([0.1, 0.12, 0.9, 0.95, 0.11, 0.1]);

    expect(load.max).toBeCloseTo(0.95, 2);
    expect(load.median).toBeGreaterThan(0.1);
    expect(load.samples).toBe(6);
  });

  it('отличает всплеск от обстановки', () => {
    // Одна занятая секунда за прогон — это всплеск: максимум высокий,
    // медиана тихая. Если бы решения принимались по максимуму, любой
    // такой прогон объявлялся бы негодным.
    const spike = sampleAll([0.05, 0.05, 0.98, 0.06, 0.05]);
    expect(spike.max).toBeCloseTo(0.98, 2);
    expect(spike.median).toBeLessThan(0.1);

    // А вот это уже обстановка: занята вся минута.
    const steady = sampleAll([0.7, 0.8, 0.75, 0.9, 0.72]);
    expect(steady.median).toBeGreaterThan(0.35);
  });

  it('молчит, когда пробовать было нечего', () => {
    // Ноль на этом месте читался бы как «машина простаивала» —
    // утверждение из воздуха там, где измерения не было вовсе.
    expect(summariseBusy([])).toBeNull();

    const samples = busySamples(() => ({ idle: 5, total: 10 }));
    samples.take();
    samples.take();
    expect(samples.summary()).toBeNull();
  });
});
