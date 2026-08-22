import { describe, expect, it } from 'vitest';
import { peakOf, rms } from './dsp.js';
import {
  closeLoop,
  fadeFrom,
  mixInto,
  normaliseChannels,
  prepareFile,
  resample,
  reverse,
  tile,
  smoothEdges,
  trimLeadingSilence,
} from './prepare.js';
import type { Channels } from './prepare.js';

const SAMPLE_RATE = 48000;

/** Тишина, потом синус: то, как выглядит декодированная запись. */
const withSilence = (silenceSeconds: number, toneSeconds: number, hz = 440): Float32Array => {
  const silence = Math.round(silenceSeconds * SAMPLE_RATE);
  const tone = Math.round(toneSeconds * SAMPLE_RATE);
  const samples = new Float32Array(silence + tone);

  for (let index = 0; index < tone; index += 1) {
    samples[silence + index] = 0.5 * Math.sin((2 * Math.PI * hz * index) / SAMPLE_RATE);
  }

  return samples;
};

const stereo = (mono: Float32Array): Channels => [mono.slice(), mono.slice()];

describe('срезание тишины в начале', () => {
  it('убирает молчание перед звуком', () => {
    const before = withSilence(0.04, 0.2);
    const [after] = trimLeadingSilence([before], SAMPLE_RATE);

    expect(after).toBeDefined();
    // Осталось два миллисекундных запаса, не больше.
    const removed = before.length - (after?.length ?? 0);
    expect(removed).toBeGreaterThan(Math.round(0.03 * SAMPLE_RATE));
    expect(removed).toBeLessThanOrEqual(Math.round(0.04 * SAMPLE_RATE));
  });

  it('оставляет запас перед атакой, а не режет впритык', () => {
    // Срезанная впритык атака начинается не с нуля — это щелчок.
    const [after] = trimLeadingSilence([withSilence(0.04, 0.2)], SAMPLE_RATE);
    expect(Math.abs(after?.[0] ?? 1)).toBeLessThan(0.01);
  });

  it('режет все каналы одинаково', () => {
    const [left, right] = trimLeadingSilence(stereo(withSilence(0.04, 0.2)), SAMPLE_RATE);
    expect(left?.length).toBe(right?.length);
  });

  it('не трогает запись, начинающуюся сразу', () => {
    const source = withSilence(0, 0.2);
    const [after] = trimLeadingSilence([source], SAMPLE_RATE);
    expect(after?.length).toBe(source.length);
  });

  it('не ломается на полной тишине', () => {
    const [after] = trimLeadingSilence([new Float32Array(1000)], SAMPLE_RATE);
    expect(after?.length).toBeGreaterThan(0);
  });
});

describe('пересчёт скорости', () => {
  it('ускорение укорачивает, замедление удлиняет', () => {
    const source = withSilence(0, 1);
    expect(resample([source], 1.25)[0]?.length).toBe(Math.floor(source.length / 1.25));
    expect(resample([source], 0.8)[0]?.length).toBe(Math.floor(source.length / 0.8));
  });

  it('единичная скорость не трогает массив', () => {
    const source = withSilence(0, 0.1);
    expect(resample([source], 1)[0]).toBe(source);
  });

  it('замедление понижает тон', () => {
    const crossings = (samples: Float32Array): number => {
      let count = 0;
      let previous = samples[0] ?? 0;
      for (let index = 1; index < samples.length; index += 1) {
        const value = samples[index] ?? 0;
        if (previous < 0 !== value < 0) count += 1;
        previous = value;
      }
      return (count * SAMPLE_RATE) / (2 * samples.length);
    };

    const source = withSilence(0, 0.5, 1000);
    expect(crossings(resample([source], 0.5)[0] as Float32Array)).toBeCloseTo(500, -1);
    expect(crossings(resample([source], 2)[0] as Float32Array)).toBeCloseTo(2000, -1);
  });
});

describe('затухание хвоста', () => {
  it('приходит ровно в ноль и не трогает начало', () => {
    const channels = [new Float32Array(SAMPLE_RATE).fill(0.5)];
    fadeFrom(channels, SAMPLE_RATE, 0.5);

    const samples = channels[0] as Float32Array;
    expect(samples[0]).toBeCloseTo(0.5, 6);
    expect(samples[Math.round(0.49 * SAMPLE_RATE)]).toBeCloseTo(0.5, 6);
    expect(samples[samples.length - 1]).toBeCloseTo(0, 4);
  });

  it('начинается незаметно: первые проценты почти не убавлены', () => {
    // Четверть косинуса начинается с нулевым наклоном — иначе слышно,
    // как «кто-то тронул ручку».
    const channels = [new Float32Array(SAMPLE_RATE).fill(1)];
    fadeFrom(channels, SAMPLE_RATE, 0.5);

    const samples = channels[0] as Float32Array;
    const justAfter = samples[Math.round(0.53 * SAMPLE_RATE)] ?? 0;
    expect(justAfter).toBeGreaterThan(0.98);
  });

  it('монотонно убывает', () => {
    const channels = [new Float32Array(SAMPLE_RATE).fill(1)];
    fadeFrom(channels, SAMPLE_RATE, 0.2);

    const samples = channels[0] as Float32Array;
    let previous = Number.POSITIVE_INFINITY;
    for (let index = Math.round(0.2 * SAMPLE_RATE); index < samples.length; index += 100) {
      const value = samples[index] ?? 0;
      expect(value).toBeLessThanOrEqual(previous + 1e-6);
      previous = value;
    }
  });

  it('за пределами длины ничего не делает', () => {
    const channels = [new Float32Array(100).fill(1)];
    fadeFrom(channels, SAMPLE_RATE, 10);
    expect(channels[0]?.[99]).toBe(1);
  });
});

describe('края и нормировка', () => {
  it('края сглаживаются в ноль', () => {
    const channels = [new Float32Array(SAMPLE_RATE).fill(0.5)];
    smoothEdges(channels, SAMPLE_RATE);

    const samples = channels[0] as Float32Array;
    expect(samples[0]).toBe(0);
    expect(samples[samples.length - 1]).toBe(0);
    expect(samples[SAMPLE_RATE / 2]).toBeCloseTo(0.5, 6);
  });

  it('нормировка считает пик по всем каналам разом', () => {
    // Поканальная нормировка схлопнула бы стереообраз в середину:
    // тихий канал подтянулся бы к громкому.
    const left = new Float32Array([0.2, -0.2]);
    const right = new Float32Array([0.8, -0.8]);
    normaliseChannels([left, right], 0.5);

    expect(peakOf(right)).toBeCloseTo(0.5, 6);
    expect(peakOf(left)).toBeCloseTo(0.125, 6);
  });

  it('нормировка тишины не делит на ноль', () => {
    const channels = [new Float32Array(16)];
    normaliseChannels(channels, 0.5);
    expect(peakOf(channels[0] as Float32Array)).toBe(0);
  });
});

describe('замыкание петли', () => {
  const noise = (length: number): Float32Array => {
    const samples = new Float32Array(length);
    let state = 12345;
    for (let index = 0; index < length; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      samples[index] = state / 0x80000000 - 1;
    }
    return samples;
  };

  it('укорачивает на длину склейки', () => {
    const source = noise(SAMPLE_RATE);
    const [closed] = closeLoop([source], SAMPLE_RATE, 0.05);
    expect(closed?.length).toBe(SAMPLE_RATE - Math.round(0.05 * SAMPLE_RATE));
  });

  it('делает стык непрерывным', () => {
    // Мерка простая: скачок на стыке не должен быть больше типичного
    // скачка внутри записи. Именно этот скачок и слышен щелчком
    // четырнадцать раз в секунду.
    const source = noise(SAMPLE_RATE);
    const [closed] = closeLoop([source], SAMPLE_RATE, 0.05);
    const samples = closed as Float32Array;

    let inside = 0;
    for (let index = 1; index < samples.length; index += 1) {
      inside += Math.abs((samples[index] ?? 0) - (samples[index - 1] ?? 0));
    }
    const average = inside / (samples.length - 1);

    const seam = Math.abs((samples[0] ?? 0) - (samples[samples.length - 1] ?? 0));
    expect(seam).toBeLessThan(average * 4);
  });

  it('слишком короткую запись не трогает', () => {
    const source = new Float32Array(4);
    expect(closeLoop([source], SAMPLE_RATE, 0.05)[0]?.length).toBe(4);
  });
});

describe('наложение слоя', () => {
  it('складывает вторую запись с первой', () => {
    // Сравнение приближённое: отсчёты хранятся в одинарной точности,
    // и 0,1 плюс 0,5 в ней не равно ровно 0,6.
    const base = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    mixInto([base], [new Float32Array([1, 1, 1, 1])], 0.5, SAMPLE_RATE);
    for (const [index, want] of [0.6, 0.7, 0.8, 0.9].entries()) {
      expect(base[index]).toBeCloseTo(want, 6);
    }
  });

  it('слой короче основы просто кончается раньше', () => {
    const base = new Float32Array([1, 1, 1, 1]);
    mixInto([base], [new Float32Array([1, 1])], 1, SAMPLE_RATE);
    expect(Array.from(base)).toEqual([2, 2, 1, 1]);
  });

  it('слой длиннее основы обрезается по ней', () => {
    // Длину звука задаёт основа: слой — добавка, а не продолжение.
    const base = new Float32Array([1, 1]);
    const result = mixInto([base], [new Float32Array([1, 1, 1, 1, 1])], 1, SAMPLE_RATE);
    expect(result[0]?.length).toBe(2);
    expect(Array.from(base)).toEqual([2, 2]);
  });

  it('моно поверх стерео ложится в оба канала', () => {
    // Иначе правый канал остался бы без слоя, и стереообраз разъехался бы.
    const left = new Float32Array([1, 1]);
    const right = new Float32Array([1, 1]);
    mixInto([left, right], [new Float32Array([1, 1])], 0.5, SAMPLE_RATE);
    expect(Array.from(left)).toEqual([1.5, 1.5]);
    expect(Array.from(right)).toEqual([1.5, 1.5]);
  });

  it('смещение сдвигает слой во времени', () => {
    const base = new Float32Array(4);
    mixInto([base], [new Float32Array([1, 1])], 1, 1000, 0.002);
    expect(Array.from(base)).toEqual([0, 0, 1, 1]);
  });

  it('пустой слой ничего не меняет', () => {
    const base = new Float32Array([0.5, 0.5]);
    mixInto([base], [], 1, SAMPLE_RATE);
    expect(Array.from(base)).toEqual([0.5, 0.5]);
  });

  it('в подготовке слой ложится до нормировки, а не после', () => {
    // Иначе сумма выходила бы за единицу: обе записи приведены
    // к своему пику по отдельности.
    const base = stereo(withSilence(0, 0.2));
    const layer = stereo(withSilence(0, 0.2, 880));

    const prepared = prepareFile(base, {
      sampleRate: SAMPLE_RATE,
      rate: 1,
      peak: 0.6,
      looping: false,
      layer: { channels: layer, gain: 1 },
    });

    expect(peakOf(prepared[0] as Float32Array)).toBeCloseTo(0.6, 5);
  });
});

describe('разворот и размножение', () => {
  it('разворот переставляет отсчёты задом наперёд', () => {
    const [out] = reverse([new Float32Array([1, 2, 3, 4])]);
    expect(Array.from(out as Float32Array)).toEqual([4, 3, 2, 1]);
  });

  it('разворот превращает разгон в затухание', () => {
    // Ровно то, ради чего он заведён: запись луча нарастает от начала
    // до конца, а выстрелу положено начинаться с полной силы.
    const rising = new Float32Array(1000);
    for (let index = 0; index < rising.length; index += 1) {
      rising[index] = (index / rising.length) * Math.sin(index);
    }

    const [out] = reverse([rising]);
    const samples = out as Float32Array;
    expect(rms(samples, 0, 200)).toBeGreaterThan(rms(samples, 800));
    expect(rms(rising, 0, 200)).toBeLessThan(rms(rising, 800));
  });

  it('разворот не меняет длину и не теряет каналов', () => {
    const out = reverse(stereo(withSilence(0, 0.1)));
    expect(out).toHaveLength(2);
    expect(out[0]?.length).toBe(Math.round(0.1 * SAMPLE_RATE));
  });

  it('размножение доводит до нужной длины повторением', () => {
    const [out] = tile([new Float32Array([1, 2, 3])], 8);
    expect(Array.from(out as Float32Array)).toEqual([1, 2, 3, 1, 2, 3, 1, 2]);
  });

  it('размножение пустого не делит на ноль', () => {
    expect(tile([new Float32Array(0)], 8)[0]?.length).toBe(0);
  });

  it('у зацикленного короткий слой звучит по всей петле', () => {
    // Иначе лопасти прозвучали бы раз в начале круга и пропали,
    // а у петли начала и конца нет.
    const base = new Float32Array(SAMPLE_RATE).fill(0.2);
    const short = new Float32Array(Math.round(SAMPLE_RATE * 0.1)).fill(0.2);

    const prepared = prepareFile([base], {
      sampleRate: SAMPLE_RATE,
      rate: 1,
      peak: 1,
      looping: true,
      layer: { channels: [short], gain: 1 },
    });

    const a = prepared[0] as Float32Array;
    // Слой добавил громкости и в начале, и в конце петли.
    expect(rms(a, 0, 1000)).toBeCloseTo(rms(a, a.length - 1000), 2);
  });
});

describe('подготовка целиком', () => {
  it('делает всё разом и в нужном порядке', () => {
    const prepared = prepareFile(stereo(withSilence(0.04, 1)), {
      sampleRate: SAMPLE_RATE,
      rate: 1,
      peak: 0.6,
      fadeFromSeconds: 0.5,
      looping: false,
    });

    const left = prepared[0] as Float32Array;

    // Тишина срезана.
    expect(left.length).toBeLessThan(Math.round(1.04 * SAMPLE_RATE));
    // Уровень приведён.
    expect(peakOf(left)).toBeCloseTo(0.6, 5);
    // Края сглажены. Сравнение по модулю, а не с нулём: умножение
    // отрицательного отсчёта на ноль даёт минус ноль, а он для
    // `Object.is` не равен нулю.
    expect(Math.abs(left[0] ?? 1)).toBe(0);
    expect(Math.abs(left[left.length - 1] ?? 1)).toBe(0);
    // Хвост уведён: последняя четверть тише второй.
    const quarter = Math.floor(left.length / 4);
    expect(rms(left, 3 * quarter)).toBeLessThan(rms(left, quarter, 2 * quarter) / 2);
  });

  it('зацикленному сшивает стык, а не глушит края', () => {
    const prepared = prepareFile(stereo(withSilence(0, 1)), {
      sampleRate: SAMPLE_RATE,
      rate: 1,
      peak: 0.6,
      looping: true,
    });

    const left = prepared[0] as Float32Array;
    // Ноль на краю у петли означал бы провал громкости на каждом круге.
    expect(Math.abs(left[0] ?? 0)).toBeGreaterThan(0);
    expect(Math.abs(left[left.length - 1] ?? 0)).toBeGreaterThan(0);
  });

  it('затухание задано в секундах готового звука, а не исходника', () => {
    // Пересчёт скорости идёт раньше затухания, поэтому «с четвёртой
    // секунды» означает четвёртую секунду того, что услышит игрок.
    const slow = prepareFile([withSilence(0, 2)], {
      sampleRate: SAMPLE_RATE,
      rate: 0.5,
      peak: 1,
      fadeFromSeconds: 1,
      looping: false,
    });

    const samples = slow[0] as Float32Array;
    expect(samples.length).toBe(Math.floor(2 * SAMPLE_RATE / 0.5));
    // На первой секунде звук ещё в полную силу, на третьей уже нет.
    expect(rms(samples, 0, SAMPLE_RATE)).toBeGreaterThan(rms(samples, 3 * SAMPLE_RATE) * 3);
  });
});
