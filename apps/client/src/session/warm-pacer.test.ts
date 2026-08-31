import { describe, expect, it } from 'vitest';
import { WARM_BUDGET_MS, startWarmPacer } from './warm-pacer.js';

/**
 * Стенд с рукотворными часами и рукотворным простоем.
 *
 * Настоящие часы сюда не годятся: проверка про то, сколько РАБОТЫ
 * прогрев себе позволил, а не про то, как быстро её делает эта машина.
 * Простой тоже свой — иначе проверка ждала бы браузера, которого в наборе
 * модульных тестов нет вовсе.
 */
const bench = (options: {
  /** Во что обходится один шаг запекания на этой воображаемой машине. */
  readonly stepCostMs: number;
  /** Сколько шагов в очереди. */
  readonly queue: number;
  readonly budgetMs?: number;
}) => {
  let clock = 0;
  let done = 0;
  let finished = false;
  const pending: ((deadline?: IdleDeadline) => void)[] = [];

  startWarmPacer({
    warm: () => {
      clock += options.stepCostMs;
      done += 1;

      return done < options.queue;
    },
    whenIdle: (run) => pending.push(run),
    now: () => clock,
    matchRunning: () => false,
    frameBudgetMs: 8,
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    onDone: () => {
      finished = true;
    },
  });

  // Прокручиваем простои, пока цикл сам не остановится. Потолок нужен
  // затем, чтобы не зациклиться, если остановка сломается: без него
  // сломанный распорядок вешал бы весь прогон вместо того, чтобы упасть.
  for (let guard = 0; guard < 10_000 && pending.length > 0; guard += 1) {
    pending.shift()?.();
  }

  return { done, spentMs: clock, finished, stillPending: pending.length };
};

describe('распорядок прогрева', () => {
  it('на быстрой машине проходит очередь целиком', () => {
    // Проектная цена запекания — тринадцать миллисекунд, базовый набор —
    // около двухсот комбинаций. Такая машина обязана прогреться вся:
    // бюджет заведён против слабых, а не против всех.
    const run = bench({ stepCostMs: 13, queue: 208 });

    expect(run.done).toBe(208);
    expect(run.spentMs).toBeLessThan(WARM_BUDGET_MS);
    expect(run.finished).toBe(true);
  });

  it('на слабой машине останавливается по бюджету, а не по очереди', () => {
    // Вшестеро медленнее — ровно то, что показал дроссель процессора
    // на runner'е GitHub. Прежний распорядок проходил тут всю очередь
    // и занимал главный поток на девять секунд.
    const run = bench({ stepCostMs: 78, queue: 208 });

    expect(run.done).toBeLessThan(208);
    expect(run.finished).toBe(true);
    // Перебор не больше одного шага: запекание неделимо, и остановиться
    // посреди него нельзя — но и переступать бюджет дважды не за что.
    expect(run.spentMs).toBeLessThan(WARM_BUDGET_MS + 78);
  });

  it('остановившись, больше простоя не занимает', () => {
    // Важно именно это: остановка обязана снять цикл с очереди простоев,
    // а не продолжать будиться вхолостую. Иначе «остановка» экономила бы
    // запекания и не экономила бы отзывчивость.
    const run = bench({ stepCostMs: 78, queue: 208 });

    expect(run.stillPending).toBe(0);
  });

  it('короткая очередь кончается сама, не дожидаясь бюджета', () => {
    const run = bench({ stepCostMs: 1, queue: 5 });

    expect(run.done).toBe(5);
    expect(run.finished).toBe(true);
  });
});
