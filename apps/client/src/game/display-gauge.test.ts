import { MS_PER_TICK } from '@td/shared';
import { describe, expect, it } from 'vitest';
import { createDisplayGauge } from './display-gauge.js';

describe('прибор картинки', () => {
  it('меряет промежутки между сменами показываемого тика', () => {
    const gauge = createDisplayGauge();

    gauge.observe(10, 1000);
    gauge.observe(11, 1033);
    gauge.observe(12, 1066);

    const snapshot = gauge.snapshot();
    // Первый показанный тик промежутка не даёт: сравнивать не с чем.
    expect(snapshot.count).toBe(2);
    expect(snapshot.sum).toBe(66);
    expect(snapshot.max).toBe(33);
  });

  it('пересборка без смены тика промежутка не даёт', () => {
    // Показываемое состояние пересобирается и от своей команды, и от
    // кадра, не сдвинувшего показ. Оба раза картинка стоит на месте,
    // и промежуток здесь был бы враньём — причём враньём в приятную
    // сторону: ряд наполнился бы нулями и показал бы идеальную
    // плавность там, где мир замер.
    const gauge = createDisplayGauge();

    gauge.observe(10, 1000);
    gauge.observe(10, 1005);
    gauge.observe(10, 1010);

    expect(gauge.snapshot().count).toBe(0);
  });

  it('простой дольше тика считается превышением', () => {
    // То самое число, ради которого всё затевалось: сколько раз мир
    // на экране простоял дольше тика. Точное, а не оценка по корзинам.
    const gauge = createDisplayGauge();

    gauge.observe(1, 0);
    gauge.observe(2, MS_PER_TICK);
    gauge.observe(3, MS_PER_TICK * 5);
    gauge.observe(4, MS_PER_TICK * 6);

    const snapshot = gauge.snapshot();
    expect(snapshot.count).toBe(3);
    expect(snapshot.overBudget).toBe(1);
    expect(snapshot.max).toBeCloseTo(MS_PER_TICK * 4, 6);
  });

  it('откат тика назад промежутком не считается', () => {
    // Показываемый тик назад не ходит, но прибор не вправе этого
    // предполагать: отрицательный промежуток испортил бы сумму молча.
    // Смена тика вниз — это смена, и время с неё отсчитывается заново.
    const gauge = createDisplayGauge();

    gauge.observe(10, 1000);
    gauge.observe(9, 1010);
    gauge.observe(10, 1043);

    const snapshot = gauge.snapshot();
    expect(snapshot.count).toBe(2);
    expect(snapshot.sum).toBe(43);
  });
});
