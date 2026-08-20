import { describe, expect, it } from 'vitest';
import {
  CommandKind,
  MAP_WIDTH_CELLS,
  StructureKind,
  UPGRADE_BRANCHES,
  asPlayerId,
  asTickNumber,
} from '@td/shared';
import type { Command, UnitType } from '@td/shared';
import { createWorld } from './world.js';
import { step } from './step.js';
import { checksum } from './checksum.js';
import { cellIndex } from './map.js';

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
const GOLDEN_TICKS = 1200;

/** Базы стоят в противоположных углах; клетки рядом с ними известны заранее. */
const BASE_INSET = 6;

/**
 * Воспроизводимая запись команд.
 *
 * Сценарий задействует все механики сразу: движение генерала,
 * строительство, производство юнитов всех типов, прокачку и ядерный удар.
 * Чем шире охват, тем больше шансов, что случайно просочившийся источник
 * недетерминизма изменит итоговую сумму.
 */
const scriptedCommands = (tick: number): Command[] => {
  const commands: Command[] = [];

  for (const player of [0, 1]) {
    const near = player === 0 ? BASE_INSET + 2 : MAP_WIDTH_CELLS - 1 - BASE_INSET - 2;
    const side = player === 0 ? 1 : -1;

    // Генерал меняет направление раз в пару секунд: движение обязано
    // быть воспроизводимым, включая упоры в препятствия.
    //
    // Деление здесь и ниже обязательно целочисленное. Обычное `tick / 60`
    // даёт дробь, а дробный индекс направления или типа юнита ядро молча
    // отклоняет — и сценарий незаметно превращается в пустой прогон.
    if (tick % 60 === player * 10) {
      commands.push({
        kind: CommandKind.MoveGeneral,
        player: asPlayerId(player),
        tick: asTickNumber(tick),
        direction: (Math.floor(tick / 60) % 8) + 1,
      });
    }

    // Постройки вокруг базы: стены и башни вперемешку.
    if (tick % 90 === 30 + player * 5) {
      const offset = Math.floor(tick / 90) % 3;
      commands.push({
        kind: CommandKind.Build,
        player: asPlayerId(player),
        tick: asTickNumber(tick),
        cell: cellIndex(near, near + side * offset),
        structure: offset === 0 ? StructureKind.Wall : StructureKind.TowerBasic,
      });
    }

    // Производство: три типа по кругу.
    if (tick % 40 === 10 + player * 3) {
      const type = (Math.floor(tick / 40) % 3) as UnitType;
      commands.push({
        kind: CommandKind.TrainUnit,
        player: asPlayerId(player),
        tick: asTickNumber(tick),
        unitType: type,
      });
    }

    // Прокачка: перебираем ветки по кругу.
    if (tick % 70 === 20 + player * 7) {
      commands.push({
        kind: CommandKind.BuyUpgrade,
        player: asPlayerId(player),
        tick: asTickNumber(tick),
        branch: Math.floor(tick / 70) % UPGRADE_BRANCHES.length,
      });
    }

    // Ядерный удар в середину карты — единственная точка, гарантированно
    // лежащая вне запретной зоны обеих баз.
    if (tick === 900 + player * 30) {
      commands.push({
        kind: CommandKind.LaunchNuke,
        player: asPlayerId(player),
        tick: asTickNumber(tick),
        cell: cellIndex(48, 48),
      });
    }
  }

  return commands;
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
    // Эталон вычислен на реализации боевого ядра из изменения
    // add-combat-and-ai. Меняйте его ТОЛЬКО вместе с намеренным
    // изменением игровых правил, и тем же коммитом — тогда история
    // баланса видна в diff.
    const GOLDEN_CHECKSUM = 1657636765;

    expect(runGolden()).toBe(GOLDEN_CHECKSUM);
  });

  it('сценарий действительно доводит дело до боя', () => {
    // Страховка от вырождения: если сценарий перестанет что-либо делать,
    // сумма всё равно будет стабильной, и тест начнёт охранять пустоту.
    let world = createWorld(GOLDEN_SEED);
    for (let tick = 0; tick < GOLDEN_TICKS; tick += 1) {
      world = step(world, scriptedCommands(tick));
    }

    expect(world.structures.length).toBeGreaterThan(2);
    expect(world.units.length).toBeGreaterThan(0);
  });

  it('различает состояния, отличающиеся одним полем', () => {
    const world = createWorld(GOLDEN_SEED);
    const modified = { ...world, tick: asTickNumber(1) };

    expect(checksum(world)).not.toBe(checksum(modified));
  });
});
