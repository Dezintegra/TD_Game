import { describe, expect, it } from 'vitest';
import {
  DIRECTION_SOUTH,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  NUKE_COST,
  PPM_ONE,
  STRUCTURE_STATS,
  StructureKind,
  UNIT_STATS,
  UPGRADE_BRANCHES,
  UnitType,
  UpgradeStat,
  UpgradeTarget,
  asEntityId,
  asPlayerId,
  asTickNumber,
  compoundPpm,
  upgradeBranchIndex,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { cellAt, cellCentre, cellIndex, createWorld, playerStats, upgradeCosts } from '@td/sim';
import type { UnitState, WorldState } from '@td/sim';
import { BASELINE_PROFILE } from './profile.js';
import { generalDeathCost } from './posture.js';
import type { PhaseProfile, Spending } from './profile.js';
import {
  hasComparableUpgrade,
  nukeOutcome,
  orderBySpendGain,
  unitGain,
  unitPrice,
  upgradeGain,
} from './value.js';

/**
 * Сравнение покупок по прибавке в энергии.
 *
 * Главное свойство, ради которого расчёт заведён: прокачка **умножает
 * то, что уже есть**, а машина приносит свою полную стоимость независимо
 * от того, что уже куплено. Отсюда следует, что при малом войске выгоднее
 * машина, а при большом — прокачка, и это должно быть видно числами,
 * а не подобрано порогом.
 */

const ME: PlayerId = asPlayerId(0);
const SEED = 20260821;

const phaseOf = (index: number): PhaseProfile => {
  const phase = BASELINE_PROFILE.phases[index];
  if (phase === undefined) throw new Error('нет такой фазы');
  return phase;
};

/** Мир с заданным числом штурмовиков у игрока. */
const withAssaults = (count: number): WorldState => {
  const world = createWorld(SEED);

  const units: UnitState[] = Array.from({ length: count }, (_unused, index) => ({
    id: asEntityId(5000 + index),
    owner: ME,
    unitType: UnitType.Assault,
    position: cellCentre(world.map.baseCells[ME] ?? 0),
    health: 100,
    facing: DIRECTION_SOUTH,
    readyAtTick: asTickNumber(0),
  }));

  return { ...world, units };
};

const statsOf = (world: WorldState) => {
  const player = world.players[ME];
  if (player === undefined) throw new Error('нет игрока');
  return { player, stats: playerStats(player) };
};

/** Фаза, где прокачка интересна только у штурмовика: без экономики. */
const ASSAULT_PHASE: PhaseProfile = {
  ...phaseOf(1),
  upgrades: { [UpgradeTarget.UnitAssault]: 1 },
};

describe('прибавка от покупки считается в энергии', () => {
  it('прибавка от машины не зависит от размера войска', () => {
    // В этом весь смысл сравнения: машина приносит своё независимо
    // от того, сколько их уже есть.
    const few = statsOf(withAssaults(5));
    const many = statsOf(withAssaults(50));

    expect(unitGain(few.stats, phaseOf(1), BASELINE_PROFILE)).toBe(
      unitGain(many.stats, phaseOf(1), BASELINE_PROFILE),
    );
  });

  it('прибавка от прокачки растёт с войском примерно в отношении его размера', () => {
    const few = withAssaults(5);
    const many = withAssaults(50);

    const gainOf = (world: WorldState): number => {
      const { player, stats } = statsOf(world);
      return upgradeGain(world, ME, stats, ASSAULT_PHASE, BASELINE_PROFILE, upgradeCosts(player))
        .gain;
    };

    const small = gainOf(few);
    const large = gainOf(many);

    expect(small).toBeGreaterThan(0);
    expect(large / small).toBeCloseTo(10, 1);
  });

  it('при пустом войске прокачка не приносит ничего', () => {
    // Ровно та осечка, ради которой всё затевалось: «прокачка вперёд
    // всего» на первой минуте умножает ноль.
    const world = withAssaults(0);
    const { player, stats } = statsOf(world);

    expect(
      upgradeGain(world, ME, stats, ASSAULT_PHASE, BASELINE_PROFILE, upgradeCosts(player)).gain,
    ).toBe(0);
  });

  it('прибавка от машины растёт с прокачкой её атаки', () => {
    const world = withAssaults(1);
    const before = statsOf(world);

    const branch = upgradeBranchIndex(UpgradeTarget.UnitAssault, UpgradeStat.Attack);
    const effect = UPGRADE_BRANCHES[branch]?.effectPercent ?? 0;

    // Правится множитель, а не только уровень: характеристики считаются
    // из множителя, и уровень сам по себе ни на что не влияет.
    const upgraded: WorldState = {
      ...world,
      players: world.players.map((player, index) =>
        index === ME
          ? {
              ...player,
              upgrades: player.upgrades.map((entry, position) =>
                position === branch
                  ? { ...entry, level: 5, effectPpm: compoundPpm(effect, 5) }
                  : entry,
              ),
            }
          : player,
      ),
    };

    expect(unitGain(statsOf(upgraded).stats, phaseOf(1), BASELINE_PROFILE)).toBeGreaterThan(
      unitGain(before.stats, phaseOf(1), BASELINE_PROFILE),
    );
  });

  it('средняя цена машины положительна при непустом составе', () => {
    expect(unitPrice(statsOf(withAssaults(0)).stats, phaseOf(1))).toBeGreaterThan(0);
  });
});

describe('ядерный удар считается в энергии, со своими потерями', () => {
  const ENEMY: PlayerId = asPlayerId(1);

  /** Мир, где вокруг точки стоит заданное число юнитов игрока. */
  const crowdAt = (
    world: WorldState,
    owner: PlayerId,
    cell: number,
    count: number,
  ): WorldState => ({
    ...world,
    units: [
      ...world.units,
      ...Array.from({ length: count }, (_unused, index) => ({
        id: asEntityId(7000 + index + owner * 1000),
        owner,
        unitType: UnitType.Assault,
        position: cellCentre(cell),
        health: UNIT_STATS[UnitType.Assault].health,
        facing: DIRECTION_SOUTH,
        readyAtTick: asTickNumber(0),
      })),
    ],
  });

  const outcomeAt = (world: WorldState, cell: number) => {
    const { stats } = statsOf(world);
    const enemy = world.players[ENEMY];
    if (enemy === undefined) throw new Error('нет противника');

    return nukeOutcome(world, ME, cellCentre(cell), stats, playerStats(enemy), () => 0);
  };

  /** Клетка вдали от обеих баз: удар туда ядро не отклонит. */
  const middle = (): number =>
    cellIndex(Math.floor(MAP_WIDTH_CELLS / 2), Math.floor(MAP_HEIGHT_CELLS / 2));

  it('чужие юниты идут в выгоду, свои — в потери', () => {
    const world = createWorld(SEED);
    const cell = middle();

    const theirs = outcomeAt(crowdAt(world, ENEMY, cell, 4), cell);
    const mixed = outcomeAt(crowdAt(crowdAt(world, ENEMY, cell, 4), ME, cell, 2), cell);

    expect(theirs.gain).toBeGreaterThan(0);
    expect(theirs.loss).toBe(0);
    expect(mixed.gain).toBe(theirs.gain);
    expect(mixed.loss).toBeGreaterThan(0);
  });

  it('добитые юниты стоят дешевле целых', () => {
    // Иначе удар по свалке подранков оценивался бы как удар по свежему
    // войску, а противник вот-вот потерял бы их и без нас.
    const world = createWorld(SEED);
    const cell = middle();
    const full = crowdAt(world, ENEMY, cell, 10);
    const hurt: WorldState = {
      ...full,
      units: full.units.map((unit) => ({ ...unit, health: Math.max(1, unit.health / 10) })),
    };

    expect(outcomeAt(hurt, cell).gain).toBeLessThan(outcomeAt(full, cell).gain);
  });

  it('своя постройка входит в потери ровно по своей цене', () => {
    const world = createWorld(SEED);
    const cell = middle();

    const withTower: WorldState = {
      ...world,
      structures: [
        ...world.structures,
        {
          id: asEntityId(7777),
          owner: ME,
          kind: StructureKind.TowerBasic,
          cell,
          health: STRUCTURE_STATS[StructureKind.TowerBasic].health,
          growthPpm: PPM_ONE,
          readyAtTick: asTickNumber(0),
          builtAtTick: asTickNumber(0),
        },
      ],
    };

    expect(outcomeAt(withTower, cell).loss - outcomeAt(world, cell).loss).toBe(
      STRUCTURE_STATS[StructureKind.TowerBasic].cost,
    );
  });

  it('свой генерал входит в потери по той же цене гибели, что и в оценке рубежей', () => {
    const world = createWorld(SEED);
    const general = world.generals[ME];
    if (general === undefined) throw new Error('нет генерала');

    const { stats } = statsOf(world);
    const atGeneral = outcomeAt(world, cellAt(general.position));

    expect(atGeneral.loss).toBe(generalDeathCost(stats, 0));
  });

  it('шесть целых юнитов удара не оправдывают, шесть десятков — оправдывают', () => {
    // Прежний порог «шесть юнитов» означал оружие ценой в пятьдесят машин,
    // применяемое ради шести: переплата в восемь раз.
    //
    // Ровно полсотни дают точную безубыточность — и удара тоже не будет:
    // размен ценою в самого себя не приносит ничего.
    const world = createWorld(SEED);
    const cell = middle();

    expect(outcomeAt(crowdAt(world, ENEMY, cell, 6), cell).gain).toBeLessThan(NUKE_COST);
    expect(outcomeAt(crowdAt(world, ENEMY, cell, 50), cell).gain).toBe(NUKE_COST);
    expect(outcomeAt(crowdAt(world, ENEMY, cell, 60), cell).gain).toBeGreaterThan(NUKE_COST);
  });
});

describe('экономика в сравнении не участвует', () => {
  it('фаза, где интересна одна экономика, сравнению не подлежит', () => {
    expect(hasComparableUpgrade(phaseOf(0))).toBe(false);
  });

  it('фаза с боевыми целями сравнению подлежит', () => {
    expect(hasComparableUpgrade(phaseOf(1))).toBe(true);
  });
});

describe('порядок трат по прибавке', () => {
  const order: readonly Spending[] = ['upgrade', 'build', 'train'];

  it('бесполезная сейчас покупка уходит в конец', () => {
    // Ровно случай первой минуты: прокачивать нечего, войска нет,
    // а прокачка стоит в очереди первой и занимает её целиком.
    expect(orderBySpendGain(order, { upgrade: 0, build: 2, train: 3 })).toEqual([
      'build',
      'train',
      'upgrade',
    ]);
  });

  it('при всех полезных покупках порядок профиля сохраняется', () => {
    // Полное пересортирование по прибавке отвергнуто: башня в нынешних
    // формулах оценивается заведомо ниже прокачки, и противник переставал
    // строить вовсе. Порядок фазы — предпочтение, и решать за него там,
    // где сравнение ненадёжно, мы не будем.
    expect(orderBySpendGain(order, { upgrade: 1, build: 2, train: 3 })).toEqual(order);
  });

  it('несравнимая трата не двигается', () => {
    // Прокачка без ключа — это фаза, где интересна одна экономика.
    expect(orderBySpendGain(order, { build: 1, train: 5 })).toEqual(order);
  });
});
