import { describe, expect, it } from 'vitest';
import { TICKS_PER_SECOND } from '../packages/shared/src/constants.ts';
import {
  COMPARABLE,
  INCOMPARABLE,
  NO_CONTEXT,
  WORLD_TICKS_PER_SECOND,
  busySamples,
  comparability,
  historyLines,
  lastComparable,
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
  commit: '7969969',
  // Числа настоящие — из прогона 25.08.2026 на тихой машине. Занятость
  // за прогон вдвое выше занятости до него, потому что в неё входит
  // сам замер: Playwright, Chromium, свой клиент и свой сервер.
  busy: 0.07,
  busyMedian: 0.32,
  busyMax: 0.6,
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

  it('своя же цена замера негодным его не делает', () => {
    // Замер стоит машине 31-32% (два прогона 25.08.2026 на тихой машине).
    // Порог допуска в 35% мерился, когда ничего этого не запущено, и оставь
    // его здесь — обычный прогон объявлялся бы негодным от любого шороха
    // рядом. Порог за прогон поэтому свой: величина другая, число другое.
    expect(comparability(entry({ busy: 0.06, busyMedian: 0.32, busyMax: 1 })).state).toBe(
      COMPARABLE,
    );
    expect(comparability(entry({ busy: 0.07, busyMedian: 0.31, busyMax: 0.6 })).state).toBe(
      COMPARABLE,
    );
  });

  it('занятость ДО прогона выше порога допуска делает запись негодной', () => {
    // Форсированный прогон на занятой машине. Ключ --force сам решением
    // не служит, а вот измеренная занятость — служит.
    const verdict = comparability(entry({ busy: 0.86, busyMedian: 0.9, forced: true }));

    expect(verdict.state).toBe(INCOMPARABLE);
    expect(verdict.reason).toContain('до прогона');
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

describe('выбор «было»', () => {
  it('прогон под нагрузкой основанием не становится', () => {
    const journal = [
      entry({ at: '2026-08-25T11:06:17Z', commit: 'c24ae2c', busyMedian: 0.26 }),
      entry({ at: '2026-08-25T11:12:58Z', commit: 'c24ae2c', busyMedian: 0.65 }),
      entry({ at: '2026-08-25T11:14:57Z', commit: 'bc6079c', busyMedian: 0.86 }),
      entry({ at: '2026-08-25T11:18:22Z', commit: 'bc6079c', busyMedian: 0.76 }),
      entry({ at: '2026-08-25T11:24:04Z', commit: 'bc6079c', busyMedian: 1 }),
    ];

    const { entry: basis, skipped } = lastComparable('кадры', journal);

    expect(basis.at).toBe('2026-08-25T11:06:17Z');
    expect(skipped).toBe(4);
  });

  it('негодная запись основанием не становится', () => {
    const journal = [
      entry({ at: '2026-08-25T11:06:17Z' }),
      entry({
        at: '2026-08-25T11:12:58Z',
        context: { 'камера в движении': calmScene({ tickTo: 640, syncTo: 635 }) },
      }),
    ];

    expect(lastComparable('кадры', journal).entry.at).toBe('2026-08-25T11:06:17Z');
  });

  it('замер другого вида основанием не становится', () => {
    const journal = [
      entry({ at: '2026-08-25T11:06:17Z' }),
      { kind: 'тик', at: '2026-08-25T12:16:32Z', busy: 0.23, measurements: { 'тик, мкс': 202.5 } },
    ];

    expect(lastComparable('кадры', journal).entry.at).toBe('2026-08-25T11:06:17Z');
  });

  it('сопоставимого нет — так и говорится, а не берётся что попало', () => {
    const journal = [
      entry({ at: '2026-08-25T11:12:58Z', busyMedian: 0.65 }),
      entry({ at: '2026-08-25T11:24:04Z', busyMedian: 1 }),
    ];

    const { entry: basis, skipped } = lastComparable('кадры', journal);
    expect(basis).toBeUndefined();
    expect(skipped).toBe(2);
  });

  it('тихая запись старого образца основанием остаётся', () => {
    // Обстановки в ней нет, но занятость записана и была тихой. Это
    // честное «было» по кадрам — просто оно не расскажет, чем занимался
    // мир. Объявлять её негодной было бы выводом из отсутствия данных.
    const old = entry({ at: '2026-08-25T10:57:08Z', busy: 0.11 });
    delete old.context;
    delete old.busyMedian;
    delete old.busyMax;

    const { entry: basis } = lastComparable('кадры', [old]);
    expect(basis).toBe(old);
    expect(comparability(basis).state).toBe(NO_CONTEXT);
  });

  it('настоящий кусок журнала от 25.08.2026: четыре прогона под нагрузкой пропущены', () => {
    // Записи скопированы из `.perf-log.jsonl` как есть. Журнал лежит вне
    // репозитория — он говорит об этой машине и о том, чем она была
    // занята в ту минуту, — поэтому кусок перенесён сюда, а не читается
    // с диска: иначе проверка зависела бы от того, кто её запускает.
    //
    // Все шесть записей старого образца: обстановки в них нет вовсе,
    // и отсеиваются они одной лишь занятостью.
    const real = [
      {
        at: '2026-08-25T11:06:17.577Z',
        kind: 'кадры',
        commit: 'c24ae2c',
        busy: 0.26,
        passed: true,
      },
      {
        at: '2026-08-25T11:12:58.131Z',
        kind: 'кадры',
        commit: 'c24ae2c',
        busy: 0.65,
        passed: true,
      },
      {
        at: '2026-08-25T11:14:57.889Z',
        kind: 'кадры',
        commit: 'bc6079c',
        busy: 0.86,
        passed: true,
      },
      {
        at: '2026-08-25T11:18:22.370Z',
        kind: 'кадры',
        commit: 'bc6079c',
        busy: 0.76,
        passed: false,
      },
      {
        at: '2026-08-25T11:20:29.899Z',
        kind: 'кадры',
        commit: 'bc6079c',
        busy: 0.24,
        passed: false,
      },
      { at: '2026-08-25T11:24:04.803Z', kind: 'кадры', commit: 'bc6079c', busy: 1, passed: false },
    ];

    const { entry: basis } = lastComparable('кадры', real);

    // Ни одна из четырёх записей с занятостью 0,65–1,00 основанием
    // не стала — ради этого всё и затевалось.
    expect([0.65, 0.86, 0.76, 1]).not.toContain(basis.busy);
    expect(basis.busy).toBeLessThanOrEqual(0.35);

    // Выбралась запись 11:20 с занятостью 0,24 — та самая, что дала
    // 50 и 25 к/с. Это названный предел выбранного правила
    // (`design.md`, раздел 6, вариант В): по числу «до прогона» она
    // тихая, и отличить её сегодня не от чего. Именно поэтому
    // изменение и заводит наблюдение за нагрузкой ВО ВРЕМЯ прогона:
    // у записи нового образца такой лазейки уже нет.
    expect(basis.at).toBe('2026-08-25T11:20:29.899Z');
  });
});

describe('история переживает пополнение журнала', () => {
  it('запись старого образца печатается без undefined и NaN', () => {
    // Сорок с лишним таких записей уже накоплено, и переписывать
    // их некуда: обстановку тех прогонов никто не снимал, а любое
    // проставленное задним числом значение было бы выдумкой,
    // неотличимой от измерения.
    const old = {
      at: '2026-08-25T10:57:08.000Z',
      kind: 'кадры',
      commit: 'c24ae2c',
      busy: 0.11,
      passed: true,
      measurements: { 'камера в движении': 60, 'войска на поле': 60 },
    };

    const printed = historyLines(old).join('\n');

    expect(printed).not.toContain('undefined');
    expect(printed).not.toContain('NaN');
    expect(printed).toContain('занятость 11%');
    // Ни про нагрузку за прогон, ни про негодность в такой записи
    // сказать нечего — значит и не говорится.
    expect(printed).not.toContain('за прогон');
    expect(printed).not.toContain('НЕГОДЕН');
  });

  it('запись нового образца показывает обстановку и нагрузку за прогон', () => {
    const printed = historyLines(entry({ at: '2026-08-25T13:43:26.000Z' })).join('\n');

    expect(printed).not.toContain('undefined');
    expect(printed).not.toContain('NaN');
    expect(printed).toContain('за прогон 32%');
    expect(printed).toContain('мир 30 тик/с');
    expect(printed).toContain('связь 14 мс');
  });

  it('негодная запись показывается вместе с причиной', () => {
    const printed = historyLines(
      entry({
        at: '2026-08-25T13:43:26.000Z',
        context: { 'войска на поле': calmScene({ tickTo: 640, syncTo: 635 }) },
      }),
    ).join('\n');

    expect(printed).toContain('НЕГОДЕН ДЛЯ СРАВНЕНИЯ');
    expect(printed).toContain('догон');
  });

  it('принудительный прогон в истории видно', () => {
    const printed = historyLines(entry({ at: '2026-08-25T13:43:26.000Z', forced: true })).join(
      '\n',
    );
    expect(printed).toContain('--force');
  });

  it('полупустая обстановка не выдаёт прочерки за числа', () => {
    // Строка не должна ломаться и на записи, где часть полей
    // почему-то не дошла: прочерк честнее «undefined».
    const printed = historyLines(
      entry({ at: '2026-08-25T13:43:26.000Z', context: { 'камера в движении': { windowMs: 0 } } }),
    ).join('\n');

    expect(printed).not.toContain('undefined');
    expect(printed).not.toContain('NaN');
    expect(printed).toContain('ход мира неизвестен');
  });
});
