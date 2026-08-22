import { describe, expect, it } from 'vitest';
import { noiseFrom } from '../game/noise.js';
import {
  attackAt,
  createFilter,
  createOnePole,
  decayAt,
  decayTo,
  fadeEnds,
  normalise,
  peakOf,
  rms,
  softClip,
  sweepAt,
  zeroCrossings,
} from './dsp.js';

const SAMPLE_RATE = 48000;

/** Синус известной частоты — эталон, на котором проверяются измерители. */
const sine = (frequency: number, seconds: number): Float32Array => {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE);
  }
  return samples;
};

describe('развёртка частоты', () => {
  it('идёт от начальной к конечной', () => {
    expect(sweepAt(1800, 320, 0)).toBeCloseTo(1800, 3);
    expect(sweepAt(1800, 320, 1)).toBeCloseTo(320, 3);
  });

  it('в середине пути даёт среднее геометрическое, а не арифметическое', () => {
    // Ровно в этом смысл экспоненты: слух воспринимает высоту
    // логарифмически, и середина пути от 1800 к 320 для него — 759 Гц,
    // а не 1060.
    expect(sweepAt(1800, 320, 0.5)).toBeCloseTo(Math.sqrt(1800 * 320), 3);
  });

  it('за пределами отрезка держит полку', () => {
    expect(sweepAt(1800, 320, -5)).toBeCloseTo(1800, 3);
    expect(sweepAt(1800, 320, 5)).toBeCloseTo(320, 3);
  });

  it('не выдаёт ноль и не выдаёт бесконечность при нулевой границе', () => {
    for (const phase of [0, 0.25, 0.5, 0.75, 1]) {
      const value = sweepAt(0, 0, phase);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});

describe('огибающие', () => {
  it('нарастание доходит до единицы ровно к концу отрезка', () => {
    expect(attackAt(0, 0.01)).toBe(0);
    expect(attackAt(0.005, 0.01)).toBeCloseTo(0.5, 6);
    expect(attackAt(0.01, 0.01)).toBe(1);
    expect(attackAt(1, 0.01)).toBe(1);
  });

  it('нулевое нарастание не делит на ноль', () => {
    expect(attackAt(0, 0)).toBe(1);
  });

  it('затухание монотонно убывает', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let step = 0; step <= 100; step += 1) {
      const value = decayAt(step / 100, 0.2);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it('затухание с гарантированным нулём начинается единицей и кончается нулём', () => {
    expect(decayTo(0, 0.5, 0.2)).toBeCloseTo(1, 6);
    expect(decayTo(0.5, 0.5, 0.2)).toBe(0);
    expect(decayTo(0.6, 0.5, 0.2)).toBe(0);
  });

  it('затухание с гарантированным нулём тоже монотонно', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let step = 0; step <= 100; step += 1) {
      const value = decayTo((step / 100) * 0.5, 0.5, 0.2);
      expect(value).toBeLessThanOrEqual(previous + 1e-9);
      previous = value;
    }
  });
});

describe('фильтр состояния переменных', () => {
  // Главное свойство фильтра с бегущим срезом — устойчивость. Разойдись
  // он однажды, в динамики уехал бы щелчок на полной громкости, и поймать
  // это в браузере пришлось бы ушами.
  it('не расходится и не даёт NaN на трёх секундах шума с бегущим срезом', () => {
    // Утверждение вынесено за цикл намеренно: `expect` внутри миллиона
    // итераций превращает секундный тест в двадцатисекундный, а ловит
    // ровно то же самое.
    for (const mode of ['low', 'band', 'high'] as const) {
      const filter = createFilter(SAMPLE_RATE, mode);
      const noise = noiseFrom(0x51ee7);
      const total = SAMPLE_RATE * 3;

      let peak = 0;
      let broken = 0;

      for (let index = 0; index < total; index += 1) {
        const phase = index / total;
        // Срез гуляет по всему слышимому диапазону, добротность —
        // от предельно тупой до предельно острой.
        const output = filter(noise(), sweepAt(20, 20000, phase), 0.5 + phase * 12);

        if (!Number.isFinite(output)) broken += 1;
        const magnitude = Math.abs(output);
        if (magnitude > peak) peak = magnitude;
      }

      expect(broken).toBe(0);
      expect(peak).toBeLessThan(20);
    }
  });

  it('низкочастотный режим гасит верх, а верхнечастотный — низ', () => {
    const low = createFilter(SAMPLE_RATE, 'low');
    const high = createFilter(SAMPLE_RATE, 'high');

    const loud = sine(200, 0.2);
    const quiet = sine(6000, 0.2);

    const throughLow = (input: Float32Array, filter: (value: number, hz: number, q: number) => number) => {
      const output = new Float32Array(input.length);
      for (let index = 0; index < input.length; index += 1) {
        output[index] = filter(input[index] ?? 0, 800, 0.7);
      }
      // Первые миллисекунды — переходный процесс фильтра, он к делу
      // не относится.
      return rms(output, SAMPLE_RATE / 50);
    };

    expect(throughLow(loud, low)).toBeGreaterThan(throughLow(quiet, low));
    expect(throughLow(quiet, high)).toBeGreaterThan(throughLow(loud, high));
  });

  it('нулевая и запредельная частота среза не ломают фильтр', () => {
    const filter = createFilter(SAMPLE_RATE, 'low');
    let broken = 0;

    for (const cutoff of [-100, 0, SAMPLE_RATE, SAMPLE_RATE * 10]) {
      for (let index = 0; index < 1000; index += 1) {
        if (!Number.isFinite(filter(1, cutoff, 1))) broken += 1;
      }
    }

    expect(broken).toBe(0);
  });
});

describe('однополюсный фильтр', () => {
  it('на постоянном входе сходится ко входу', () => {
    const filter = createOnePole(SAMPLE_RATE);
    let value = 0;
    for (let index = 0; index < SAMPLE_RATE; index += 1) value = filter(0.5, 200);
    expect(value).toBeCloseTo(0.5, 4);
  });

  it('чем ниже срез, тем сильнее сглаживание', () => {
    const gentle = createOnePole(SAMPLE_RATE);
    const sharp = createOnePole(SAMPLE_RATE);
    const noise = noiseFrom(0x1234);

    let gentleSum = 0;
    let sharpSum = 0;
    for (let index = 0; index < 20000; index += 1) {
      const input = noise();
      gentleSum += Math.abs(gentle(input, 100));
      sharpSum += Math.abs(sharp(input, 10000));
    }

    expect(gentleSum).toBeLessThan(sharpSum);
  });
});

describe('обработка готового массива', () => {
  it('мягкое ограничение не выпускает за единицу', () => {
    for (const value of [-1000, -3, -1, 0, 0.5, 1, 3, 1000]) {
      expect(Math.abs(softClip(value))).toBeLessThanOrEqual(1);
    }
  });

  it('мягкое ограничение почти не трогает тихое', () => {
    expect(softClip(0.05)).toBeCloseTo(0.05, 3);
  });

  it('мягкое ограничение почти совпадает с настоящим тангенсом', () => {
    // Приближение заведено ради скорости, и расхождение с образцом
    // обязано оставаться неслышимым.
    for (let value = -3; value <= 3; value += 0.05) {
      expect(softClip(value)).toBeCloseTo(Math.tanh(value), 2);
    }
  });

  it('нормировка даёт ровно заданный пик', () => {
    const samples = Float32Array.from([0.1, -0.4, 0.2]);
    normalise(samples, 0.8);
    expect(peakOf(samples)).toBeCloseTo(0.8, 6);
  });

  it('нормировка тишины не делит на ноль', () => {
    const samples = new Float32Array(16);
    normalise(samples, 0.8);
    expect(peakOf(samples)).toBe(0);
  });

  it('обнуление краёв даёт ноль на обоих концах', () => {
    const samples = new Float32Array(SAMPLE_RATE).fill(0.7);
    fadeEnds(samples, SAMPLE_RATE);

    expect(samples[0]).toBe(0);
    expect(samples[samples.length - 1]).toBe(0);
    // Середина не тронута: скат короткий.
    expect(samples[Math.floor(samples.length / 2)]).toBeCloseTo(0.7, 6);
  });

  it('обнуление краёв не портит короткие массивы', () => {
    const samples = Float32Array.from([1, 1, 1]);
    fadeEnds(samples, SAMPLE_RATE);
    expect(samples[0]).toBe(0);
    expect(samples[2]).toBe(0);
  });
});

describe('измерители', () => {
  it('счётчик переходов через ноль даёт удвоенную частоту', () => {
    // Синус пересекает ноль дважды за период.
    const crossings = zeroCrossings(sine(1000, 1));
    expect(crossings).toBeGreaterThanOrEqual(1999);
    expect(crossings).toBeLessThanOrEqual(2001);
  });

  it('счётчик переходов растёт вместе с частотой', () => {
    expect(zeroCrossings(sine(2000, 0.5))).toBeGreaterThan(zeroCrossings(sine(400, 0.5)));
  });

  it('среднеквадратичное синуса — единица делённая на корень из двух', () => {
    expect(rms(sine(500, 0.5))).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('среднеквадратичное пустого отрезка — ноль, а не деление на ноль', () => {
    expect(rms(new Float32Array(0))).toBe(0);
    expect(rms(sine(500, 0.1), 100, 100)).toBe(0);
  });
});
