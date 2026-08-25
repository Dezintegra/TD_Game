import { describe, expect, it } from 'vitest';
import { TICKS_PER_SECOND } from '../packages/shared/src/constants.ts';
import {
  COMPARABLE,
  INCOMPARABLE,
  NO_CONTEXT,
  WORLD_TICKS_PER_SECOND,
  busySamples,
  comparability,
  summariseBusy,
} from './perf-common.mjs';

/**
 * Проверки счётной части замеров.
 *
 * Всё, что трогает машину, — замок, порты, сам прогон Playwright —
 * здесь не проверяется намеренно: такая проверка занимала бы машину
 * ровно тем, от чего замер и страхует.
 */

/**
 * Обстановка обычной сцены: шестисекундное окно, мир идёт своим ходом,
 * сверка двигается следом.
 */
const calmScene = (over = {}) => ({
  tickFrom: 100,
  tickTo: 280,
  windowMs: 6000,
  syncFrom: 95,
  syncTo: 275,
  syncBehind: 5,
  latencyMs: 14,
  inputDelayTicks: 3,
  frameLong: 0,
  frameP95: 17,
  frameMax: 33,
  pongs: 6,
  ...over,
});

/** Запись журнала нового образца. */
const entry = (over = {}) => ({
  kind: 'кадры',
  busy: 0.12,
  busyMedian: 0.14,
  busyMax: 0.3,
  passed: true,
  measurements: { 'камера в движении': 60, 'войска на поле': 60 },
  context: { 'камера в движении': calmScene(), 'войска на поле': calmScene() },
  ...over,
});

describe('ход мира', () => {
  it('совпадает с проектным темпом симуляции', () => {
    // Значение продублировано в `perf-common.mjs`, потому что импортировать
    // туда пакет нельзя: `--history` обязан работать и до сборки. Этот тест
    // и есть замена импорта — разъехаться молча они не смогут.
    expect(WORLD_TICKS_PER_SECOND).toBe(TICKS_PER_SECOND);
  });
});

describe('нагрузка за прогон', () => {
  /**
   * Поддельные счётчики процессора.
   *
   * Каждая доля задаёт, сколько времени за очередной промежуток ушло
   * не на простой. Настоящую нагрузку здесь устраивать нельзя: проверка
   * заняла бы машину ровно тем, от чего замер и страхует.
   */
  const cpuReader = (shares) => {
    let idle = 0;
    let total = 0;
    let index = 0;
    return () => {
      if (index > 0) {
        const share = shares[index - 1] ?? 0;
        total += 1000;
        idle += 1000 * (1 - share);
      }
      index += 1;
      return { idle, total };
    };
  };

  const sampleAll = (shares) => {
    const samples = busySamples(cpuReader(shares));
    for (let index = 0; index < shares.length; index += 1) samples.take();
    return samples.summary();
  };

  it('видит нагрузку, пришедшую в середине прогона', () => {
    // Ровно тот случай, ради которого наблюдение и заводится: замер
    // начался в тишине, а на середине пришла чужая сборка.
    const load = sampleAll([0.1, 0.12, 0.9, 0.95, 0.11, 0.1]);

    expect(load.max).toBeCloseTo(0.95, 2);
    expect(load.median).toBeGreaterThan(0.1);
    expect(load.samples).toBe(6);
  });

  it('отличает всплеск от обстановки', () => {
    // Одна занятая секунда за прогон — это всплеск: максимум высокий,
    // медиана тихая. Если бы решения принимались по максимуму, любой
    // такой прогон объявлялся бы негодным.
    const spike = sampleAll([0.05, 0.05, 0.98, 0.06, 0.05]);
    expect(spike.max).toBeCloseTo(0.98, 2);
    expect(spike.median).toBeLessThan(0.1);

    // А вот это уже обстановка: занята вся минута.
    const steady = sampleAll([0.7, 0.8, 0.75, 0.9, 0.72]);
    expect(steady.median).toBeGreaterThan(0.35);
  });

  it('молчит, когда пробовать было нечего', () => {
    // Ноль на этом месте читался бы как «машина простаивала» —
    // утверждение из воздуха там, где измерения не было вовсе.
    expect(summariseBusy([])).toBeNull();

    const samples = busySamples(() => ({ idle: 5, total: 10 }));
    samples.take();
    samples.take();
    expect(samples.summary()).toBeNull();
  });
});

describe('годность записи', () => {
  it('обычный прогон годен', () => {
    expect(comparability(entry()).state).toBe(COMPARABLE);
    expect(comparability(entry()).reason).toBeNull();
  });

  it('замер на догоне помечен негодным и назван причиной', () => {
    // Ровно тот случай, ради которого всё затевалось: клиент догонял
    // историю, мир проиграл за окно втрое больше положенного, а число
    // кадров описало не отрисовку, а вставший главный поток.
    const verdict = comparability(
      entry({
        context: {
          'камера в движении': calmScene(),
          'войска на поле': calmScene({ tickTo: 640, syncTo: 635 }),
        },
      }),
    );

    expect(verdict.state).toBe(INCOMPARABLE);
    expect(verdict.reason).toContain('войска на поле');
    expect(verdict.reason).toContain('догон');
  });

  it('застывшая сверка делает запись негодной', () => {
    const verdict = comparability(
      entry({ context: { 'камера в движении': calmScene({ syncFrom: 275, syncTo: 275 }) } }),
    );

    expect(verdict.state).toBe(INCOMPARABLE);
    expect(verdict.reason).toContain('сверка стояла');
  });

  it('нагрузка ЗА прогон делает запись негодной, а тихое начало её не спасает', () => {
    // Та самая запись из журнала: занятость до прогона 24% — ниже порога,
    // то есть начинать было можно, — а под конец машину заняли, и числа
    // вышли вдвое ниже. Сегодня такую запись отличить не от чего.
    const verdict = comparability(entry({ busy: 0.24, busyMedian: 0.71, busyMax: 0.98 }));

    expect(verdict.state).toBe(INCOMPARABLE);
    expect(verdict.reason).toContain('занятость за прогон');
  });

  it('признак годности не совпадает с исходом прогона', () => {
    // Две ветки, ради которых пометка и отделена от порога.
    // «Упал» — утверждение о коде, «негоден» — о самом замере,
    // и смешивать их нельзя.
    const failedButHonest = entry({
      passed: false,
      measurements: { 'камера в движении': 41, 'войска на поле': 39 },
    });
    expect(comparability(failedButHonest).state).toBe(COMPARABLE);

    const passedButMeaningless = entry({
      passed: true,
      context: { 'камера в движении': calmScene({ tickTo: 700, syncTo: 695 }) },
    });
    expect(comparability(passedButMeaningless).state).toBe(INCOMPARABLE);
  });

  it('запись старого образца негодной не считается', () => {
    // Обстановки в ней нет вовсе, значит нет и данных для вывода
    // «негоден». Проставить их задним числом неоткуда, и проставленное
    // было бы выдумкой, неотличимой от измерения.
    const old = entry();
    delete old.context;
    delete old.busyMedian;
    delete old.busyMax;

    const verdict = comparability(old);
    expect(verdict.state).toBe(NO_CONTEXT);
    expect(verdict.state).not.toBe(INCOMPARABLE);
  });

  it('замер стоимости тика негодным не становится', () => {
    // Матча у него не бывает вовсе: ни браузера, ни сервера. Отсутствие
    // обстановки здесь — свойство замера, а не беда прогона.
    const tick = { kind: 'тик', busy: 0.23, passed: true, measurements: { 'тик, мкс': 202.5 } };
    expect(comparability(tick).state).toBe(NO_CONTEXT);
  });
});
