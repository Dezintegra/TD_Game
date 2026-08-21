import { describe, expect, it } from 'vitest';
import { CommandKind, StructureKind, UnitType, asPlayerId } from '@td/shared';
import type { PlayerId } from '@td/shared';
import { createWorld, playerStats } from '@td/sim';
import type { WorldState } from '@td/sim';
import { approachOf, otherPlayer } from './approach.js';
import { createOpponent } from './opponent.js';
import { BASELINE_PROFILE } from './profile.js';
import { waveOutcome, waveType } from './push.js';

/**
 * Добивающий рывок.
 *
 * Проверяется два свойства и одно следствие: волна считается целиком,
 * а не по машине; состав однороден и выбирается по обстановке; заказ
 * уходит одним решением, а не растягивается на пять секунд.
 */

const SEED = 20260821;
const ME: PlayerId = asPlayerId(1);

const statsOf = (world: WorldState, player: PlayerId) => {
  const state = world.players[player];
  if (state === undefined) throw new Error('нет игрока');
  return playerStats(state);
};

const approachFor = (world: WorldState) => {
  const approach = approachOf(world, ME);
  if (approach === undefined) throw new Error('вероятный путь не посчитан');
  return approach;
};

/** Мир, где у игрока много энергии, а чужая база почти разрушена. */
const almostWon = (energy: number, baseHealth: number): WorldState => {
  const world = createWorld(SEED);

  return {
    ...world,
    players: world.players.map((player, index) =>
      index === ME ? { ...player, energy } : player,
    ),
    structures: world.structures.map((structure) =>
      structure.kind === StructureKind.Base && structure.owner !== ME
        ? { ...structure, health: baseHealth }
        : structure,
    ),
  };
};

describe('волна считается целиком, а не по машине', () => {
  it('вдвое большая волна теряет на дороге ту же величину здоровья', () => {
    // Башня стреляет по одному юниту за раз, поэтому её урон вычитается
    // из общего здоровья волны. Отсюда и берётся смысл рывка: волна
    // из двадцати машин доходит там, где ручеёк из двадцати одиночек
    // гибнет весь.
    const world = createWorld(SEED);
    const stats = statsOf(world, ME);
    const enemyStats = statsOf(world, otherPlayer(ME) as PlayerId);
    const approach = approachFor(world);

    const single = waveOutcome(
      world,
      ME,
      stats,
      enemyStats,
      approach,
      BASELINE_PROFILE,
      UnitType.Assault,
      10,
    );
    const double = waveOutcome(
      world,
      ME,
      stats,
      enemyStats,
      approach,
      BASELINE_PROFILE,
      UnitType.Assault,
      20,
    );

    // Потери одинаковы, значит доходит не вдвое больше, а вдвое больше
    // плюс сэкономленное.
    const lostSingle = 10 - single.survivors;
    const lostDouble = 20 - double.survivors;

    expect(lostDouble).toBe(lostSingle);
  });

  it('пустая волна ничего не снимает', () => {
    const world = createWorld(SEED);
    const outcome = waveOutcome(
      world,
      ME,
      statsOf(world, ME),
      statsOf(world, otherPlayer(ME) as PlayerId),
      approachFor(world),
      BASELINE_PROFILE,
      UnitType.Assault,
      0,
    );

    expect(outcome).toEqual({ damage: 0, survivors: 0 });
  });

  it('без обороны время у базы упирается в горизонт, а не в бесконечность', () => {
    // Иначе ворота открыла бы одна-единственная машина: делённое на ноль
    // время бесконечно, а с ним бесконечен и снятый урон.
    const world = createWorld(SEED);
    const outcome = waveOutcome(
      world,
      ME,
      statsOf(world, ME),
      statsOf(world, otherPlayer(ME) as PlayerId),
      approachFor(world),
      BASELINE_PROFILE,
      UnitType.Assault,
      1,
    );

    expect(Number.isFinite(outcome.damage)).toBe(true);
  });
});

describe('состав волны однороден и выбран по обстановке', () => {
  const stats = statsOf(createWorld(SEED), ME);

  it('при прикрытом пути берётся тот, кто вскрывает башни', () => {
    // Гранатомётчик достаёт дальше башни и наносит постройкам полный
    // урон — только он умеет снимать оборону, не входя в её круг.
    expect(waveType(stats, true)).toBe(UnitType.Grenadier);
  });

  it('при чистом пути берётся самый дешёвый по урону за энергию', () => {
    expect(waveType(stats, false)).toBe(UnitType.Assault);
  });

  it('снайпер не выбирается никогда', () => {
    // Десятая часть урона по постройкам при двойной цене: против базы
    // он бесполезен вдесятеро.
    expect(waveType(stats, true)).not.toBe(UnitType.Sniper);
    expect(waveType(stats, false)).not.toBe(UnitType.Sniper);
  });
});

describe('залп уходит одним решением', () => {
  const trainCount = (world: WorldState): number =>
    createOpponent(ME, SEED)
      .decide(world)
      .filter((command) => command.kind === CommandKind.TrainUnit).length;

  it('при открытых воротах заказывается вся волна сразу', () => {
    // Правило «одна покупка за решение» принадлежит противнику,
    // а не правилам игры: ядро принимает сколько угодно команд за тик.
    expect(trainCount(almostWon(10_000_000, 500))).toBeGreaterThan(1);
  });

  it('при целой базе рывок не начинается', () => {
    // Ворота почти всегда закрыты, и это правильный ответ: одной волной
    // базу с полным здоровьем не взять, и притворяться иначе незачем.
    expect(trainCount(almostWon(10_000_000, 50_000))).toBeLessThanOrEqual(1);
  });

  it('без энергии рывок не начинается даже при добитой базе', () => {
    expect(trainCount(almostWon(0, 100))).toBe(0);
  });
});
