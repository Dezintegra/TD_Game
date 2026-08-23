import { describe, expect, it } from 'vitest';
import { CommandKind, StructureKind, TICKS_PER_SECOND, UnitType, asPlayerId } from '@td/shared';
import type { Command } from '@td/shared';
import { createWorld, step } from '@td/sim';
import { createOpponent } from './opponent.js';
import {
  BASELINE_PROFILE,
  FORTRESS_PROFILE,
  SIEGE_PROFILE,
  SWARM_PROFILE,
  reserveOf,
} from './profile.js';
import type { AiProfile, PhaseProfile } from './profile.js';
import type { DecisionRecord } from './observer.js';

/**
 * Три способности, которых у противника не было: снайперская башня,
 * Тесла и волна.
 *
 * Проверяются поведением в настоящем матче, а не вызовом внутренних
 * функций. Причина та же, по которой заведена арена: намерение противника
 * складывается из полудюжины решений подряд, и проверка отдельной функции
 * доказывает работоспособность функции, а не поведение.
 */

const AI = asPlayerId(0);
const RIVAL = asPlayerId(1);
const SEED = 4242;

interface Played {
  readonly commands: readonly Command[];
  readonly records: readonly DecisionRecord[];
}

/**
 * Матч с настоящим соперником, а не в пустоте.
 *
 * Соперник обязателен, и это выяснилось падением. В матче против
 * бездействующей стороны крепость не поставила ни одной снайперской
 * башни, а осадный не купил ни одной Теслы — при том, что в чемпионате
 * из 240 матчей та же крепость ставит по пять башен за матч, а осадный
 * покупает по три Теслы. Причина в том, что обе покупки дорогие,
 * а решение о дорогой покупке зависит от обстановки: от того, где стоит
 * генерал, что ему угрожает и на что уже потрачена казна. Пустое поле —
 * это не «тот же матч без помех», это другая игра.
 */
const play = (profile: AiProfile, seconds: number): Played => {
  const commands: Command[] = [];
  const records: DecisionRecord[] = [];

  const mine = createOpponent(AI, SEED, profile, (record) => {
    records.push(record);
  });
  const rival = createOpponent(RIVAL, SEED + 1, BASELINE_PROFILE);

  let world = createWorld(SEED);
  for (let tick = 0; tick < seconds * TICKS_PER_SECOND; tick += 1) {
    const issued = mine.decide(world);
    commands.push(...issued);
    world = step(world, [...issued, ...rival.decide(world)]);
  }

  return { commands, records };
};

const built = (played: Played, kind: StructureKind): number =>
  played.commands.filter(
    (command) => command.kind === CommandKind.Build && command.structure === kind,
  ).length;

const trained = (played: Played, type: UnitType): number =>
  played.commands.filter(
    (command) => command.kind === CommandKind.TrainUnit && command.unitType === type,
  ).length;

describe('вид башни задаётся весами профиля', () => {
  // Один матч на обе проверки: они об одном и том же прогоне, а считается
  // он семь секунд. Длина взята с запасом — снайперская башня стоит
  // пятнадцать секунд дохода, и до первой покупки проходит несколько минут
  // игры; в чемпионате крепость ставит по пять башен за матч в шесть минут.
  const fortress = play(FORTRESS_PROFILE, 420);

  it('крепостной профиль строит снайперские башни', () => {
    expect(built(fortress, StructureKind.TowerSniper)).toBeGreaterThan(0);
  });

  it('нулевой вес запрещает вид начисто', () => {
    // У крепостного вес базовой башни — ноль. Ни одной за матч.
    expect(built(fortress, StructureKind.TowerBasic)).toBe(0);
  });

  it('профиль по умолчанию снайперских башен не строит', () => {
    // Прежнее поведение: вид башни был зашит в базовую.
    const played = play(BASELINE_PROFILE, 420);

    expect(built(played, StructureKind.TowerSniper)).toBe(0);
    expect(built(played, StructureKind.TowerBasic)).toBeGreaterThan(0);
  });
});

describe('состав войска доходит до Теслы', () => {
  it('осадный профиль заказывает Теслу', () => {
    // Ради этого и заведён горизонт накопления в полтораста секунд: Тесла
    // стоит двадцать пять секунд дохода, и при базовом терпении желание
    // объявляется недостижимым.
    const played = play(SIEGE_PROFILE, 420);

    expect(trained(played, UnitType.Tesla)).toBeGreaterThan(0);
  });

  it('профиль по умолчанию Теслу не заказывает', () => {
    const played = play(BASELINE_PROFILE, 420);

    expect(trained(played, UnitType.Tesla)).toBe(0);
  });
});

describe('волна отправляется, когда её хватает', () => {
  it('роевой профиль совершает рывок', () => {
    const played = play(SWARM_PROFILE, 420);

    expect(played.records.some((record) => record.pushed)).toBe(true);
  });

  it('рывок заказывает волну целиком, а не по машине', () => {
    const played = play(SWARM_PROFILE, 420);

    // Тик рывка отличается от прочих числом заказов: обычное производство
    // покупает не больше одной машины за решение.
    const byTick = new Map<number, number>();
    for (const command of played.commands) {
      if (command.kind !== CommandKind.TrainUnit) continue;
      byTick.set(command.tick, (byTick.get(command.tick) ?? 0) + 1);
    }

    const biggest = Math.max(...byTick.values());
    expect(biggest).toBeGreaterThanOrEqual(SWARM_PROFILE.push.waveSize);
  });

  it('профиль по умолчанию рывка не совершает', () => {
    // Доля, равная единице, означает «волна обязана снести базу целиком»,
    // а это невыполнимо арифметически. Прежнее поведение сохранено.
    const played = play(BASELINE_PROFILE, 420);

    expect(played.records.some((record) => record.pushed)).toBe(false);
  });
});

describe('запас под волну', () => {
  const phase = (reserve: PhaseProfile['reserve']): PhaseProfile => ({
    ...(BASELINE_PROFILE.phases[0] as PhaseProfile),
    reserve,
  });

  it('держится, пока достижим', () => {
    const wavePrice = 1000;
    const income = 10;

    expect(reserveOf(phase('wave'), income, BASELINE_PROFILE, wavePrice)).toBe(wavePrice);
  });

  it('недостижимый не держится', () => {
    // Иначе запас запрещал бы не крупные траты, а вообще все: цена ЛЮБОЙ
    // покупки складывается с ним.
    const unreachable = 10_000_000;

    expect(reserveOf(phase('wave'), 10, BASELINE_PROFILE, unreachable)).toBe(0);
  });

  it('без запаса фазы цена волны ничего не меняет', () => {
    expect(reserveOf(phase('none'), 10, BASELINE_PROFILE, 1000)).toBe(0);
  });
});
