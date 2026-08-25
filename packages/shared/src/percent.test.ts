import { describe, expect, it } from 'vitest';
import { PPM_ONE, applyPpm, combinePpm, compoundPpm, growPpm } from './percent.js';

describe('арифметика сложных процентов', () => {
  it('единичный множитель величину не меняет', () => {
    expect(applyPpm(1234, PPM_ONE)).toBe(1234);
  });

  it('множитель растёт, а не сама величина: прогрессия не замирает на малых числах', () => {
    // Наивное `Math.floor(10 * 1,02)` дало бы 10 и застряло навсегда.
    let multiplier = PPM_ONE;
    for (let index = 0; index < 40; index += 1) {
      multiplier = growPpm(multiplier, 2);
    }

    expect(applyPpm(10, multiplier)).toBeGreaterThan(10);
  });
});

describe('перемножение множителей', () => {
  it('единичные множители дают единичный', () => {
    expect(combinePpm(PPM_ONE, PPM_ONE)).toBe(PPM_ONE);
  });

  it('единица не меняет второго множителя', () => {
    const half = PPM_ONE / 2;

    expect(combinePpm(PPM_ONE, half)).toBe(half);
    expect(combinePpm(half, PPM_ONE)).toBe(half);
  });

  it('порядок сомножителей результата не меняет', () => {
    const radius = compoundPpm(5, 7);
    const damage = compoundPpm(10, 3);

    expect(combinePpm(radius, damage)).toBe(combinePpm(damage, radius));
  });

  it('перемножить множители точнее, чем применить их по очереди', () => {
    // Ровно та ошибка, ради которой функция и заведена. Два применения
    // подряд округляют дважды, и на некоторых входах итог зависит
    // от того, какой множитель применён первым, — то есть от порядка
    // строк в коде. Вход ниже именно такой; найден перебором.
    const base = 1000;
    const radius = compoundPpm(5, 1);
    const damage = compoundPpm(10, 5);

    const byOrderOne = applyPpm(applyPpm(base, radius), damage);
    const byOrderTwo = applyPpm(applyPpm(base, damage), radius);
    const combined = applyPpm(base, combinePpm(radius, damage));

    expect(byOrderOne).not.toBe(byOrderTwo);
    // Одно округление вместо двух — значит потеряно не больше, чем
    // в лучшем из двух порядков.
    expect(combined).toBe(Math.max(byOrderOne, byOrderTwo));
  });
});
