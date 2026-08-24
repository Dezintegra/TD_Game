import { describe, expect, it } from 'vitest';
import type { ThinRecord } from '@td/shared';
import { tempoOf } from './tempo.js';

/**
 * Темп — единственное, чего в записи не было.
 *
 * Проверяется здесь и обратная сторона: запись без отметок обязана
 * читаться и честно сообщать, что темп по ней восстановить нельзя.
 * Молчаливый ноль был бы хуже — его приняли бы за ровный матч.
 */

const sum = (tick: number, atMs?: number): ThinRecord =>
  atMs === undefined ? { t: 'sum', tick, value: 1 } : { t: 'sum', tick, value: 1, atMs };

describe('темп записанного матча', () => {
  it('ровный матч не даёт отставания', () => {
    const tempo = tempoOf([sum(30, 0), sum(60, 1000), sum(90, 2000)]);

    expect(tempo.timed).toBe(true);
    expect(tempo.steps).toStrictEqual([
      { tick: 60, expectedMs: 1000, actualMs: 1000 },
      { tick: 90, expectedMs: 1000, actualMs: 1000 },
    ]);
  });

  it('заминка видна промежутком длиннее ожидаемого', () => {
    const tempo = tempoOf([sum(30, 0), sum(60, 1180), sum(90, 2180)]);

    // Первый промежуток отстал на 180 мс, второй наверстал темп,
    // но не долг: отсчёт идёт от начала матча, а не от прошлой отметки.
    expect(tempo.steps[0]?.actualMs).toBe(1180);
    expect(tempo.steps[1]?.actualMs).toBe(1000);
  });

  it('запись без отметок честно говорит, что темпа в ней нет', () => {
    const tempo = tempoOf([sum(30), sum(60), sum(90)]);

    expect(tempo.timed).toBe(false);
    expect(tempo.steps).toStrictEqual([]);
  });

  it('прочие записи в счёт не идут', () => {
    const tempo = tempoOf([
      { t: 'cmd', tick: 10, player: 0, kind: 0, arg0: 0, arg1: 0 },
      sum(30, 0),
      { t: 'over', tick: 61, winner: 1, reason: 'base' },
      sum(60, 1000),
    ]);

    expect(tempo.steps).toHaveLength(1);
    expect(tempo.steps[0]?.tick).toBe(60);
  });
});
