import { describe, expect, it } from 'vitest';
import { MS_PER_TICK } from '@td/shared';
import { createFrameClock } from './clock.js';

/**
 * Часы кадра проверяются подставленным временем, а не настоящим.
 *
 * Иначе тест мерил бы скорость машины: на быстрой два вызова подряд дают
 * одинаковое `performance.now()`, на медленной — разное, и «доля выросла»
 * то проходит, то нет.
 */

describe('часы кадра', () => {
  it('на смене тика начинают отсчёт заново', () => {
    const clock = createFrameClock();

    expect(clock.sample(10, 1000)).toBe(10);
    expect(clock.sample(11, 1500)).toBe(11);
  });

  it('внутри тика доля растёт', () => {
    const clock = createFrameClock();
    clock.sample(10, 1000);

    const early = clock.sample(10, 1000 + MS_PER_TICK * 0.25);
    const late = clock.sample(10, 1000 + MS_PER_TICK * 0.75);

    expect(early).toBeGreaterThan(10);
    expect(late).toBeGreaterThan(early);
    expect(late).toBeLessThan(11);
  });

  it('долгий кадр не переваливает через тик', () => {
    const clock = createFrameClock();
    clock.sample(10, 1000);

    // Полсекунды на кадр — обычное дело при возвращении в скрытую вкладку.
    expect(clock.sample(10, 1500)).toBeLessThan(11);
  });

  it('время, ушедшее назад, не двигает картинку назад', () => {
    const clock = createFrameClock();
    clock.sample(10, 1000);

    expect(clock.sample(10, 900)).toBe(10);
  });

  it('откат предсказания начинает отсчёт заново', () => {
    const clock = createFrameClock();
    clock.sample(10, 1000);
    clock.sample(10, 1000 + MS_PER_TICK * 0.5);

    // Мир на кадре бывает младше, чем на предыдущем: предсказание
    // пересобирается откатом.
    expect(clock.sample(8, 1100)).toBe(8);
  });
});
