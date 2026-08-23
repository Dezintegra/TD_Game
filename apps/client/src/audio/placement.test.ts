import { describe, expect, it } from 'vitest';
import { SILENT_BEYOND_CELLS, isAudible, place } from './placement.js';
import type { Listener } from './placement.js';
import { REVERB_SECONDS, renderReverb } from './reverb.js';
import { peakOf, rms } from './dsp.js';

const LISTENER: Listener = { cellX: 24, cellY: 24, halfWidth: 700 };

describe('размещение источника', () => {
  it('в центре обзора панорамы нет', () => {
    const placement = place(LISTENER.cellX, LISTENER.cellY, LISTENER);
    expect(placement.pan).toBe(0);
    expect(placement.gain).toBe(1);
  });

  it('дальнее тише ближнего', () => {
    const near = place(26, 24, LISTENER).gain;
    const middle = place(34, 24, LISTENER).gain;
    const far = place(44, 24, LISTENER).gain;

    expect(near).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(far);
  });

  it('за отсечкой тишина', () => {
    const beyond = LISTENER.cellX + SILENT_BEYOND_CELLS + 1;
    expect(place(beyond, LISTENER.cellY, LISTENER).gain).toBe(0);
    expect(isAudible(beyond, LISTENER.cellY, LISTENER)).toBe(false);
    expect(isAudible(LISTENER.cellX + 1, LISTENER.cellY, LISTENER)).toBe(true);
  });

  it('громкость не прыгает на подходе к отсечке', () => {
    // Обрыв на границе слышен щелчком, поэтому громкость должна доходить
    // до нуля скатом, а не ступенькой.
    let previous = place(LISTENER.cellX, LISTENER.cellY, LISTENER).gain;
    for (let step = 1; step <= 200; step += 1) {
      const gain = place(LISTENER.cellX + step * 0.2, LISTENER.cellY, LISTENER).gain;
      expect(gain).toBeLessThanOrEqual(previous + 1e-9);
      expect(previous - gain).toBeLessThan(0.02);
      previous = gain;
    }
    expect(previous).toBe(0);
  });

  it('панорама не выходит за три четверти и держит сторону', () => {
    // В этой проекции экранная x растёт по мировому x и убывает
    // по мировому y, поэтому «слева» — это меньший x при том же y.
    const right = place(LISTENER.cellX + 20, LISTENER.cellY, LISTENER).pan;
    const left = place(LISTENER.cellX - 20, LISTENER.cellY, LISTENER).pan;

    expect(right).toBeGreaterThan(0);
    expect(left).toBeLessThan(0);
    expect(Math.abs(right)).toBeLessThanOrEqual(0.75);
    expect(Math.abs(left)).toBeLessThanOrEqual(0.75);

    for (let cell = -200; cell <= 200; cell += 5) {
      expect(Math.abs(place(cell, LISTENER.cellY, LISTENER).pan)).toBeLessThanOrEqual(0.75);
    }
  });

  it('панорама следует за прокруткой карты', () => {
    // Ровно то, ради чего размещение считается каждый кадр: источник
    // стои́т на месте, игрок прокручивает карту — и звук уезжает.
    const source = { x: 30, y: 24 };
    const before = place(source.x, source.y, LISTENER).pan;
    const after = place(source.x, source.y, { ...LISTENER, cellX: 36 }).pan;

    expect(before).toBeGreaterThan(0);
    expect(after).toBeLessThan(0);
  });

  it('дальнее глуше и с бо́льшей долей отражений', () => {
    const near = place(25, 24, LISTENER);
    const far = place(44, 24, LISTENER);

    expect(far.cutoff).toBeLessThan(near.cutoff);
    expect(far.wet).toBeGreaterThan(near.wet);
    expect(near.wet).toBeGreaterThan(0);
    expect(far.wet).toBeLessThan(1);
  });

  it('узкое окно панорамирует резче широкого', () => {
    const wide = place(30, 24, LISTENER).pan;
    const narrow = place(30, 24, { ...LISTENER, halfWidth: 300 }).pan;
    expect(Math.abs(narrow)).toBeGreaterThan(Math.abs(wide));
  });

  it('нулевая ширина окна не делит на ноль', () => {
    const placement = place(30, 24, { ...LISTENER, halfWidth: 0 });
    expect(Number.isFinite(placement.pan)).toBe(true);
  });
});

describe('отклик помещения', () => {
  const [left, right] = renderReverb(48000);

  it('оба канала нужной длины и не пустые', () => {
    expect(left.length).toBe(Math.round(REVERB_SECONDS * 48000));
    expect(right.length).toBe(left.length);
    expect(peakOf(left)).toBeCloseTo(0.7, 6);
    expect(peakOf(right)).toBeCloseTo(0.7, 6);
  });

  it('каналы не совпадают: иначе отклик слышен посередине головы', () => {
    let same = 0;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] === right[index]) same += 1;
    }
    expect(same / left.length).toBeLessThan(0.05);
  });

  it('начинается с задержки, а не сразу', () => {
    // Звуку надо дойти до отражающей поверхности и вернуться.
    const predelay = Math.round(0.015 * 48000);
    expect(rms(left, 0, predelay)).toBe(0);
    expect(rms(left, predelay, predelay * 3)).toBeGreaterThan(0);
  });

  it('затухает монотонно по четвертям', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let part = 0; part < 4; part += 1) {
      const from = Math.floor((left.length * part) / 4);
      const to = Math.floor((left.length * (part + 1)) / 4);
      const level = rms(left, from, to);
      expect(level).toBeLessThan(previous);
      previous = level;
    }
  });

  it('к концу темнеет: воздух гасит верх и в отражениях', () => {
    const brightness = (from: number, to: number): number => {
      let crossings = 0;
      let previous = left[from] ?? 0;
      for (let index = from + 1; index < to; index += 1) {
        const value = left[index] ?? 0;
        if (previous < 0 !== value < 0) crossings += 1;
        previous = value;
      }
      return crossings / (to - from);
    };

    const head = brightness(Math.round(0.02 * 48000), Math.round(0.2 * 48000));
    const tail = brightness(Math.round(left.length * 0.7), left.length);
    expect(tail).toBeLessThan(head);
  });

  it('не содержит NaN', () => {
    let broken = 0;
    for (let index = 0; index < left.length; index += 1) {
      if (!Number.isFinite(left[index] ?? 0) || !Number.isFinite(right[index] ?? 0)) broken += 1;
    }
    expect(broken).toBe(0);
  });
});
