import { describe, expect, it } from 'vitest';
import {
  CONCRETE_SLOPE_SCALE,
  CONCRETE_TILE_CELLS,
  SEAM_PITCH_ACROSS,
  SEAM_PITCH_ALONG,
  buildConcreteTile,
  concreteOffset,
  concreteSlope,
  decodeConcreteSlope,
  encodeConcreteSlope,
  seamSlope,
} from './concrete.js';
import { grainOffset } from './relief.js';

/**
 * Бетон проверяется тем же набором, что и порода: замощение, укладка
 * уклона в байт, отсутствие вырождения. Своя проверка здесь одна,
 * и она про отличие от камня — общий приём не должен превратиться
 * в общий рисунок.
 */

describe('фактура бетона замыкается на себя', () => {
  it('повторяется через сторону плитки', () => {
    for (let index = 0; index < 30; index += 1) {
      const u = index * 0.19;
      const v = index * 0.37;
      const here = concreteOffset(u, v);

      expect(concreteOffset(u + CONCRETE_TILE_CELLS, v)).toBeCloseTo(here, 12);
      expect(concreteOffset(u, v + CONCRETE_TILE_CELLS)).toBeCloseTo(here, 12);
      expect(concreteOffset(u + CONCRETE_TILE_CELLS, v + CONCRETE_TILE_CELLS)).toBeCloseTo(
        here,
        12,
      );
    }
  });

  it('уклон тоже повторяется', () => {
    const here = concreteSlope(0.71, 1.33);
    const wrapped = concreteSlope(0.71 + CONCRETE_TILE_CELLS, 1.33);

    expect(wrapped.du).toBeCloseTo(here.du, 10);
    expect(wrapped.dv).toBeCloseTo(here.dv, 10);
  });

  it('не выродилась в постоянную', () => {
    const values = new Set<number>();
    for (let index = 0; index < 50; index += 1) {
      values.add(Math.round(concreteOffset(index * 0.13, index * 0.29) * 1e6));
    }

    expect(values.size).toBeGreaterThan(40);
  });

  it('рисунок не совпадает с породой', () => {
    // Общий приём — не общие числа. Бетон, повторяющий рисунок камня,
    // означал бы, что два материала на поле выглядят одинаково.
    let same = 0;
    for (let index = 0; index < 60; index += 1) {
      const u = index * 0.11;
      const v = index * 0.23;
      if (Math.abs(concreteOffset(u, v) - grainOffset(u, v)) < 0.002) same += 1;
    }

    expect(same).toBeLessThan(6);
  });

  it('мельче породы по размаху', () => {
    // Бетон гладок в сравнении с камнем: у стены не должно быть скатов.
    let concrete = 0;
    let stone = 0;
    for (let index = 0; index < 80; index += 1) {
      const u = index * 0.07;
      const v = index * 0.17;
      concrete = Math.max(concrete, Math.abs(concreteOffset(u, v)));
      stone = Math.max(stone, Math.abs(grainOffset(u, v)));
    }

    expect(concrete).toBeLessThan(stone);
  });
});

describe('швы опалубки', () => {
  it('идут с заявленным шагом', () => {
    // Через период уклон повторяется: шов на стене — рисунок правильный,
    // и в этом его отличие от шума.
    const here = seamSlope(0.21, 0.09);
    const next = seamSlope(0.21 + SEAM_PITCH_ALONG, 0.09 + SEAM_PITCH_ACROSS);

    expect(next.du).toBeCloseTo(here.du, 10);
    expect(next.dv).toBeCloseTo(here.dv, 10);
  });

  it('в дне канавки уклона нет, а по бокам он разного знака', () => {
    // Середина шва — самая глубокая точка, и поверхность в ней снова
    // горизонтальна. Ошибка здесь выглядит как шов, освещённый с одной
    // стороны и чёрный с другой.
    const seam = SEAM_PITCH_ALONG * 0.5;

    expect(seamSlope(seam, 0).du).toBeCloseTo(0, 6);
    expect(seamSlope(seam - 0.015, 0).du).toBeLessThan(0);
    expect(seamSlope(seam + 0.015, 0).du).toBeGreaterThan(0);
  });

  it('между швами поверхность ровная', () => {
    // Иначе это не швы, а рябь по всей стене.
    const between = SEAM_PITCH_ALONG * 0.5 + SEAM_PITCH_ALONG * 0.4;

    expect(Math.abs(seamSlope(between, 0).du)).toBeLessThan(0.01);
  });

  it('уклон шва остаётся в пределах шкалы плитки', () => {
    let peak = 0;
    for (let index = 0; index < 400; index += 1) {
      peak = Math.max(peak, Math.abs(seamSlope(index * 0.004, 0).du));
    }

    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThan(CONCRETE_SLOPE_SCALE);
  });
});

describe('укладка уклона в байт', () => {
  it('ноль ложится в середину шкалы', () => {
    expect(encodeConcreteSlope(0)).toBe(128);
  });

  it('туда и обратно с точностью шкалы', () => {
    for (const slope of [-1.5, -0.4, 0, 0.4, 1.5]) {
      expect(decodeConcreteSlope(encodeConcreteSlope(slope))).toBeCloseTo(slope, 1);
    }
  });

  it('края шкалы не переполняются', () => {
    expect(encodeConcreteSlope(CONCRETE_SLOPE_SCALE)).toBe(255);
    expect(encodeConcreteSlope(-CONCRETE_SLOPE_SCALE)).toBe(0);
  });
});

describe('плитка бетона', () => {
  // Мелкая: полноразмерная считается заметное время, а проверяем мы
  // устройство, а не производительность.
  const tile = buildConcreteTile(64);

  it('размер и число каналов совпадают с заявленными', () => {
    expect(tile.size).toBe(64);
    expect(tile.cells).toBe(CONCRETE_TILE_CELLS);
    expect(tile.pixels.length).toBe(64 * 64 * 4);
  });

  it('в плитке лежит уклон, а не яркость', () => {
    const perPixel = CONCRETE_TILE_CELLS / 64;
    const column = 19;
    const row = 27;
    const expected =
      (concreteOffset((column + 1) * perPixel, row * perPixel) -
        concreteOffset((column - 1) * perPixel, row * perPixel)) /
      (2 * perPixel);
    const offset = (row * 64 + column) * 4;

    expect(decodeConcreteSlope(tile.pixels[offset] ?? 0)).toBeCloseTo(expected, 1);
  });

  it('шкала подобрана так, что обрезание — редкость', () => {
    let clipped = 0;
    for (let index = 0; index < tile.pixels.length; index += 4) {
      const du = tile.pixels[index] ?? 0;
      const dv = tile.pixels[index + 1] ?? 0;
      if (du === 0 || du === 255 || dv === 0 || dv === 255) clipped += 1;
    }

    expect(clipped / (64 * 64)).toBeLessThan(0.01);
  });

  it('противоположные края плитки сходятся', () => {
    const perPixel = CONCRETE_TILE_CELLS / 64;
    const row = 30;
    const expected =
      (concreteOffset(1 * perPixel, row * perPixel) -
        concreteOffset(-1 * perPixel, row * perPixel)) /
      (2 * perPixel);

    expect(decodeConcreteSlope(tile.pixels[(row * 64 + 0) * 4] ?? 0)).toBeCloseTo(expected, 1);
  });

  it('плитка не пустая и не однотонная', () => {
    const seen = new Set<number>();
    for (let index = 0; index < tile.pixels.length; index += 4) seen.add(tile.pixels[index] ?? 0);

    expect(seen.size).toBeGreaterThan(20);
  });
});
