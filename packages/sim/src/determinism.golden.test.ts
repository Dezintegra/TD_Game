import { describe, expect, it } from 'vitest';
import { CommandKind, asPlayerId, asTickNumber, cellsToUnits, vec2 } from '@td/shared';
import type { Command } from '@td/shared';
import { createWorld } from './world.js';
import { step } from './step.js';
import { checksum } from './checksum.js';

/**
 * Golden-тест детерминизма — главный страж честного PvP.
 *
 * Идея простая: прогоняем симуляцию строго заданное число тиков с
 * фиксированным seed и фиксированной записью команд, а итоговую
 * контрольную сумму сравниваем с эталоном, записанным в этом файле.
 *
 * Что он ловит:
 *   - случайно просочившийся Math.random или Date.now в ядре;
 *   - зависимость от порядка перебора ключей объекта;
 *   - незаявленное изменение игровых правил.
 *
 * Если тест упал, а поведение менялось намеренно — эталон нужно обновить
 * тем же коммитом, что и правку правил. Тогда история изменений баланса
 * видна в diff, а не теряется.
 */

const GOLDEN_SEED = 1337;
const GOLDEN_TICKS = 1000;

/** Воспроизводимая запись команд: команда выдаётся по номеру тика, без случайности. */
const scriptedCommands = (tick: number): Command[] => {
  if (tick % 50 !== 0) return [];

  const slot = tick / 50;
  return [
    {
      kind: CommandKind.PlaceTower,
      player: asPlayerId(slot % 2),
      tick: asTickNumber(tick),
      position: vec2(cellsToUnits(slot % 12), cellsToUnits(slot % 8)),
      towerType: slot % 3,
    },
  ];
};

const runGolden = (): number => {
  let world = createWorld(GOLDEN_SEED);
  for (let tick = 0; tick < GOLDEN_TICKS; tick += 1) {
    world = step(world, scriptedCommands(tick));
  }
  return checksum(world);
};

describe('детерминизм симуляции', () => {
  it('два прогона в одном процессе дают одинаковую контрольную сумму', () => {
    expect(runGolden()).toBe(runGolden());
  });

  it('совпадает с эталонной контрольной суммой', () => {
    // Эталон вычислен на исходной реализации ядра.
    // Меняйте его ТОЛЬКО вместе с намеренным изменением игровых правил,
    // и тем же коммитом — тогда история баланса видна в diff.
    const GOLDEN_CHECKSUM = 3784177154;

    expect(runGolden()).toBe(GOLDEN_CHECKSUM);
  });

  it('различает состояния, отличающиеся одним полем', () => {
    const world = createWorld(GOLDEN_SEED);
    const modified = { ...world, tick: asTickNumber(1) };

    expect(checksum(world)).not.toBe(checksum(modified));
  });
});
