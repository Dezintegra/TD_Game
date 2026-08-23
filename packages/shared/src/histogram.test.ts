import { describe, expect, it } from 'vitest';
import { MS_PER_TICK, TICKS_PER_SECOND } from './constants.js';
import { TICK_BUDGET_MS, TIMING_BOUNDS_MS, createHistogram } from './histogram.js';

/**
 * Гистограмма заведена затем, чтобы среднее больше ничего не прятало.
 * Поэтому и проверяется здесь прежде всего то, что среднее скрыло бы:
 * хвост, число превышений и подвижность границы бюджета.
 */
describe('гистограмма длительностей', () => {
  it('перцентили оценивают выборку', () => {
    const hist = createHistogram();
    // Сто наблюдений: девяносто дешёвых и десять дорогих.
    for (let i = 0; i < 90; i += 1) hist.add(1);
    for (let i = 0; i < 10; i += 1) hist.add(100);

    const snap = hist.snapshot();

    expect(snap.count).toBe(100);
    expect(snap.p50).toBeLessThanOrEqual(1);
    // Девяносто пятый лежит среди дорогих, то есть за последней границей.
    expect(snap.p95).toBeGreaterThan(TICK_BUDGET_MS);
  });

  it('максимум и число превышений точные, а не корзинные', () => {
    const hist = createHistogram();
    hist.add(1);
    hist.add(1);
    hist.add(197.4);

    const snap = hist.snapshot();

    // Не верхняя граница корзины и не середина: ровно то, что случилось.
    expect(snap.max).toBe(197.4);
    expect(snap.overBudget).toBe(1);
  });

  it('среднее прячет то, что видно по хвосту', () => {
    // Два ряда с одинаковым средним: ровный и дёрганый. Ради этой
    // разницы гистограмма и заведена.
    const even = createHistogram();
    const jerky = createHistogram();

    // Оба ряда дают в сумме ровно 500 на сто наблюдений: 100×5
    // и 90×1 + 10×41. Среднее у них совпадает до последнего знака,
    // и в этом весь смысл проверки.
    for (let i = 0; i < 100; i += 1) even.add(5);
    for (let i = 0; i < 90; i += 1) jerky.add(1);
    for (let i = 0; i < 10; i += 1) jerky.add(41);

    const a = even.snapshot();
    const b = jerky.snapshot();

    expect(a.sum / a.count).toBe(b.sum / b.count);
    // А по хвосту разница видна сразу: у ровного ряда мимо бюджета
    // не ушло ничего, у дёрганого — каждое десятое наблюдение.
    expect(a.overBudget).toBe(0);
    expect(b.overBudget).toBe(10);
    expect(a.max).toBe(5);
    expect(b.max).toBe(41);
  });

  it('граница бюджета едет вслед за темпом симуляции', () => {
    // Не украшательство: записанные числом границы пережили бы смену
    // темпа, и корзина «уложились» стала бы означать другое. Молча.
    expect(TICK_BUDGET_MS).toBe(MS_PER_TICK);
    expect(MS_PER_TICK).toBe(1000 / TICKS_PER_SECOND);
    expect(TIMING_BOUNDS_MS).toContain(TICK_BUDGET_MS);
  });

  it('пустая гистограмма не делит на ноль', () => {
    const snap = createHistogram().snapshot();

    expect(snap.count).toBe(0);
    expect(snap.p50).toBe(0);
    expect(snap.max).toBe(0);
  });

  it('забывает накопленное по просьбе', () => {
    const hist = createHistogram();
    hist.add(100);
    hist.reset();

    const snap = hist.snapshot();

    expect(snap.count).toBe(0);
    expect(snap.overBudget).toBe(0);
    expect(snap.max).toBe(0);
  });
});
