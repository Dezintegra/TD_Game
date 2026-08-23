import { MS_PER_TICK } from './constants.js';

/**
 * Гистограмма длительностей.
 *
 * Заведена ради одного наблюдения: **среднее прячет ровно ту беду,
 * которую мы ищем.** Заминка в сорок миллисекунд дважды в секунду
 * и ровный такт в пять миллисекунд дают одинаковое среднее, а игроку
 * соответствуют разные игры. Минутные графики облака именно поэтому
 * ничего и не показали.
 *
 * Отсюда устройство: наблюдения копятся здесь, внутри процесса, где
 * форма распределения ещё известна, а наружу отдаются перцентили.
 * Опрашивать снимок можно хоть раз в минуту — от этого он не портится,
 * в отличие от среднего.
 *
 * Часов гистограмма не читает: ей передают уже посчитанную длительность.
 * Так она остаётся чистой и проверяется без подмены `performance`,
 * а заодно её можно держать в `@td/shared`, которому платформенные
 * вызовы недоступны.
 */

/**
 * Границы корзин для всего, что меряется бюджетом тика.
 *
 * Выведены из `MS_PER_TICK`, а не записаны числами: изменится темп
 * симуляции — границы обязаны поехать следом, иначе корзина «уложились»
 * начнёт означать что-то другое, и молча.
 *
 * Смысл границ: 16 — бюджет кадра при шестидесяти герцах, бюджет тика —
 * граница «успели или нет», дальше удвоения: потеряли два тика, четыре,
 * восемь.
 */
export const TICK_BUDGET_MS = MS_PER_TICK;

export const TIMING_BOUNDS_MS: readonly number[] = [
  1,
  2,
  4,
  8,
  16,
  TICK_BUDGET_MS,
  TICK_BUDGET_MS * 2,
  TICK_BUDGET_MS * 4,
  TICK_BUDGET_MS * 8,
];

export interface HistogramBucket {
  /** Верхняя граница корзины включительно. */
  readonly bound: number;
  /** Сколько наблюдений в неё попало. */
  readonly count: number;
}

export interface HistogramSnapshot {
  readonly count: number;
  readonly sum: number;
  /** Точный максимум, а не верхняя граница корзины: хвост и есть беда. */
  readonly max: number;
  /**
   * Сколько наблюдений превысило бюджет.
   *
   * Считается точным счётчиком, а не выводится из корзин: ответ на главный
   * вопрос не должен зависеть от того, удачно ли выбраны границы.
   */
  readonly overBudget: number;
  readonly buckets: readonly HistogramBucket[];
  /** Сверх последней границы. */
  readonly overflow: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface Histogram {
  add(value: number): void;
  /** Забыть накопленное. Нужно замерам «до и после» в одном процессе. */
  reset(): void;
  snapshot(): HistogramSnapshot;
}

export interface HistogramOptions {
  /** Границы корзин по возрастанию. */
  readonly bounds?: readonly number[];
  /** Что считается превышением. По умолчанию — длительность тика. */
  readonly budget?: number;
}

/**
 * Перцентиль по корзинам — оценка, а не точное значение.
 *
 * Внутри корзины наблюдения считаются распределёнными равномерно,
 * и ответ уточняется линейно. Ошибка не превышает ширины корзины,
 * и это осознанная плата: точный перцентиль потребовал бы хранить
 * все наблюдения, то есть неограниченную память в горячем пути.
 *
 * Там, где ошибка недопустима, смотреть надо на `max` и `overBudget` —
 * они точные.
 */
const percentileOf = (
  counts: readonly number[],
  bounds: readonly number[],
  overflow: number,
  max: number,
  total: number,
  fraction: number,
): number => {
  if (total === 0) return 0;

  const target = total * fraction;
  let seen = 0;

  for (let index = 0; index < bounds.length; index += 1) {
    const inBucket = counts[index] ?? 0;
    if (seen + inBucket < target) {
      seen += inBucket;
      continue;
    }

    const lower = index === 0 ? 0 : (bounds[index - 1] ?? 0);
    const upper = bounds[index] ?? 0;
    if (inBucket === 0) return upper;

    return lower + ((upper - lower) * (target - seen)) / inBucket;
  }

  // Искомое лежит за последней границей: там известен только максимум.
  return overflow > 0 ? max : (bounds[bounds.length - 1] ?? max);
};

export const createHistogram = (options: HistogramOptions = {}): Histogram => {
  const bounds = options.bounds ?? TIMING_BOUNDS_MS;
  const budget = options.budget ?? TICK_BUDGET_MS;

  const counts = new Array<number>(bounds.length).fill(0);
  let overflow = 0;
  let count = 0;
  let sum = 0;
  let max = 0;
  let overBudget = 0;

  return {
    add(value) {
      count += 1;
      sum += value;
      if (value > max) max = value;
      if (value > budget) overBudget += 1;

      for (let index = 0; index < bounds.length; index += 1) {
        if (value <= (bounds[index] ?? 0)) {
          counts[index] = (counts[index] ?? 0) + 1;
          return;
        }
      }

      overflow += 1;
    },

    reset() {
      counts.fill(0);
      overflow = 0;
      count = 0;
      sum = 0;
      max = 0;
      overBudget = 0;
    },

    snapshot() {
      return {
        count,
        sum,
        max,
        overBudget,
        overflow,
        buckets: bounds.map((bound, index) => ({ bound, count: counts[index] ?? 0 })),
        p50: percentileOf(counts, bounds, overflow, max, count, 0.5),
        p95: percentileOf(counts, bounds, overflow, max, count, 0.95),
        p99: percentileOf(counts, bounds, overflow, max, count, 0.99),
      };
    },
  };
};
