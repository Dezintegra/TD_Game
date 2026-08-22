import { describe, expect, it } from 'vitest';
import {
  CommandKind,
  StructureKind,
  TICKS_PER_SECOND,
  UPGRADE_BRANCHES,
  UpgradeStat,
  asPlayerId,
} from '@td/shared';
import type { Command } from '@td/shared';
import { createWorld, step } from '@td/sim';
import { approachOf } from './approach.js';
import { islandSites, towersAround } from './islands.js';
import { createOpponent } from './opponent.js';
import { BASELINE_PROFILE, ISLANDS_PROFILE } from './profile.js';

/**
 * Доктрина островов: башни скоплением, ползущим к чужой базе.
 *
 * Как и проверки осадной манеры, эти играют матч С СОПЕРНИКОМ: решение
 * о дорогой покупке зависит от обстановки, и на пустом поле противник
 * ведёт себя иначе.
 */

const ME = asPlayerId(0);
const RIVAL = asPlayerId(1);
const SEED = 4242;

interface Played {
  readonly commands: readonly Command[];
  readonly world: ReturnType<typeof createWorld>;
}

const play = (profile: typeof BASELINE_PROFILE, seconds: number): Played => {
  const commands: Command[] = [];
  const mine = createOpponent(ME, SEED, profile);
  const rival = createOpponent(RIVAL, SEED + 1, BASELINE_PROFILE);

  let world = createWorld(SEED);
  for (let tick = 0; tick < seconds * TICKS_PER_SECOND; tick += 1) {
    const issued = mine.decide(world);
    commands.push(...issued);
    world = step(world, [...issued, ...rival.decide(world)]);
  }

  return { commands, world };
};

describe('места островов', () => {
  const world = createWorld(SEED);
  const approach = approachOf(world, ME);
  if (approach === undefined) throw new Error('нет вероятного пути');

  const doctrine = ISLANDS_PROFILE.islands;
  if (doctrine === undefined) throw new Error('у островного профиля нет доктрины');

  const sites = islandSites(approach, doctrine);

  it('их столько же, сколько долей', () => {
    expect(sites).toHaveLength(doctrine.fractions.length);
  });

  it('идут от своей базы к чужой', () => {
    // Расстояние от своей базы обязано расти: порядок островов — это
    // и порядок работы.
    const distances = sites.map((cell) => approach.fromHome[cell] ?? -1);

    for (let index = 1; index < distances.length; index += 1) {
      expect(distances[index]).toBeGreaterThan(distances[index - 1] ?? -1);
    }
  });

  it('лежат на вероятном пути', () => {
    for (const cell of sites) expect(approach.onPath[cell]).toBe(1);
  });
});

describe('островной профиль', () => {
  const played = play(ISLANDS_PROFILE, 420);

  const builds = played.commands.filter((command) => command.kind === CommandKind.Build);

  it('строит только снайперские башни и стены', () => {
    const kinds = new Set(
      builds.map((command) => (command.kind === CommandKind.Build ? command.structure : -1)),
    );

    expect(kinds.has(StructureKind.TowerSniper)).toBe(true);
    expect(kinds.has(StructureKind.TowerBasic)).toBe(false);
  });

  it('не заказывает ни одного юнита', () => {
    const trained = played.commands.filter(
      (command) => command.kind === CommandKind.TrainUnit,
    );

    expect(trained).toHaveLength(0);
  });

  it('ставит башни скоплением, а не россыпью', () => {
    // Скопление считается тем же способом, каким его считает доктрина:
    // сколько башен стоит вокруг середины острова.
    const approach = approachOf(played.world, ME);
    if (approach === undefined) throw new Error('нет вероятного пути');

    const doctrine = ISLANDS_PROFILE.islands;
    if (doctrine === undefined) throw new Error('нет доктрины');

    const sites = islandSites(approach, doctrine);
    const built = builds.length;
    const clustered = sites.reduce(
      (sum, cell) => sum + towersAround(played.world, ME, cell, doctrine.clusterRadiusCells),
      0,
    );

    expect(built).toBeGreaterThan(0);
    // Все живые башни принадлежат какому-нибудь острову: за пределами
    // скоплений противник не строит вовсе.
    const alive = played.world.structures.filter(
      (structure) =>
        structure.owner === ME &&
        structure.kind !== StructureKind.Base &&
        structure.kind !== StructureKind.Wall,
    ).length;

    expect(clustered).toBe(alive);
  });

  it('качает только атаку и дальность снайперской башни', () => {
    const bought = played.commands.filter((command) => command.kind === CommandKind.BuyUpgrade);
    expect(bought.length).toBeGreaterThan(0);

    for (const command of bought) {
      if (command.kind !== CommandKind.BuyUpgrade) continue;

      const branch = UPGRADE_BRANCHES[command.branch];
      if (branch === undefined) throw new Error(`нет ветки ${String(command.branch)}`);

      expect(branch.target).toBe(4); // UpgradeTarget.TowerSniper
      expect([UpgradeStat.Attack, UpgradeStat.Range]).toContain(branch.stat);
    }
  });
});

describe('профиль без доктрины не задет', () => {
  it('у базового доктрины нет', () => {
    expect(BASELINE_PROFILE.islands).toBeUndefined();
  });

  it('базовый по-прежнему строит базовые башни и заказывает юнитов', () => {
    const played = play(BASELINE_PROFILE, 240);

    const towers = played.commands.filter(
      (command) =>
        command.kind === CommandKind.Build && command.structure === StructureKind.TowerBasic,
    );
    const trained = played.commands.filter((command) => command.kind === CommandKind.TrainUnit);

    expect(towers.length).toBeGreaterThan(0);
    expect(trained.length).toBeGreaterThan(0);
  });
});
