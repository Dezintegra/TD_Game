import {
  COUNT_BOUNDS,
  COUNT_BUDGET,
  JUMP_BOUNDS_CELLS,
  createHistogram,
  unitsToCells,
} from '@td/shared';
import type { HistogramSnapshot } from '@td/shared';

/**
 * Прибор скачков: насколько генерал уехал сверх того, что мог пройти.
 *
 * Игрок описал беду так: генерал дёргается, и в этот момент справа
 * сверху мигает «в пути 1–2». Первая половина — это и есть скачок,
 * вторая — очередь своих неподтверждённых команд. Прибор считает обе
 * сразу, и в этом весь смысл: очередь снимается **в момент скачка**,
 * а не по расписанию. Снятая равномерно, она показала бы средний размер
 * очереди за матч, в котором скачки размыты.
 *
 * **Как отличить скачок от движения.** Генерал не может пройти больше
 * `speed` внутренних единиц по каждой оси за такт: шаг считается
 * по осям отдельно и каждый ограничен скоростью (`movement.ts`).
 * Всё сверх `speed × Δтакт` — не движение, а поправка: показанное
 * разошлось с подтверждённым.
 *
 * **Почему по осям, а не по прямой.** По диагонали прямое расстояние
 * доходит до `speed × √2`, и порог по прямой пришлось бы задирать,
 * теряя чувствительность. Порог по осям точен.
 *
 * **Почему только когда показываемый тик сдвинулся.** Показ
 * пересобирается и от собственной команды — нажал клавишу, и генерал
 * в том же кадре поехал. Это разрыв в положении, но разрыв желанный:
 * ровно за него игра и держится. Считать его скачком значило бы мерить
 * отзывчивость и называть её бедой.
 */
export interface JumpGauge {
  /**
   * Показываемое состояние обновилось.
   *
   * Положение и скорость — во внутренних единицах, скорость берётся
   * с учётом прокачки: постоянная из баланса дала бы ложные телепорты
   * у прокачанного генерала.
   */
  observe(
    tick: number,
    x: number,
    y: number,
    speedUnitsPerTick: number,
    pendingCommands: number,
  ): void;
  /** Превышения, в клетках. */
  jumps(): HistogramSnapshot;
  /** Сколько своих команд было в пути в момент скачка. */
  pending(): HistogramSnapshot;
}

export const createJumpGauge = (): JumpGauge => {
  const jumps = createHistogram({ bounds: JUMP_BOUNDS_CELLS, budget: COUNT_BUDGET });
  const pending = createHistogram({ bounds: COUNT_BOUNDS, budget: COUNT_BUDGET });

  let seenTick = -1;
  let seenX = 0;
  let seenY = 0;

  return {
    observe(tick, x, y, speedUnitsPerTick, pendingCommands) {
      const elapsed = tick - seenTick;
      const first = seenTick < 0;

      // Тик не сдвинулся — это пересборка показа, а не новый тик мира.
      // Сравнивать нечего, и запоминать заново тоже: точка отсчёта
      // должна остаться на том тике, с которого мерим.
      if (!first && elapsed <= 0) return;

      if (!first) {
        const allowed = speedUnitsPerTick * elapsed;
        const excess = Math.max(Math.abs(x - seenX) - allowed, Math.abs(y - seenY) - allowed);

        if (excess > 0) {
          jumps.add(unitsToCells(excess));
          pending.add(pendingCommands);
        }
      }

      seenTick = tick;
      seenX = x;
      seenY = y;
    },

    jumps: () => jumps.snapshot(),
    pending: () => pending.snapshot(),
  };
};
