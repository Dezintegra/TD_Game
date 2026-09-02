import { describe, expect, it } from 'vitest';
import {
  CommandKind,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  NUKE_COOLDOWN_MAX_LEVEL,
  STRUCTURE_STATS,
  StructureKind,
  UNIT_CAP,
  UNIT_STATS,
  UnitType,
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
import { cellCentre, cellIndex, createWorld } from '@td/sim';
import type { PlayerState, PlayerStats, WorldState } from '@td/sim';
import { playerStats } from '@td/sim';
import { approachOf } from './approach.js';
import { STRATEGIST_PROFILE } from './profile.js';
import { nukeOutcome } from './value.js';
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

/** Игрок, купивший уровни радиуса и мощности удара. */
const withNukeLevels = (world: WorldState, radius: number, damage: number): WorldState => {
  const radiusBranch = upgradeBranchIndex(UpgradeTarget.Base, UpgradeStat.NukeRadius);
  const damageBranch = upgradeBranchIndex(UpgradeTarget.Base, UpgradeStat.NukeDamage);

  return patchPlayer(world, ME, {
    upgrades: (world.players[ME]?.upgrades ?? []).map((state, index) => {
      if (index === radiusBranch) return { ...state, level: radius };
      if (index === damageBranch) return { ...state, level: damage };

      return state;
    }),
  });
};

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
const commandsOver = (world: WorldState, ticks: number): readonly Command[] => {
  const opponent = createOpponent(asPlayerId(ME), SEED, STRATEGIST_PROFILE);
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

/**
 * Сколько целей оправдывают удар — и почему это число нигде не записано.
 *
 * Порог выгоды удара равен цене пуска, и в целях он выражается по-разному
 * для каждого их вида. Ни одно из этих чисел здесь не записано: все они
 * выводятся из констант баланса заново на каждом прогоне, а проверяются
 * ТОЙ ЖЕ оценкой, которой пользуется решение, — `nukeOutcome`
 * и `nukeWorthIt`.
 *
 * Разделение существенно, и вот почему. Записанное число пережило бы
 * правку цены, радиуса или мощности, ничего о ней не сказав, — ровно так
 * требуемое скопление и выросло вдвое незамеченным, когда радиус
 * сократили с десяти клеток до четырёх. А выведенное, но проверяемое
 * списанной с оценки формулой, пережило бы правку самого зачёта: когда
 * «в радиусе — значит погиб» сменилось вычитанием прочности, требуемое
 * число крепких целей выросло на треть, и списанная формула выросла бы
 * вместе с ним.
 *
 * Поэтому ожидание выводится из констант, а ответ спрашивается у оценки:
 * разойдутся — тест упадёт.
 */
describe('требуемое скопление выводится из констант, а не записано числом', () => {
  const statsPair = (
    world: WorldState,
  ): { readonly mine: PlayerStats; readonly foe: PlayerStats } => {
    const mine = world.players[ME];
    const foe = world.players[FOE];
    if (mine === undefined || foe === undefined) throw new Error('мир без стороны');

    return { mine: playerStats(mine), foe: playerStats(foe) };
  };

  /**
   * Чистая ценность удара по середине карты — той самой оценкой, которой
   * её меряет решение. Своих целей в этих мирах нет, поэтому `loss`
   * остаётся нулевым, а `net` равен цене накрытого чужого.
   */
  const netAt = (world: WorldState): number => {
    const { mine, foe } = statsPair(world);
    const outcome = nukeOutcome(world, asPlayerId(ME), cellCentre(CROWD_CELL), mine, foe, () => 0);

    return outcome.gain - outcome.loss;
  };

  const worthIt = (world: WorldState): boolean =>
    nukeWorthIt({ cell: CROWD_CELL, net: netAt(world) }, statsPair(world).mine.nuke.cost);

  /** Чужие машины одного вида, все в середине карты и все целые. */
  const foeUnits = (world: WorldState, type: UnitType, count: number): WorldState => ({
    ...world,
    units: Array.from({ length: count }, (_unused, index) => ({
      id: asEntityId(6000 + index),
      owner: asPlayerId(FOE),
      unitType: type,
      position: cellCentre(CROWD_CELL),
      health: statsPair(world).foe.units[type].health,
      facing: 1,
      readyAtTick: asTickNumber(0),
      kills: 0,
    })),
  });

  /** Чужие постройки одного вида, там же. Базы мира остаются на местах. */
  const foeStructures = (world: WorldState, kind: StructureKind, count: number): WorldState => ({
    ...world,
    structures: [
      ...world.structures,
      ...Array.from({ length: count }, (_unused, index) => ({
        id: asEntityId(6500 + index),
        owner: asPlayerId(FOE),
        kind,
        cell: CROWD_CELL,
        health: statsPair(world).foe.structures[kind].health,
        kills: 0,
        readyAtTick: asTickNumber(0),
        builtAtTick: asTickNumber(0),
        demolishAtTick: asTickNumber(0),
        facing: 1,
      })),
    ],
  });

  /**
   * Сколько целей нужно, чтобы удар окупился.
   *
   * Вывод целиком из констант баланса: цена цели, её прочность, мощность
   * заряда и цена пуска. Строгое «больше», а не «не меньше»: решение бьёт
   * при `net > cost`, поэтому ровно окупающееся скопление порога
   * не переходит. Отсюда и `floor(…) + 1`, а не `ceil`: они расходятся
   * ровно в том случае, когда деление нацело, и `ceil` дал бы число
   * на единицу меньше нужного.
   */
  const required = (cost: number, price: number, health: number, damage: number): number =>
    Math.floor(cost / (price * (Math.min(health, damage) / health))) + 1;

  const requiredUnits = (type: UnitType, mine: PlayerStats, foe: PlayerStats): number => {
    const baseline = foe.units[type];

    return required(mine.nuke.cost, baseline.cost, baseline.health, mine.nuke.damage);
  };

  const requiredStructures = (kind: StructureKind, mine: PlayerStats, foe: PlayerStats): number => {
    const baseline = foe.structures[kind];

    return required(mine.nuke.cost, baseline.cost, baseline.health, mine.nuke.damage);
  };

  it('в середине пустой карты бить не по кому — иначе проверки ниже мерили бы не то', () => {
    // Ловушка, которую этот случай стережёт: попади в круг чужая база,
    // генерал или скала с постройкой, и «требуемое число целей» считалось
    // бы от чужого добра, оказавшегося рядом по случайности карты.
    expect(netAt(createWorld(SEED))).toBe(0);
  });

  for (const type of [UnitType.Assault, UnitType.Sniper, UnitType.Tesla] as const) {
    it(`${UNIT_STATS[type].label}: выведенного числа хватает, на одну машину меньше — нет`, () => {
      const world = createWorld(SEED);
      const { mine, foe } = statsPair(world);
      const need = requiredUnits(type, mine, foe);

      expect(need).toBeGreaterThan(0);
      expect(worthIt(foeUnits(world, type, need))).toBe(true);
      expect(worthIt(foeUnits(world, type, need - 1))).toBe(false);
    });
  }

  for (const kind of [StructureKind.TowerBasic, StructureKind.Wall] as const) {
    it(`${STRUCTURE_STATS[kind].label}: выведенного числа хватает, на одну меньше — нет`, () => {
      const world = createWorld(SEED);
      const { mine, foe } = statsPair(world);
      const need = requiredStructures(kind, mine, foe);

      expect(need).toBeGreaterThan(0);
      expect(worthIt(foeStructures(world, kind, need))).toBe(true);
      expect(worthIt(foeStructures(world, kind, need - 1))).toBe(false);
    });
  }

  it('требуемое скопление своё у каждого игрока', () => {
    // Цена пуска растёт от купленных уровней радиуса и мощности, а против
    // штурмовика прибавка мощности не даёт ничего: доля в зачёте у него
    // и так единица. Значит вложившийся в удар требует БОЛЬШЕГО скопления,
    // чем не вложившийся, — и число это выводится из его собственной цены
    // пуска, а не из константы, общей для обоих.
    const plain = createWorld(SEED);
    const invested = withNukeLevels(plain, 2, 3);

    const needPlain = requiredUnits(UnitType.Assault, statsPair(plain).mine, statsPair(plain).foe);
    const needInvested = requiredUnits(
      UnitType.Assault,
      statsPair(invested).mine,
      statsPair(invested).foe,
    );

    expect(needInvested).toBeGreaterThan(needPlain);

    // И каждое из двух чисел проверено той же оценкой, что и выше:
    // вывод обязан сходиться у обоих игроков, а не у одного из них.
    expect(worthIt(foeUnits(plain, UnitType.Assault, needPlain))).toBe(true);
    expect(worthIt(foeUnits(plain, UnitType.Assault, needPlain - 1))).toBe(false);
    expect(worthIt(foeUnits(invested, UnitType.Assault, needInvested))).toBe(true);
    expect(worthIt(foeUnits(invested, UnitType.Assault, needInvested - 1))).toBe(false);
  });
});
