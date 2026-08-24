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

/**
 * Сколько игровых секунд отсматривают проверки поведения.
 *
 * Было 420 — «с запасом», и запас кончился. Залп генерала
 * (`give-the-general-a-salvo`) удлинил всё: по замеру арены на сорока
 * seed средний матч роя против базового вырос с 408 секунд до 697,
 * то есть игра впервые попала в проектную вилку 10–15 минут
 * (`docs/game-design.md`, раздел о балансе). Вместе с матчем сместился
 * и рывок: на этом seed первый приходится на 462-ю секунду — на сорок
 * две позже, чем кончалось прежнее окно.
 *
 * Шестьсот, а не пятьсот: замер даёт шесть рывков за матч и первый
 * на 462-й, но это ОДИН seed, а число здесь стережёт поведение
 * на любом. Две минуты сверху — тот же запас, что закладывался
 * изначально, только отсчитанный от измеренного срока, а не от
 * предполагаемого.
 *
 * Окно общее для рывка и для Теслы. Сдвинулся не рывок, а ВЕСЬ матч,
 * и покупка за двадцать пять секунд дохода уехала ровно так же:
 * на прежних 420 осадный профиль не успевал заказать ни одной машины.
 * Разные числа для двух проверок означали бы, что причина у них разная,
 * а она одна.
 */
const HORIZON_SECONDS = 600;

describe('состав войска доходит до Теслы', () => {
  it('осадный профиль заказывает Теслу', () => {
    // Ради этого и заведён горизонт накопления в полтораста секунд: Тесла
    // стоит двадцать пять секунд дохода, и при базовом терпении желание
    // объявляется недостижимым.
    const played = play(SIEGE_PROFILE, HORIZON_SECONDS);

    expect(trained(played, UnitType.Tesla)).toBeGreaterThan(0);
  });

  it('профиль по умолчанию Теслу не заказывает', () => {
    const played = play(BASELINE_PROFILE, HORIZON_SECONDS);

    expect(trained(played, UnitType.Tesla)).toBe(0);
  });
});

describe('волна отправляется, когда её хватает', () => {
  // Один матч на обе роевые проверки — тот же приём и по той же причине,
  // что в первом describe этого файла: профиль, seed и длина у них
  // совпадают, значит и прогон один и тот же, а считать его дважды
  // означало бы платить минуту за копию.
  const swarm = play(SWARM_PROFILE, HORIZON_SECONDS);

  it('роевой профиль совершает рывок', () => {
    expect(swarm.records.some((record) => record.pushed)).toBe(true);
  });

  it('рывок заказывает волну целиком, а не по машине', () => {
    // Тик рывка отличается от прочих числом заказов: обычное производство
    // покупает не больше одной машины за решение.
    const byTick = new Map<number, number>();
    for (const command of swarm.commands) {
      if (command.kind !== CommandKind.TrainUnit) continue;
      byTick.set(command.tick, (byTick.get(command.tick) ?? 0) + 1);
    }

    const biggest = Math.max(...byTick.values());
    expect(biggest).toBeGreaterThanOrEqual(SWARM_PROFILE.push.waveSize);
  });

  it('профиль по умолчанию рывка не совершает', () => {
    // Доля, равная единице, означает «волна обязана снести базу целиком»,
    // а это невыполнимо арифметически. Прежнее поведение сохранено.
    // Окно то же, что у проверок выше, и оно здесь работает на строгость:
    // «не рвётся никогда» — утверждение тем сильнее, чем дольше смотришь.
    const played = play(BASELINE_PROFILE, HORIZON_SECONDS);

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
