import { describe, expect, it } from 'vitest';
import {
  PPM_ONE,
  applyPpm,
  combinePpm,
  compoundPpm,
  growPpm,
  linearPpm,
  stepPpm,
} from './percent.js';

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

describe('модели роста множителя', () => {
  it('геометрический шаг — это прежний growPpm', () => {
    // Свойство сторожевое: умолчание всех тридцати четырёх веток —
    // геометрическая модель, и разойдись она с `growPpm`, игра поехала бы
    // иначе от одной правки, не тронувшей ни одного числа баланса.
    let stepped = PPM_ONE;
    let grown = PPM_ONE;

    for (let index = 0; index < 30; index += 1) {
      stepped = stepPpm(stepped, 25, 'geometric');
      grown = growPpm(grown, 25);
    }

    expect(stepped).toBe(grown);
  });

  it('линейный шаг даёт прямую, а не кривую', () => {
    // Двадцать пять процентов от базы за уровень: на десятом уровне
    // величина обязана быть ровно в три с половиной раза больше базовой,
    // а не в девять с лишним, как вышло бы сложным процентом.
    expect(applyPpm(100, linearPpm(25, 10))).toBe(350);
    expect(applyPpm(100, compoundPpm(25, 10))).toBeGreaterThan(900);
  });

  it('линейный шаг совпадает с накоплением по одному', () => {
    let multiplier = PPM_ONE;
    for (let index = 0; index < 7; index += 1) {
      multiplier = stepPpm(multiplier, 40, 'linear');
    }

    expect(multiplier).toBe(linearPpm(40, 7));
  });

  it('ноль процентов не двигает множителя ни в одной модели', () => {
    // Плоская цена уровня — законный предельный случай перебора,
    // и обе модели обязаны выражать его одинаково.
    expect(stepPpm(PPM_ONE, 0, 'linear')).toBe(PPM_ONE);
    expect(stepPpm(PPM_ONE, 0, 'geometric')).toBe(PPM_ONE);
  });

  it('при равном проценте прямая совпадает с кривой на первом уровне и отстаёт дальше', () => {
    // Выбор модели — это не «какая круче»: при одном и том же проценте
    // сложный процент не бывает ниже прямой никогда. Смысл прямой в том,
    // что она позволяет назвать процент ВТРОЕ больший, не получив
    // к двадцатому уровню величину, которой в игре нет места.
    expect(applyPpm(100, linearPpm(20, 1))).toBe(applyPpm(100, compoundPpm(20, 1)));
    expect(applyPpm(100, linearPpm(20, 5))).toBeLessThan(applyPpm(100, compoundPpm(20, 5)));
    expect(applyPpm(100, linearPpm(60, 5))).toBeGreaterThan(applyPpm(100, compoundPpm(20, 5)));
  });
});
