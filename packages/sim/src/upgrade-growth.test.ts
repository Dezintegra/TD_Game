import { afterEach, describe, expect, it } from 'vitest';
import {
  BASE_INCOME_PER_TICK,
  CommandKind,
  MAX_UPGRADE_PPM,
  UpgradeStat,
  UpgradeTarget,
  applyRuleTuning,
  asPlayerId,
  asTickNumber,
  resetRuleTuning,
  upgradeBranchIndex,
} from '@td/shared';
import type { Command, WorldState } from '@td/shared';
import { createWorld } from './world.js';
import { step } from './step.js';
import { playerStats, upgradeCosts } from './stats.js';

/**
 * Модели роста ветки прокачки.
 *
 * Проверяется не арифметика — она своя в `percent.test.ts`, — а то, что
 * объявленная веткой модель доезжает до покупки в мире. Место стыка
 * ровно одно: шаг множителей в `apply.ts`, и разъехаться ему не с чем,
 * кроме как молча, потому что обе модели дают правдоподобные числа.
 *
 * Ветка добычи энергии взята потому, что она единственная, чью модель
 * двигает настройка правил, — и потому, что у неё видны обе стороны
 * разом: и цена уровня, и то, что уровень даёт.
 */

const SEED = 424_242;
/** Запас, которого хватит на два десятка уровней любой из моделей. */
const RICH = 100_000_000;

afterEach(() => {
  // Правила глобальны на весь процесс. Без возврата следующая проверка
  // началась бы в чужом мире, а первая же — заперла бы настройку.
  resetRuleTuning();
});

const incomeBranch = (): number => upgradeBranchIndex(UpgradeTarget.Base, UpgradeStat.Income);

const richWorld = (): WorldState => {
  const world = createWorld(SEED);
  return {
    ...world,
    players: world.players.map((player) => ({ ...player, energy: RICH })),
  };
};

const buy = (branch: number): Command => ({
  kind: CommandKind.BuyUpgrade,
  player: asPlayerId(0),
  tick: asTickNumber(0),
  branch,
});

/** Мир после `levels` покупок одной ветки. Каждая покупка — свой тик. */
const afterLevels = (world: WorldState, branch: number, levels: number): WorldState => {
  let current = world;
  for (let index = 0; index < levels; index += 1) {
    current = step(current, [buy(branch)]);
  }
  return current;
};

const playerOf = (world: WorldState) => {
  const found = world.players[0];
  if (found === undefined) throw new Error('нет игрока 0');
  return found;
};

describe('линейная модель роста цены', () => {
  it('цена уровня идёт прямой, а не сложным процентом', () => {
    applyRuleTuning({ incomeCostPercent: 25, incomeCostModel: 'linear' });

    const branch = incomeBranch();
    const world = afterLevels(richWorld(), branch, 4);

    // База 100, четыре уровня куплено, значит следующий стоит
    // 100 × (1 + 0,25 × 4) = 200. Сложным процентом вышло бы 244.
    expect(upgradeCosts(playerOf(world))[branch]).toBe(100 * 30 * 2);
  });

  it('сложный процент считается сложным процентом', () => {
    // Модель называется прямо, а не берётся умолчанием: проверяется
    // ПОВЕДЕНИЕ модели, и оно не должно зависеть от того, какую кривую
    // замысел выбрал для экономики сегодня.
    applyRuleTuning({ incomeCostPercent: 25, incomeCostModel: 'geometric' });

    const branch = incomeBranch();
    const world = afterLevels(richWorld(), branch, 4);

    // Сложный процент копится в множителе, а не в цене: 1,25 в четвёртой
    // степени это 2,44140625, и цена выходит 7324 внутренних единицы.
    // Округляйся цена на каждом шаге — вышло бы 7320, и разница в четыре
    // единицы ровно та, ради которой множитель и хранится множителем.
    expect(upgradeCosts(playerOf(world))[branch]).toBe(7324);
  });
});

describe('линейная модель роста прибавки', () => {
  it('доход идёт прямой от базы', () => {
    applyRuleTuning({ incomeEffectPercent: 40, incomeEffectModel: 'linear' });

    const world = afterLevels(richWorld(), incomeBranch(), 5);

    // Сорок процентов базы за уровень, пять уровней — ровно втрое.
    expect(playerStats(playerOf(world)).incomePerTick).toBe(BASE_INCOME_PER_TICK * 3);
  });

  it('сложный процент обгоняет прямую на том же числе уровней', () => {
    applyRuleTuning({ incomeEffectPercent: 40, incomeEffectModel: 'geometric' });

    const world = afterLevels(richWorld(), incomeBranch(), 5);

    expect(playerStats(playerOf(world)).incomePerTick).toBeGreaterThan(BASE_INCOME_PER_TICK * 3);
  });
});

describe('модели независимы', () => {
  it('прямая цена уживается с геометрической прибавкой', () => {
    // Ровно то сочетание, ради которого ручки и заведены: доход растёт
    // сложным процентом, а цена уровня — прямой.
    applyRuleTuning({
      incomeEffectPercent: 20,
      incomeEffectModel: 'geometric',
      incomeCostPercent: 10,
      incomeCostModel: 'linear',
    });

    const branch = incomeBranch();
    const world = afterLevels(richWorld(), branch, 10);

    expect(upgradeCosts(playerOf(world))[branch]).toBe(200 * 30);
    expect(playerStats(playerOf(world)).incomePerTick).toBe(61);
  });
});

describe('потолок множителя', () => {
  it('множитель не перерастает потолка', () => {
    // Прямая с огромным шагом доводит до потолка за считанные уровни,
    // тогда как задуманная кривая не дойдёт до него и за тысячи.
    applyRuleTuning({ incomeEffectPercent: 40_000, incomeEffectModel: 'linear' });

    const branch = incomeBranch();
    const world = afterLevels(richWorld(), branch, 5);
    const state = playerOf(world).upgrades[branch];

    expect(state?.effectPpm).toBe(MAX_UPGRADE_PPM);
  });

  it('задуманная игра потолка не достигает', () => {
    // Главное свойство потолка: он защищает арифметику, а не правит игру.
    const branch = incomeBranch();
    const world = afterLevels(richWorld(), branch, 30);
    const state = playerOf(world).upgrades[branch];

    expect(state?.effectPpm).toBeLessThan(MAX_UPGRADE_PPM);
    expect(state?.costPpm).toBeLessThan(MAX_UPGRADE_PPM);
  });
});
