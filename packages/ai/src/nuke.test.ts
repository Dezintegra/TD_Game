import { describe, expect, it } from 'vitest';
import {
  CommandKind,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  NUKE_COOLDOWN_MAX_LEVEL,
  UNIT_CAP,
  UNIT_STATS,
  UnitType,
  UpgradeStat,
  UpgradeTarget,
  asEntityId,
  asPlayerId,
  asTickNumber,
  cellsToUnits,
  upgradeBranchIndex,
} from '@td/shared';
import type { Command } from '@td/shared';
import { cellCentre, cellIndex, createWorld } from '@td/sim';
import type { PlayerState, WorldState } from '@td/sim';
import { playerStats } from '@td/sim';
import { approachOf } from './approach.js';
import { STRATEGIST_PROFILE } from './profile.js';
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
