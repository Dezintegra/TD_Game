import { step } from '@td/sim';
import type { Command } from '@td/shared';
import type { WorldState } from '@td/sim';

/**
 * Разложить команды по тикам, на которых они исполняются.
 *
 * Список команд приходит плоским — и из истории матча, и из кадра, —
 * а симуляции нужен ровно тот набор, что относится к текущему тику.
 */
export const byTick = (commands: readonly Command[]): Map<number, Command[]> => {
  const map = new Map<number, Command[]>();

  for (const command of commands) {
    const list = map.get(command.tick);
    if (list === undefined) {
      map.set(command.tick, [command]);
    } else {
      list.push(command);
    }
  }

  return map;
};

/**
 * Прокрутить мир от его текущего тика до `throughTick` включительно,
 * подавая на каждый тик его команды.
 *
 * Это и есть весь механизм догона: восстановление после разрыва,
 * пересборка при расхождении и обычное продвижение по кадрам — одна
 * и та же функция с разными аргументами. Ничего, кроме `step`, здесь
 * не происходит, и это принципиально: любой второй способ получить
 * состояние мира стал бы вторым набором правил.
 *
 * Мир по сети не передаётся. Передаются команды, а состояние каждая
 * сторона считает сама — отсюда и требование чистоты `step`.
 */
export const replayThrough = (
  world: WorldState,
  commands: Map<number, Command[]>,
  throughTick: number,
): WorldState => {
  let current = world;

  while (current.tick <= throughTick) {
    current = step(current, commands.get(current.tick) ?? []);
  }

  return current;
};
