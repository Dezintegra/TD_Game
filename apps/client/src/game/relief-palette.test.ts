import { describe, expect, it } from 'vitest';
import { SKY_STRENGTH, TONE_BASE, TONE_RANGE, WARM_BOOST } from './relief-render.js';

/**
 * Приглушённость камня.
 *
 * Требование `rock-appearance` звучит так: разброс цвета породы остаётся
 * низкой насыщенности и не ярче середины шкалы, и именно это — а не
 * запрет на какой-то оттенок — отделяет камень от цветов сторон.
 *
 * Проверять надо весь размах, а не одну точку палитры: цвет складывается
 * из четырёх слагаемых, и каждое двигает его вверх.
 */

/** Значения из `tokens.css`. Здесь они нужны числами: CSS в тестах нет. */
const ROCK = [0x82 / 255, 0x79 / 255, 0x6d / 255] as const;
const SKY = [0x5c / 255, 0x7e / 255, 0xa8 / 255] as const;

/** Цвета сторон оттуда же. */
const SELF = [0x00 / 255, 0xff / 255, 0x29 / 255] as const;
const ENEMY = [0xd2 / 255, 0x64 / 255, 0xff / 255] as const;

interface Hsv {
  readonly saturation: number;
  readonly value: number;
}

const hsv = (colour: readonly number[]): Hsv => {
  const [r = 0, g = 0, b = 0] = colour;
  const high = Math.max(r, g, b);
  const low = Math.min(r, g, b);

  return { saturation: high === 0 ? 0 : (high - low) / high, value: high };
};

/**
 * Самый яркий и самый насыщенный цвет, какой шейдер может выдать.
 *
 * Складывается ровно так же, как в шейдере: порода, тёплая добавка
 * на свету, множитель неоднородности и свет неба сверху. Все четыре
 * берутся в своём максимуме одновременно — на поверхности так не
 * совпадёт никогда, значит проверка строже действительности.
 */
const brightest = (): number[] =>
  ROCK.map((channel, index) => {
    const warmed = channel + (WARM_BOOST[index] ?? 0);
    const toned = warmed * (TONE_BASE + TONE_RANGE);
    return toned + (SKY[index] ?? 0) * SKY_STRENGTH;
  });

describe('камень остаётся приглушённым', () => {
  it('не насыщеннее и не ярче трети шкалы', () => {
    const extreme = hsv(brightest());

    expect(extreme.saturation).toBeLessThan(0.35);
    expect(extreme.value).toBeLessThan(0.65);
  });

  it('заметно тусклее любой из сторон', () => {
    // Стороны опознаются полной яркостью, камень — приглушённостью.
    // Это и есть настоящее различие; оттенок тут ни при чём.
    const extreme = hsv(brightest());

    for (const side of [SELF, ENEMY]) {
      const theirs = hsv(side);
      expect(extreme.value).toBeLessThan(theirs.value - 0.2);
      expect(extreme.saturation).toBeLessThan(theirs.saturation - 0.2);
    }
  });

  it('зеленоватый оттенок сам по себе не запрещён', () => {
    // Ограничение стоит на приглушённости, а не на тоне: приглушённая
    // олива и неон `#00ff29` не путаются ничем.
    const lichen = [0x5d / 255, 0x64 / 255, 0x4e / 255];
    const theirs = hsv(SELF);

    expect(hsv(lichen).value).toBeLessThan(theirs.value - 0.2);
    expect(hsv(lichen).saturation).toBeLessThan(theirs.saturation - 0.2);
  });

  it('свет неба остаётся поправкой, а не вторым солнцем', () => {
    // Заметно больше — и массив теряет объём: разница между обращённым
    // к источнику и отвёрнутым от него смазывается.
    expect(SKY_STRENGTH).toBeLessThan(0.25);
    expect(SKY_STRENGTH).toBeGreaterThan(0.05);
  });
});
