import { describe, expect, it } from 'vitest';
import {
  GRAIN_SLOPE_SCALE,
  buildGrainTile,
  decodeSlope,
  encodeSlope,
} from './grain.js';
import { GRAIN_TILE_CELLS, grainOffset, grainSlope, valueNoise } from './relief.js';

// `grainSlope` остаётся в проверках как образец: плитка обязана идти
// за ним по знаку, пусть и грубее по числу.

describe('фактура замыкается на себя', () => {
  it('шум с периодом повторяется через период', () => {
    for (let index = 0; index < 40; index += 1) {
      const x = index * 0.31;
      const y = index * 0.17;

      expect(valueNoise(x + 8, y, 5, 8)).toBeCloseTo(valueNoise(x, y, 5, 8), 12);
      expect(valueNoise(x, y + 8, 5, 8)).toBeCloseTo(valueNoise(x, y, 5, 8), 12);
    }
  });

  it('шум без периода не повторяется', () => {
    // Иначе предыдущая проверка проходила бы и на сломанном замыкании.
    expect(valueNoise(3.5, 2.5, 5)).not.toBeCloseTo(valueNoise(11.5, 2.5, 5), 6);
  });

  it('фактура повторяется через сторону плитки', () => {
    // Без этого плитка не сойдётся, и по карте пойдёт сетка швов.
    for (let index = 0; index < 30; index += 1) {
      const u = index * 0.23;
      const v = index * 0.41;
      const here = grainOffset(u, v);

      expect(grainOffset(u + GRAIN_TILE_CELLS, v)).toBeCloseTo(here, 12);
      expect(grainOffset(u, v + GRAIN_TILE_CELLS)).toBeCloseTo(here, 12);
      expect(grainOffset(u + GRAIN_TILE_CELLS, v + GRAIN_TILE_CELLS)).toBeCloseTo(here, 12);
    }
  });

  it('уклон фактуры тоже повторяется', () => {
    const here = grainSlope(1.37, 2.11);
    const wrapped = grainSlope(1.37 + GRAIN_TILE_CELLS, 2.11);

    expect(wrapped.du).toBeCloseTo(here.du, 10);
    expect(wrapped.dv).toBeCloseTo(here.dv, 10);
  });

  it('фактура не выродилась в постоянную', () => {
    // Замыкание легко сделать так, что шум станет одинаковым везде.
    const values = new Set<number>();
    for (let index = 0; index < 50; index += 1) {
      values.add(Math.round(grainOffset(index * 0.19, index * 0.07) * 1e6));
    }

    expect(values.size).toBeGreaterThan(40);
  });
});

describe('укладка уклона в байт', () => {
  it('ноль ложится в середину шкалы', () => {
    expect(encodeSlope(0)).toBe(128);
  });

  it('туда и обратно с точностью шкалы', () => {
    for (const slope of [-2, -0.7, -0.1, 0, 0.1, 0.7, 2]) {
      expect(decodeSlope(encodeSlope(slope))).toBeCloseTo(slope, 1);
    }
  });

  it('края шкалы не переполняются', () => {
    expect(encodeSlope(GRAIN_SLOPE_SCALE)).toBe(255);
    expect(encodeSlope(-GRAIN_SLOPE_SCALE)).toBe(0);
  });
});

describe('плитка', () => {
  // Мелкая: полноразмерная считается секунды, а проверяем мы устройство,
  // а не производительность.
  const tile = buildGrainTile(64);

  it('размер и число каналов совпадают с заявленными', () => {
    expect(tile.size).toBe(64);
    expect(tile.cells).toBe(GRAIN_TILE_CELLS);
    expect(tile.pixels.length).toBe(64 * 64 * 4);
  });

  it('в плитке лежит уклон, а не яркость', () => {
    // Сверяем с разностью, взятой на шаге самой плитки, а не с `grainSlope`:
    // тот берёт разность на своём мелком шаге, и на грубой плитке числа
    // законно расходятся. Проверяем устройство, а не совпадение шагов.
    const perPixel = GRAIN_TILE_CELLS / 64;
    const column = 21;
    const row = 13;
    const expected =
      (grainOffset((column + 1) * perPixel, row * perPixel) -
        grainOffset((column - 1) * perPixel, row * perPixel)) /
      (2 * perPixel);
    const offset = (row * 64 + column) * 4;

    expect(decodeSlope(tile.pixels[offset] ?? 0)).toBeCloseTo(expected, 1);
  });

  it('уклон плитки идёт следом за уклоном фактуры', () => {
    // Грубее по числу, но по знаку и порядку обязан совпадать: если
    // в текстуру попадёт само значение фактуры вместо уклона, здесь
    // это и обнаружится.
    const perPixel = GRAIN_TILE_CELLS / 64;
    let agree = 0;
    let counted = 0;

    for (let row = 4; row < 60; row += 7) {
      for (let column = 4; column < 60; column += 7) {
        const exact = grainSlope(column * perPixel, row * perPixel).du;
        const stored = decodeSlope(tile.pixels[(row * 64 + column) * 4] ?? 0);
        if (Math.abs(exact) < 0.05) continue;

        counted += 1;
        if (Math.sign(exact) === Math.sign(stored)) agree += 1;
      }
    }

    expect(counted).toBeGreaterThan(10);
    expect(agree / counted).toBeGreaterThan(0.8);
  });

  it('шкала подобрана так, что обрезание — редкость', () => {
    // Если фактуру усилят, тест упадёт раньше, чем обрезание станет
    // видно на картинке.
    let clipped = 0;
    for (let index = 0; index < tile.pixels.length; index += 4) {
      const du = tile.pixels[index] ?? 0;
      const dv = tile.pixels[index + 1] ?? 0;
      if (du === 0 || du === 255 || dv === 0 || dv === 255) clipped += 1;
    }

    expect(clipped / (64 * 64)).toBeLessThan(0.01);
  });

  it('плитка не пустая и не однотонная', () => {
    const seen = new Set<number>();
    for (let index = 0; index < tile.pixels.length; index += 4) seen.add(tile.pixels[index] ?? 0);

    expect(seen.size).toBeGreaterThan(20);
  });

  it('противоположные края плитки сходятся', () => {
    // Главная проверка замощения. Разность на нулевом столбце обязана
    // брать значение с последнего, а не упираться в край: иначе по шву
    // пойдёт полоса неверного уклона.
    const perPixel = GRAIN_TILE_CELLS / 64;
    const row = 30;
    const expected =
      (grainOffset(1 * perPixel, row * perPixel) - grainOffset(-1 * perPixel, row * perPixel)) /
      (2 * perPixel);

    expect(decodeSlope(tile.pixels[(row * 64 + 0) * 4] ?? 0)).toBeCloseTo(expected, 1);
  });
});
