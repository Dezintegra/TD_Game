import { describe, expect, it } from 'vitest';
import {
  CommandKind,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  NUKE_COOLDOWN_MAX_LEVEL,
  NUKE_COST,
  TICKS_PER_SECOND,
  UNIT_CAP,
  UNIT_STATS,
  UnitType,
  StructureKind,
  UpgradeStat,
  UpgradeTarget,
  asEntityId,
  asPlayerId,
  BASE_UNIT_COST,
  asTickNumber,
  cellsToUnits,
  upgradeBranchIndex,
} from '@td/shared';
import type { Command } from '@td/shared';
import { cellCentre, cellIndex, createWorld, step } from '@td/sim';
import type { PlayerState, WorldState } from '@td/sim';
import { playerStats } from '@td/sim';
import { approachOf } from './approach.js';
import {
  STRATEGIST_PROFILE,
  STRATEGIST_LOSS_HALF_PROFILE,
  DEFAULT_PROFILE_ID,
  BASELINE_PROFILE,
  PROFILES,
  profileByName,
  phaseAt,
  reserveOf,
  savingLimit,
} from './profile.js';
import type { AiProfile } from './profile.js';
import { createOpponent, findNukeTarget, nukeWorthIt } from './opponent.js';

/**
 * Два правила ядерного удара, которые обязан знать не только ядро,
 * но и противник под управлением компьютера.
 *
 * Проверяются прямыми решениями, а не прогоном матча, и это существенно.
 * Команда, которую ядро отклонило, из матча НЕ ВИДНА вовсе: мир после
 * неё такой же, как без неё, и матч кончится тем же самым. Противник при
 * этом будет тратить каждое своё решение впустую — и заметить это
 * по исходу невозможно в принципе.
 *
 * Профиль взят «Стратега»: он единственный, кому разрешено вкладываться
 * в ракету, и потому единственный, у кого эти правила вообще работают.
 */

const SEED = 4242;
const ME = 0;
const FOE = 1;

const patchPlayer = (world: WorldState, id: number, patch: Partial<PlayerState>): WorldState => ({
  ...world,
  players: world.players.map((player, index) => (index === id ? { ...player, ...patch } : player)),
});

const rich = (world: WorldState): WorldState =>
  patchPlayer(patchPlayer(world, 0, { energy: 10_000_000 }), 1, { energy: 10_000_000 });

/**
 * Толпа чужих машин в середине карты — цель, которая заведомо окупает
 * удар.
 *
 * Без неё проверка была бы пустой: на нетронутой карте бить некого,
 * и противник промолчит по совершенно другой причине. Середина карты
 * выбрана потому, что она заведомо вне запретных зон обеих баз.
 */
const CROWD_CELL = cellIndex(Math.floor(MAP_WIDTH_CELLS / 2), Math.floor(MAP_HEIGHT_CELLS / 2));

const withCrowd = (world: WorldState, count = 40): WorldState => {
  const centre = cellCentre(CROWD_CELL);

  return {
    ...world,
    units: Array.from({ length: count }, (_unused, index) => ({
      id: asEntityId(500 + index),
      owner: asPlayerId(FOE),
      unitType: UnitType.Assault,
      position: { x: centre.x, y: centre.y },
      health: UNIT_STATS[UnitType.Assault].health,
      facing: 1,
      readyAtTick: asTickNumber(0),
      kills: 0,
    })),
  };
};

/**
 * Команды за несколько сотен тиков.
 *
 * Несколько сотен, а не один: противник думает раз в пятнадцать тиков,
 * и по одному тику не увидеть ни одной команды вовсе.
 */
const commandsOver = (
  world: WorldState,
  ticks: number,
  profile: AiProfile = STRATEGIST_PROFILE,
): readonly Command[] => {
  const opponent = createOpponent(asPlayerId(ME), SEED, profile);
  const seen: Command[] = [];

  let current = world;
  for (let tick = 0; tick < ticks; tick += 1) {
    seen.push(...opponent.decide(current));
    current = { ...current, tick: asTickNumber(current.tick + 1) };
  }

  return seen;
};

const launches = (world: WorldState): number =>
  commandsOver(world, 300).filter((issued) => issued.kind === CommandKind.LaunchNuke).length;

const ratioProfile = (minValueRatio: number): AiProfile => ({
  ...STRATEGIST_PROFILE,
  nuke: { ...STRATEGIST_PROFILE.nuke, minValueRatio },
});

const targetOf = (world: WorldState, profile = STRATEGIST_PROFILE) => {
  const player = world.players[ME];
  const approach = approachOf(world, asPlayerId(ME));
  if (player === undefined || approach === undefined) throw new Error('мир без стороны');
  return findNukeTarget(world, asPlayerId(ME), profile, approach, playerStats(player));
};

const statsOf = (world: WorldState) => {
  const player = world.players[ME];
  if (player === undefined) throw new Error('мир без стороны');
  return playerStats(player);
};

const purchasesOf = (commands: readonly Command[]) =>
  commands.filter(
    (issued) =>
      issued.kind === CommandKind.TrainUnit ||
      issued.kind === CommandKind.Build ||
      issued.kind === CommandKind.BuyUpgrade,
  );

describe('коэффициент порога ядерного удара', () => {
  it.each([undefined, 1, 0.5, 2, 0, -1, NaN, Infinity, -Infinity])(
    'строгая граница и нормализация %s',
    (ratio) => {
      const effective = ratio === 0.5 || ratio === 2 ? ratio : 1;
      const threshold = 400 * effective;
      for (const [net, expected] of [
        [threshold - 1, false],
        [threshold, false],
        [threshold + 1, true],
      ] as const) {
        expect(nukeWorthIt({ cell: CROWD_CELL, net }, 400, ratio)).toBe(expected);
      }
      expect(nukeWorthIt(undefined, 400, ratio)).toBe(false);
      expect(nukeWorthIt({ cell: CROWD_CELL, net: 0 }, 400, ratio)).toBe(false);
      expect(nukeWorthIt({ cell: CROWD_CELL, net: -1 }, 400, ratio)).toBe(false);
    },
  );

  // Двенадцать машин стоят между половиной и полной ценой пуска.
  // Мир неподвижен: измеряется подключение настройки, а не исход матча.
  const world = withCrowd(rich(createWorld(SEED)), 12);
  const half = ratioProfile(0.5);
  const late = patchPlayer({ ...world, tick: asTickNumber(301 * TICKS_PER_SECOND) }, ME, {
    energy: BASE_UNIT_COST * 4,
  });
  const issued = (state: WorldState, profile = half) => commandsOver(state, 30, profile);
  const strikes = (state: WorldState, profile = half) =>
    issued(state, profile).filter((entry) => entry.kind === CommandKind.LaunchNuke);

  it('цель между порогами включает пуск только при явном допуске убытка', () => {
    const target = targetOf(world);
    const cost = statsOf(world).nuke.cost;
    expect(target?.net).toBeGreaterThan(cost * 0.5);
    expect(target?.net).toBeLessThan(cost);
    expect(strikes(world).length).toBeGreaterThan(0);
    expect(strikes(world, ratioProfile(1))).toHaveLength(0);
    expect(strikes(world, ratioProfile(2))).toHaveLength(0);
  });

  it('коэффициент не уменьшает необходимую энергию или списание', () => {
    const cost = statsOf(world).nuke.cost;
    expect(strikes(patchPlayer(world, ME, { energy: cost - 1 }))).toHaveLength(0);
    const funded = patchPlayer(world, ME, { energy: cost });
    const launch = strikes(funded)[0];
    expect(launch).toBeDefined();
    if (launch === undefined) throw new Error('нет контрольного пуска');
    const atLaunch = { ...funded, tick: launch.tick };
    const idle = step(atLaunch, []);
    const fired = step(atLaunch, [launch]);
    expect((idle.players[ME]?.energy ?? 0) - (fired.players[ME]?.energy ?? 0)).toBe(cost);
  });

  it('поздний Стратег удерживает запас при 0.5, при 1 строит башню', () => {
    expect(purchasesOf(issued(late))).toHaveLength(0);
    expect(issued(late, ratioProfile(1))).toContainEqual(
      expect.objectContaining({ kind: CommandKind.Build, structure: StructureKind.TowerBasic }),
    );
  });

  it('после исчезновения цели тот же противник освобождает запас до внедрения 0026', () => {
    const opponent = createOpponent(asPlayerId(ME), SEED, half);
    let current = late;
    const before: Command[] = [];
    for (let i = 0; i < 30; i += 1) {
      before.push(...opponent.decide(current));
      current = { ...current, tick: asTickNumber(current.tick + 1) };
    }
    expect(purchasesOf(before)).toHaveLength(0);
    current = { ...current, units: [] };
    const after: Command[] = [];
    for (let i = 0; i < 30; i += 1) {
      after.push(...opponent.decide(current));
      current = { ...current, tick: asTickNumber(current.tick + 1) };
    }
    expect(purchasesOf(after).length).toBeGreaterThan(0);
  });

  it('invest, откат и фаза по-прежнему запрещают резерв', () => {
    const noInvest = { ...half, nuke: { ...half.nuke, invest: false } };
    expect(purchasesOf(issued(late, noInvest)).length).toBeGreaterThan(0);
    const cooling = patchPlayer(late, ME, { nukeReadyAtTick: asTickNumber(late.tick + 1000) });
    expect(purchasesOf(issued(cooling)).length).toBeGreaterThan(0);
    expect(strikes(patchPlayer(world, ME, { nukeReadyAtTick: asTickNumber(1000) }))).toHaveLength(
      0,
    );
    const early = { ...late, tick: asTickNumber(0) };
    expect(purchasesOf(issued(early)).length).toBeGreaterThan(0);
  });

  it('сумма запаса и граница достижимости не получают скидку', () => {
    const income = statsOf(late).incomePerTick;
    const atLimit = {
      ...half,
      spending: { ...half.spending, savingHorizonSeconds: NUKE_COST / (income * TICKS_PER_SECOND) },
    };
    const belowLimit = {
      ...atLimit,
      spending: {
        ...atLimit.spending,
        savingHorizonSeconds: atLimit.spending.savingHorizonSeconds - 1,
      },
    };
    const phase = phaseAt(half, late.tick);
    expect(savingLimit(income, atLimit)).toBe(NUKE_COST);
    expect(reserveOf(phase, income, atLimit, 0, false, true)).toBe(NUKE_COST);
    expect(reserveOf(phase, income, belowLimit, 0, false, true)).toBe(0);
    expect(purchasesOf(issued(late, atLimit))).toHaveLength(0);
    expect(purchasesOf(issued(late, belowLimit)).length).toBeGreaterThan(0);
  });

  it('прокачка меняет порог и оплату, сохраняя базовый резерв', () => {
    const branch = upgradeBranchIndex(UpgradeTarget.Base, UpgradeStat.NukeDamage);
    const upgraded = patchPlayer(world, ME, {
      upgrades: (world.players[ME]?.upgrades ?? []).map((state, index) =>
        index === branch ? { ...state, level: 10 } : state,
      ),
    });
    const cost = statsOf(upgraded).nuke.cost;
    expect(cost).toBeGreaterThan(NUKE_COST);
    expect(strikes(upgraded)).toHaveLength(0);
    const biggerCrowd = withCrowd(upgraded, 40);
    expect(strikes(biggerCrowd).length).toBeGreaterThan(0);
    expect(strikes(patchPlayer(biggerCrowd, ME, { energy: cost - 1 }))).toHaveLength(0);
    const launch = strikes(patchPlayer(biggerCrowd, ME, { energy: cost }))[0];
    if (launch === undefined) throw new Error('нет прокачанного пуска');
    const ready = patchPlayer({ ...biggerCrowd, tick: launch.tick }, ME, { energy: cost });
    expect(
      (step(ready, []).players[ME]?.energy ?? 0) - (step(ready, [launch]).players[ME]?.energy ?? 0),
    ).toBe(cost);
    const phase = phaseAt(half, late.tick);
    expect(reserveOf(phase, statsOf(upgraded).incomePerTick, half, 0, false, true)).toBe(NUKE_COST);
    const poor = patchPlayer({ ...biggerCrowd, tick: late.tick }, ME, {
      energy: NUKE_COST + BASE_UNIT_COST * 4,
    });
    expect(poor.players[ME]?.energy).toBeLessThan(cost);
    expect(purchasesOf(issued(poor)).length).toBeGreaterThan(0);
  });

  it('свои потери вычитаются до применения коэффициента', () => {
    const centre = cellCentre(CROWD_CELL);
    const own = world.units.slice(0, 5).map((unit, index) => ({
      ...unit,
      id: asEntityId(900 + index),
      owner: asPlayerId(ME),
      position: centre,
    }));
    const mixed = { ...world, units: [...world.units, ...own] };
    expect(targetOf(world)?.net).toBe(BASE_UNIT_COST * 12);
    expect(targetOf(mixed)?.net).toBe(BASE_UNIT_COST * 7);
    expect(strikes(mixed)).toHaveLength(0);
    expect(strikes(world).length).toBeGreaterThan(0);
  });

  it('запретная зона сохраняется даже при подходящей по цене толпе', () => {
    const base = world.structures.find(
      (entry) => entry.kind === StructureKind.Base && entry.owner === FOE,
    );
    if (base === undefined) throw new Error('нет базы');
    const blocked = {
      ...world,
      units: world.units.map((unit) => ({ ...unit, position: cellCentre(base.cell) })),
    };
    expect(strikes(blocked)).toHaveLength(0);
    expect(strikes(world).length).toBeGreaterThan(0);
  });

  it('отсутствующая настройка и явная 1 дают одинаковые последовательности команд', () => {
    for (const state of [world, late, withCrowd(world), { ...late, units: [] }]) {
      expect(commandsOver(state, 60)).toEqual(commandsOver(state, 60, ratioProfile(1)));
    }
  });
});

describe('измерительный Стратег с половинным порогом', () => {
  it('зарегистрирован под отдельным именем и отличается только id и коэффициентом', () => {
    const probe = profileByName('strategist-loss-half-2026-09');
    expect(probe).toBe(STRATEGIST_LOSS_HALF_PROFILE);
    expect(PROFILES[probe.id]).toBe(probe);
    expect(probe).toEqual({
      ...STRATEGIST_PROFILE,
      id: 'strategist-loss-half-2026-09',
      nuke: { ...STRATEGIST_PROFILE.nuke, minValueRatio: 0.5 },
    });
    expect(probe.nuke).not.toBe(STRATEGIST_PROFILE.nuke);
    expect(STRATEGIST_PROFILE.id).toBe('strategist-2026-08');
    expect(STRATEGIST_PROFILE.nuke).not.toHaveProperty('minValueRatio');
    expect(DEFAULT_PROFILE_ID).toBe(BASELINE_PROFILE.id);
    for (const profile of Object.values(PROFILES)) {
      if (profile === probe) continue;
      expect(nukeWorthIt({ cell: CROWD_CELL, net: 400 }, 400, profile.nuke.minValueRatio)).toBe(
        false,
      );
      expect(nukeWorthIt({ cell: CROWD_CELL, net: 401 }, 400, profile.nuke.minValueRatio)).toBe(
        true,
      );
    }
  });

  it('заморожен вглубь и не позволяет менять контроль через общие части', () => {
    const checkFrozen = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const inner of Object.values(value)) checkFrozen(inner);
    };
    checkFrozen(STRATEGIST_LOSS_HALF_PROFILE);
    const before = structuredClone(STRATEGIST_PROFILE);
    expect(Reflect.set(STRATEGIST_LOSS_HALF_PROFILE.nuke, 'minValueRatio', 0.25)).toBe(false);
    expect(Reflect.set(STRATEGIST_LOSS_HALF_PROFILE.spending, 'savingHorizonSeconds', 0)).toBe(
      false,
    );
    expect(STRATEGIST_PROFILE).toEqual(before);
    expect(STRATEGIST_LOSS_HALF_PROFILE.nuke.minValueRatio).toBe(0.5);
  });
});

describe('противник и откат ядерного удара', () => {
  const target = withCrowd(rich(createWorld(SEED)));

  it('по стоящей толпе бьёт — иначе проверка ниже была бы пустой', () => {
    expect(launches(target)).toBeGreaterThan(0);
  });

  it('по той же толпе молчит, пока установка не остыла', () => {
    const cooling = patchPlayer(target, ME, { nukeReadyAtTick: asTickNumber(100_000) });

    expect(launches(cooling)).toBe(0);
  });
});

describe('противник и потолок уровня', () => {
  const cooldownBranch = upgradeBranchIndex(UpgradeTarget.Base, UpgradeStat.NukeCooldown);

  /**
   * Мир, в котором противнику не остаётся ничего, кроме прокачки.
   *
   * Обе заглушки нужны, и обе намеренны. Войско доведено до потолка
   * численности — иначе противник весь свой ход заказывает машины
   * и до прокачки не доходит. Генерал мёртв — иначе он весь ход строит,
   * и до прокачки не доходит снова. Проверено: без первой заглушки
   * триста решений дают одни заказы, без второй — одну стройку.
   *
   * Прочие ветки вздорожали вдесятеро, поэтому самой дешёвой в цели
   * «база» остаётся откат — та самая ветка, которую проверяем.
   */
  const nothingButUpgrades = (level: number): WorldState => {
    const base = rich(createWorld(SEED));
    const general = base.generals[ME];

    const world: WorldState = {
      ...base,
      generals: base.generals.map((entry, index) =>
        index === ME ? { ...entry, alive: false } : entry,
      ),
      units: Array.from({ length: UNIT_CAP }, (_unused, index) => ({
        id: asEntityId(1_000 + index),
        owner: asPlayerId(ME),
        unitType: UnitType.Assault,
        position: general === undefined ? cellCentre(CROWD_CELL) : { ...general.position },
        health: UNIT_STATS[UnitType.Assault].health,
        facing: 1,
        readyAtTick: asTickNumber(0),
        kills: 0,
      })),
    };

    return patchPlayer(world, ME, {
      upgrades: (world.players[ME]?.upgrades ?? []).map((state, index) =>
        index === cooldownBranch ? { ...state, level } : { ...state, costPpm: state.costPpm * 10 },
      ),
    });
  };

  const boughtBranches = (world: WorldState): readonly number[] =>
    commandsOver(world, 300)
      .filter((issued) => issued.kind === CommandKind.BuyUpgrade)
      .map((issued) => (issued.kind === CommandKind.BuyUpgrade ? issued.branch : -1));

  it('самую дешёвую ветку покупает — иначе проверка ниже была бы пустой', () => {
    expect(boughtBranches(nothingButUpgrades(0))).toContain(cooldownBranch);
  });

  it('ту же ветку на потолке не покупает', () => {
    // Ловушка, ради которой правило и заведено: потолок цены НЕ МЕНЯЕТ,
    // поэтому предельная ветка так и осталась бы самой дешёвой — выбрана,
    // отклонена, выбрана снова, и так до конца матча.
    expect(boughtBranches(nothingButUpgrades(NUKE_COOLDOWN_MAX_LEVEL))).not.toContain(
      cooldownBranch,
    );
  });
});

describe('поиск цели и решение бить — два шага', () => {
  /**
   * Поиск отвечает на вопрос «что на карте лучше всего», решение —
   * на вопрос «стоит ли это цены удара». Разделены они не ради
   * опрятности: у поиска стало два потребителя, и второй — накопление
   * неприкосновенного запаса — обязан спрашивать обстановку ТЕМ ЖЕ
   * обходом карты, а не своим.
   */
  const targetOf = (world: WorldState) => {
    const player = world.players[ME];
    const approach = approachOf(world, asPlayerId(ME));
    if (player === undefined || approach === undefined) throw new Error('мир без стороны');

    return {
      target: findNukeTarget(
        world,
        asPlayerId(ME),
        STRATEGIST_PROFILE,
        approach,
        playerStats(player),
      ),
      cost: playerStats(player).nuke.cost,
    };
  };

  it('на нетронутой карте цель находится, но удара не оправдывает', () => {
    // Поиск возвращает лучшее из имеющегося, каким бы бедным оно ни было:
    // порог — дело решения. Пустой ответ означал бы, что поиск уже
    // сравнил с ценой, и запас пришлось бы спрашивать вторым обходом.
    const { target, cost } = targetOf(rich(createWorld(SEED)));

    expect(target).toBeDefined();
    expect(nukeWorthIt(target, cost)).toBe(false);
  });

  it('по толпе цель оправдывает удар, и найдена она там, где толпа', () => {
    const { target, cost } = targetOf(withCrowd(rich(createWorld(SEED))));

    expect(nukeWorthIt(target, cost)).toBe(true);

    // Не сама клетка толпы, а ближайшая к ней клетка сетки обхода:
    // перебор идёт с шагом `nuke.scanStep`, и требовать попадания
    // ровно в толпу значило бы требовать, чтобы её поставили на узел.
    // Достаточно, чтобы найденное было в радиусе поражения.
    const found = cellCentre(target?.cell ?? -1);
    const crowd = cellCentre(CROWD_CELL);
    const radius = cellsToUnits(STRATEGIST_PROFILE.nuke.scanStep);
    expect(Math.hypot(found.x - crowd.x, found.y - crowd.y)).toBeLessThanOrEqual(radius);
  });
});

describe('запас под удар держится по обстановке, а не по фазе', () => {
  /**
   * Тик поздней фазы: только в ней удар вообще интересен.
   *
   * Мир при этом НЕ шагает — `commandsOver` лишь двигает счётчик тиков.
   * Это и нужно: энергия не прибывает, юниты не ходят, и разница между
   * двумя проверками ниже остаётся ровно одна — есть ли по кому бить.
   */
  const LATE_TICK = 300 * 30 + 1;

  /**
   * Энергии хватает на покупку и не хватает на удар.
   *
   * Четыре базовых стоимости юнита при цене пуска в шестнадцать.
   * Держится запас — не купится ничего; не держится — купится
   * что-нибудь в первом же решении.
   */
  const poorAndLate = (world: WorldState): WorldState =>
    patchPlayer({ ...world, tick: asTickNumber(LATE_TICK) }, ME, {
      energy: BASE_UNIT_COST * 4,
    });

  const purchases = (world: WorldState): number =>
    commandsOver(world, 300).filter(
      (issued) =>
        issued.kind === CommandKind.TrainUnit ||
        issued.kind === CommandKind.Build ||
        issued.kind === CommandKind.BuyUpgrade,
    ).length;

  it('бить некого — энергия достаётся тратам целиком', () => {
    expect(purchases(poorAndLate(createWorld(SEED)))).toBeGreaterThan(0);
  });

  it('появилось скопление — энергия удерживается под удар', () => {
    // Та же энергия, тот же тик, та же фаза. Изменилась одна обстановка,
    // и запас — её свойство, а не свойство фазы.
    expect(purchases(poorAndLate(withCrowd(createWorld(SEED))))).toBe(0);
  });
});
