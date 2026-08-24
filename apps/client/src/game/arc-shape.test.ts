import { describe, expect, it } from 'vitest';
import {
  ARC_MAX_TILES,
  ARC_TILE_H,
  ARC_TILE_PX,
  ARC_VARIANTS,
  ARC_WAVE_SHARE,
  arcStrands,
  arcTileCount,
  arcVariantAt,
  arcWaveFront,
  arcWaveGain,
  arcWaveHeadAlpha,
} from './arc-shape.js';

/**
 * Разряд собирается из запечённых плиток, и проверять его картинкой
 * нельзя: выпечка требует видеокарты, которой в тестах нет.
 *
 * Зато можно проверить то, на чём вся затея держится, — правила стыковки
 * и арифметику. Это и есть настоящие утверждения об облике: «концы жил
 * сидят на осевой» держит канал непрерывным, «плиток целое число, а шаг
 * подогнан» держит разряд между стволом и целью, «форма не меняется
 * внутри тика» держит молнию молнией, а не шумом.
 */

const MID = ARC_TILE_H / 2;

describe('плитка разряда', () => {
  it('каждая жила входит и выходит по осевой', () => {
    // Это условие стыковки: пока оно выполняется, любая плитка встаёт
    // после любой, и канал не рвётся. Нарушь его — и придётся заводить
    // соответствие кромок, то есть пары «эта после этой».
    for (let variant = 0; variant < ARC_VARIANTS; variant += 1) {
      for (const strand of arcStrands(variant)) {
        const first = strand[0];
        const last = strand[strand.length - 1];

        expect(first).toEqual({ x: 0, y: MID });
        expect(last?.x).toBeCloseTo(ARC_TILE_PX, 6);
        expect(last?.y).toBeCloseTo(MID, 6);
      }
    }
  });

  it('жилы изломаны, а не прямы', () => {
    for (let variant = 0; variant < ARC_VARIANTS; variant += 1) {
      for (const strand of arcStrands(variant)) {
        expect(strand.some((node) => Math.abs(node.y - MID) > 0.5)).toBe(true);
      }
    }
  });

  it('узлы стоят неравномерно вдоль плитки', () => {
    // Равные звенья дают период излома, а период читается волной,
    // а не молнией. Ищем хоть один вариант с заметно разными звеньями.
    const uneven = (variant: number): boolean => {
      const strand = arcStrands(variant)[0] ?? [];
      const spans: number[] = [];
      for (let index = 1; index < strand.length; index += 1) {
        spans.push((strand[index]?.x ?? 0) - (strand[index - 1]?.x ?? 0));
      }
      return Math.max(...spans) - Math.min(...spans) > ARC_TILE_PX * 0.05;
    };

    expect(Array.from({ length: ARC_VARIANTS }, (_, v) => v).some(uneven)).toBe(true);
  });

  it('варианты различаются между собой', () => {
    const first = JSON.stringify(arcStrands(0));
    const others = Array.from({ length: ARC_VARIANTS - 1 }, (_, index) =>
      JSON.stringify(arcStrands(index + 1)),
    );

    expect(others.every((other) => other !== first)).toBe(true);
  });

  it('один и тот же вариант выпекается одинаково', () => {
    // Плитки печутся при запуске. Разойдись они между запусками —
    // одна и та же карта выглядела бы каждый раз иначе.
    expect(JSON.stringify(arcStrands(3))).toEqual(JSON.stringify(arcStrands(3)));
  });
});

describe('раскладка разряда', () => {
  it('плиток тем больше, чем длиннее выстрел', () => {
    expect(arcTileCount(ARC_TILE_PX * 3)).toBeGreaterThan(arcTileCount(ARC_TILE_PX));
  });

  it('на любой длине плиток не меньше двух и не больше предела', () => {
    for (const length of [0, 1, 40, 300, 900, 5000]) {
      const count = arcTileCount(length);
      expect(count).toBeGreaterThanOrEqual(2);
      expect(count).toBeLessThanOrEqual(ARC_MAX_TILES);
    }
  });

  it('шаг подогнан под длину, а не равен плитке', () => {
    // Так разряд начинается точно у ствола и кончается точно в цели
    // на ЛЮБОМ расстоянии, а не только на кратном плитке.
    for (const length of [137, 319, 747]) {
      const step = length / arcTileCount(length);
      expect(step * arcTileCount(length)).toBeCloseTo(length, 6);
    }
  });

  it('растяжение плитки остаётся малым на рабочих дальностях', () => {
    // Шесть клеток — нынешняя дальность, пятнадцать — куда она уезжает
    // после прокачки. Больше трети — и зигзаг начал бы читаться резиновым.
    for (const length of [190, 380, 747]) {
      const step = length / arcTileCount(length);
      expect(Math.abs(step / ARC_TILE_PX - 1)).toBeLessThan(0.34);
    }
  });

  it('форма держится весь тик и меняется на следующем', () => {
    const now = arcVariantAt(4242, 3, 7);

    expect(arcVariantAt(4242, 3, 7)).toEqual(now);
    expect(arcVariantAt(4242, 3, 8)).not.toEqual(now);
  });

  it('соседние плитки берут разные варианты', () => {
    // Иначе весь канал мигает разом и рассинхрона нет.
    const row = Array.from({ length: 6 }, (_, index) => arcVariantAt(4242, index, 0));

    expect(new Set(row).size).toBeGreaterThan(1);
  });
});

describe('волна', () => {
  it('фронт проходит канал за первую часть жизни разряда', () => {
    const span = 0.27;

    expect(arcWaveFront(0, span)).toBeCloseTo(0, 6);
    expect(arcWaveFront(span * ARC_WAVE_SHARE * 0.5, span)).toBeCloseTo(0.5, 6);
    expect(arcWaveFront(span * ARC_WAVE_SHARE, span)).toBeUndefined();
    expect(arcWaveFront(span, span)).toBeUndefined();
  });

  it('фронт ярче хвоста и головы канала', () => {
    const front = 0.5;

    expect(arcWaveGain(0.5, front)).toBeGreaterThan(arcWaveGain(0.1, front));
    expect(arcWaveGain(0.5, front)).toBeGreaterThan(arcWaveGain(0.9, front));
  });

  it('канал виден весь, а не только под фронтом', () => {
    // Иначе разряд распадается на «уже прошло» и «ещё не пришло».
    expect(arcWaveGain(0.95, 0.1)).toBeGreaterThan(0.3);
  });

  it('после волны канал горит ровно', () => {
    expect(arcWaveGain(0.1, undefined)).toEqual(1);
    expect(arcWaveGain(0.9, undefined)).toEqual(1);
  });

  it('бегущее пятно гаснет у обоих концов', () => {
    expect(arcWaveHeadAlpha(0.5)).toBeGreaterThan(arcWaveHeadAlpha(0.02));
    expect(arcWaveHeadAlpha(0.5)).toBeGreaterThan(arcWaveHeadAlpha(0.98));
    expect(arcWaveHeadAlpha(undefined)).toEqual(0);
  });
});
