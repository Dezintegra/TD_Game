import { describe, expect, it } from 'vitest';
import {
  CommandKind,
  MAP_HEIGHT_CELLS,
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
    // Смещение в три клетки, а не в две: вокруг базы появилось защищённое
    // кольцо, и с прежним смещением ближайшая постройка сценария — стена —
    // отклонялась всегда. Сценарий продолжал бы «проходить», охраняя
    // при этом мир без единой стены.
    const near = player === 0 ? BASE_INSET + 3 : MAP_WIDTH_CELLS - 1 - BASE_INSET - 3;
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
    //
    // Место выбирается веером из нескольких клеток, а не одной. Вокруг базы
    // есть и скалы, и защищённое кольцо, и одна фиксированная клетка легко
    // оказывается негодной — тогда сценарий молча перестаёт ставить
    // постройки этого вида, продолжая при этом «проходить». Лишние команды
    // ядро отклонит, а отказы в контрольную сумму не входят.
    if (tick % 90 === 30 + player * 5) {
      const shift = Math.floor(tick / 90) % 3;

      for (let dx = 0; dx < 3; dx += 1) {
        for (let dy = 0; dy < 3; dy += 1) {
          commands.push({
            kind: CommandKind.Build,
            player: asPlayerId(player),
            tick: asTickNumber(tick),
            cell: cellIndex(near + side * dx, near + side * dy),
            // Виды чередуются в шахматном порядке, а сдвиг меняет её от раза
            // к разу. Прежняя схема ставила один вид за раз в одну клетку,
            // и стоило клетке оказаться скалой — постройки этого вида
            // исчезали из сценария целиком.
            structure: (dx + dy + shift) % 2 === 0 ? StructureKind.Wall : StructureKind.TowerBasic,
          });
        }
      }
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
    // лежащая вне запретной зоны обеих баз. Координаты считаются от размера
    // карты, а не вписаны числом: карта уже однажды меняла размер, и тогда
    // вписанная точка молча уехала за её край, а удар — в никуда.
    if (tick === 900 + player * 30) {
      commands.push({
        kind: CommandKind.LaunchNuke,
        player: asPlayerId(player),
        tick: asTickNumber(tick),
        cell: cellIndex(MAP_WIDTH_CELLS / 2, MAP_HEIGHT_CELLS / 2),
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
    // Эталон вычислен на правилах из двух изменений сразу.
    //
    // slow-down-construction: время возведения выросло у всех трёх построек,
    // а прочность набирается по расписанию, а не прибавкой с округлением
    // вверх. protect-base-surroundings: вокруг каждой базы появилось кольцо,
    // в котором строить нельзя, и сценарий пришлось отодвинуть от базы —
    // с прежним смещением все его стены отклонялись.
    //
    // Предыдущие эталоны: 3677035819 — только slow-down-construction;
    // 519025619 — refine-targeting-and-ai-posture и add-detailed-models.
    //
    // Меняйте его ТОЛЬКО вместе с намеренным изменением игровых правил,
    // и тем же коммитом — тогда история баланса видна в diff.
    const GOLDEN_CHECKSUM = 3833150104;

    expect(runGolden()).toBe(GOLDEN_CHECKSUM);
  });

  it('сценарий действительно доводит дело до боя', () => {
    // Страховка от вырождения: если сценарий перестанет что-либо делать,
    // сумма всё равно будет стабильной, и тест начнёт охранять пустоту.
    let world = createWorld(GOLDEN_SEED);

    // Виды собираются за весь прогон, а не снимаются в конце. Башня
    // у базы вполне может не дожить до последнего тика — это законный ход
    // матча, а не вырождение сценария. Вырождение — это когда башню
    // ни разу не поставили.
    const seen = new Set<StructureKind>();

    for (let tick = 0; tick < GOLDEN_TICKS; tick += 1) {
      world = step(world, scriptedCommands(tick));
      for (const structure of world.structures) seen.add(structure.kind);
    }

    expect(world.structures.length).toBeGreaterThan(2);
    expect(world.units.length).toBeGreaterThan(0);

    // Виды названы поимённо. Общего счётчика мало: правило, отсекающее
    // ровно один вид построек, оставило бы счётчик прежним, и охват
    // сценария сузился бы молча.
    expect(seen.has(StructureKind.Wall)).toBe(true);
    expect(seen.has(StructureKind.TowerBasic)).toBe(true);
  });

  it('различает состояния, отличающиеся одним полем', () => {
    const world = createWorld(GOLDEN_SEED);
    const modified = { ...world, tick: asTickNumber(1) };

    expect(checksum(world)).not.toBe(checksum(modified));
  });
});
