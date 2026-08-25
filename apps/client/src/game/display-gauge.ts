import { createHistogram } from '@td/shared';
import type { HistogramSnapshot } from '@td/shared';

/**
 * Прибор картинки: как двигается мир на экране.
 *
 * Соседний прибор — промежуток между приходами кадров команд — отвечает
 * на вопрос про канал. Этот отвечает на вопрос про глаза игрока,
 * и вопросы эти разные. Совпадают их ответы ровно до тех пор, пока
 * показываемый мир двигается приходом кадров; как только он начинает
 * двигаться своими часами, ряды расходятся — и в расхождении весь смысл.
 *
 * Мерится смена **тика**, а не вызов. Показываемый мир пересобирается
 * и от своей команды, и от кадра, не сдвинувшего показ; оба раза
 * картинка стоит на месте, и промежуток здесь был бы враньём.
 *
 * Время передаётся, а не читается изнутри — по той же причине, что
 * и в часах кадра: прибор остаётся чистой функцией от своих входов
 * и проверяется без подмены `performance`.
 */
export interface DisplayGauge {
  /** Показываемое состояние обновилось до этого тика. */
  observe(tick: number, nowMs: number): void;
  snapshot(): HistogramSnapshot;
}

export const createDisplayGauge = (): DisplayGauge => {
  const histogram = createHistogram();
  let shownTick = -1;
  let shownAtMs = Number.NaN;

  return {
    observe(tick, nowMs) {
      if (tick === shownTick) return;

      // Первый показанный тик промежутка не даёт: сравнивать не с чем.
      if (!Number.isNaN(shownAtMs)) histogram.add(nowMs - shownAtMs);

      shownTick = tick;
      shownAtMs = nowMs;
    },

    snapshot: () => histogram.snapshot(),
  };
};
