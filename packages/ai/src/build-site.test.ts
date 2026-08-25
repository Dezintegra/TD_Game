import { describe, expect, it } from 'vitest';
import {
  MAP_CELL_COUNT,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  STRUCTURE_STATS,
  StructureKind,
  Terrain,
  asEntityId,
  asPlayerId,
  asTickNumber,
  distanceSquared,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { cellCentre, cellIndex, cellX, cellY, createWorld, playerStats } from '@td/sim';
import type { PlayerStats, StructureState, WorldState } from '@td/sim';
import { approachOf } from './approach.js';
import type { Approach } from './approach.js';
import {
  coverField,
  coveredCells,
  flowDensity,
  freshCoverage,
  ownTowers,
  rangeInCells,
  siteCover,
  siteValue,
} from './posture.js';
import { BASELINE_PROFILE } from './profile.js';
import { towerBuildCell } from './opponent.js';

/**
 * Куда встаёт башня.
 *
 * Проверяется прямыми вызовами выбора места, а не прогоном матча: матч
 * отвечает на вопрос «чем всё кончилось», а спрашивается здесь «почему
 * выбрано это место».
 *
 * Два мира на одних и тех же клетках, различаются только картой: в первом
 * чистое поле, во втором проход в три клетки. Так сравнение говорит именно
 * о ширине подхода, а не о том, что расстановка разъехалась.
 */

const SEED = 31337;
const AI: PlayerId = asPlayerId(1);

let nextId = 900;

const tower = (owner: PlayerId, cell: number): StructureState => ({
  id: asEntityId((nextId += 1)),
  owner,
  kind: StructureKind.TowerBasic,
  cell,
  health: STRUCTURE_STATS[StructureKind.TowerBasic].health,
  kills: 0,
  readyAtTick: asTickNumber(0),
  builtAtTick: asTickNumber(0),
});

/** Мир без единой скалы: геометрия предсказуема, коридор широк. */
const openWorld = (structures: readonly StructureState[] = []): WorldState => {
  const world = createWorld(SEED);

  return {
    ...world,
    map: { cells: new Uint8Array(MAP_CELL_COUNT), baseCells: world.map.baseCells },
    structures: [...world.structures, ...structures],
    units: [],
  };
};

/**
 * Тот же мир, но проход между базами сужен до трёх клеток.
 *
 * Три клетки — самое узкое, что генерация вообще допускает (§ 2.1:
 * проходов уже трёх на карте не бывает). Площадки у баз оставлены
 * расчищенными, иначе разлив от базы не начнётся вовсе.
 */
const narrowWorld = (structures: readonly StructureState[] = []): WorldState => {
  const world = openWorld(structures);
  const cells = new Uint8Array(MAP_CELL_COUNT).fill(Terrain.Rock);

  const home = world.map.baseCells[AI] ?? 0;
  const enemy = world.map.baseCells[1 - AI] ?? 0;

  const clear = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= MAP_WIDTH_CELLS || y >= MAP_HEIGHT_CELLS) return;
    cells[cellIndex(x, y)] = Terrain.Ground;
  };

  for (const base of [home, enemy]) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) clear(cellX(base) + dx, cellY(base) + dy);
    }
  }

  // Полоса вдоль прямой между базами: шаг по большей из координат,
  // три клетки поперёк.
  const steps = Math.max(
    Math.abs(cellX(enemy) - cellX(home)),
    Math.abs(cellY(enemy) - cellY(home)),
  );

  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(cellX(home) + ((cellX(enemy) - cellX(home)) * step) / steps);
    const y = Math.round(cellY(home) + ((cellY(enemy) - cellY(home)) * step) / steps);

    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) clear(x + dx, y + dy);
    }
  }

  return { ...world, map: { ...world.map, cells } };
};

const approachOrThrow = (world: WorldState): Approach => {
  const approach = approachOf(world, AI);
  if (approach === undefined) throw new Error('вероятный путь не посчитан');

  return approach;
};

const statsOf = (world: WorldState): PlayerStats => {
  const player = world.players[AI];
  if (player === undefined) throw new Error('нет игрока');

  return playerStats(player);
};

/** Клетка коридора на заданной доле маршрута от своей базы. */
const cellAtFraction = (approach: Approach, fraction: number): number => {
  const wanted = Math.round(approach.shortest * fraction);

  let best = -1;
  let bestGap = Number.POSITIVE_INFINITY;

  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    if (approach.onPath[cell] !== 1) continue;

    const gap = Math.abs((approach.fromHome[cell] ?? 0) - wanted);
    if (gap >= bestGap) continue;

    bestGap = gap;
    best = cell;
  }

  return best;
};

/** Поставить генерала стороны в клетку: строит он вокруг себя. */
const withGeneralAt = (world: WorldState, cell: number): WorldState => ({
  ...world,
  generals: world.generals.map((general) =>
    general.owner === AI ? { ...general, position: cellCentre(cell) } : general,
  ),
});

const towerRangeOf = (stats: PlayerStats): number =>
  rangeInCells(stats.structures[StructureKind.TowerBasic].range);

const towerDamageOf = (stats: PlayerStats): number =>
  stats.structures[StructureKind.TowerBasic].attack /
  stats.structures[StructureKind.TowerBasic].cooldownTicks;

const chooseSite = (world: WorldState, approach: Approach): number => {
  const stats = statsOf(world);
  const general = world.generals[AI];
  if (general === undefined) throw new Error('нет генерала');

  return towerBuildCell(
    world,
    general.position,
    stats.general.buildRadius,
    approach,
    coveredCells(world, AI, stats),
    stats,
    BASELINE_PROFILE,
    StructureKind.TowerBasic,
    coverField(ownTowers(world, AI, stats)),
  );
};

const cellDistance = (from: number, to: number): number =>
  Math.hypot(cellX(from) - cellX(to), cellY(from) - cellY(to));

/**
 * Клетки, среди которых выбирает сам противник: проходимые и в радиусе
 * строительства.
 *
 * Скал в круге нет, юнитов нет, базы далеко — других отсевов
 * `forEachBuildCandidate` не делает, поэтому перебор здесь тот же самый.
 */
const candidates = (world: WorldState, approach: Approach): number[] => {
  const stats = statsOf(world);
  const general = world.generals[AI];
  if (general === undefined) throw new Error('нет генерала');

  const radius = stats.general.buildRadius;
  const found: number[] = [];

  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    if (approach.occupancy.blocked[cell] === 1) continue;
    if (distanceSquared(cellCentre(cell), general.position) > radius * radius) continue;

    found.push(cell);
  }

  return found;
};

/**
 * Место по ПРЕЖНЕЙ мерке: наибольшее покрытие ещё не накрытого пути,
 * и ни слова о живучести.
 *
 * Из клеток с наибольшим покрытием берётся ближайшая к своей башне —
 * так сравнение выходит самым строгим: если новый выбор всё равно
 * оказался ближе, дело в прикрытии, а не в том, какую из ничьих разрешили.
 */
const bestByCoverage = (world: WorldState, approach: Approach, mate: number): number => {
  const stats = statsOf(world);
  const covered = coveredCells(world, AI, stats);
  const range = towerRangeOf(stats);

  let best = -1;
  let bestCoverage = 0;
  let bestGap = Number.POSITIVE_INFINITY;

  for (const cell of candidates(world, approach)) {
    const coverage = freshCoverage(approach, covered, cell, range);
    if (coverage < bestCoverage) continue;

    const gap = cellDistance(cell, mate);
    if (coverage === bestCoverage && gap >= bestGap) continue;

    bestCoverage = coverage;
    bestGap = gap;
    best = cell;
  }

  return best;
};

/**
 * Одна и та же расстановка: своя башня чуть позади, генерал на середине
 * маршрута. Меняется только карта.
 */
const scene = (
  make: (structures: readonly StructureState[]) => WorldState,
): { world: WorldState; approach: Approach; mate: number } => {
  const bare = make([]);
  const layout = approachOrThrow(bare);

  const stand = cellAtFraction(layout, 0.5);
  const mate = cellAtFraction(layout, 0.42);

  const world = withGeneralAt(make([tower(AI, mate)]), stand);

  return { world, approach: approachOrThrow(world), mate };
};

describe('покрытие пути и живучесть спорят, и спор решается сравнением', () => {
  // Прежняя мерка ходила за одним покрытием и потому уводила башню как
  // можно дальше от своих: накрытые ими клетки из счёта вычитаются.
  // Прикрытие тянет обратно — и это видно на обеих картах.
  for (const [name, make] of [
    ['в чистом поле', openWorld],
    ['в узком проходе', narrowWorld],
  ] as const) {
    it(name + ' место смещается к своей башне против чистого покрытия', () => {
      const { world, approach, mate } = scene(make);

      const site = chooseSite(world, approach);
      const byCoverage = bestByCoverage(world, approach, mate);

      expect(site).toBeGreaterThanOrEqual(0);
      expect(byCoverage).toBeGreaterThanOrEqual(0);
      expect(cellDistance(site, mate)).toBeLessThan(cellDistance(byCoverage, mate));
    });

    it(name + ' выбранное место простреливается своей башней', () => {
      const { world, approach } = scene(make);
      const stats = statsOf(world);

      const cover = siteCover(
        approach,
        coverField(ownTowers(world, AI, stats)),
        chooseSite(world, approach),
        towerDamageOf(stats),
        towerRangeOf(stats),
      );

      expect(cover).toBeGreaterThan(0);
    });
  }

  it('меньшее покрытие под прикрытием обходит большее в пустоте', () => {
    // Ровно это и значит «величина, а не правило»: ни порога, ни счётчика
    // «не больше трёх башен рядом» для такого выбора не понадобилось.
    const { world, approach, mate } = scene(openWorld);

    const stats = statsOf(world);
    const covered = coveredCells(world, AI, stats);
    const range = towerRangeOf(stats);
    const damagePerTick = towerDamageOf(stats);
    const field = coverField(ownTowers(world, AI, stats));

    const site = chooseSite(world, approach);
    const byCoverage = bestByCoverage(world, approach, mate);

    const coverageOf = (cell: number): number => freshCoverage(approach, covered, cell, range);
    const valueOf = (cell: number): number =>
      siteValue(
        coverageOf(cell),
        siteCover(approach, field, cell, damagePerTick, range),
        stats,
        BASELINE_PROFILE,
      );

    // Выбранное место накрывает МЕНЬШЕ пути, чем победитель прежней мерки,
    // и всё же ценится выше: разницу дало прикрытие.
    expect(coverageOf(site)).toBeLessThan(coverageOf(byCoverage));
    expect(valueOf(site)).toBeGreaterThan(valueOf(byCoverage));
  });
});

describe('плотность потока разрешает ничью', () => {
  it('при равной ценности выбирается место с большей плотностью', () => {
    // Своих башен нет, значит прикрытие всюду нулевое и ценность зависит
    // только от покрытия — целого числа клеток. Ничьих поэтому много,
    // и видно, чем они разрешаются.
    const bare = openWorld();
    const layout = approachOrThrow(bare);
    const world = withGeneralAt(bare, cellAtFraction(layout, 0.5));
    const approach = approachOrThrow(world);

    const stats = statsOf(world);
    const covered = coveredCells(world, AI, stats);
    const range = towerRangeOf(stats);
    const damagePerTick = towerDamageOf(stats);
    const field = coverField(ownTowers(world, AI, stats));

    const valueAt = (cell: number): number =>
      siteValue(
        freshCoverage(approach, covered, cell, range),
        siteCover(approach, field, cell, damagePerTick, range),
        stats,
        BASELINE_PROFILE,
      );

    const site = chooseSite(world, approach);
    expect(site).toBeGreaterThanOrEqual(0);

    const chosen = valueAt(site);
    let ties = 0;

    for (const cell of candidates(world, approach)) {
      const value = valueAt(cell);
      expect(value).toBeLessThanOrEqual(chosen);

      if (value !== chosen || cell === site) continue;

      ties += 1;
      expect(flowDensity(approach, cell)).toBeLessThanOrEqual(flowDensity(approach, site));
    }

    // Тест без единой ничьей не проверил бы ничего.
    expect(ties).toBeGreaterThan(0);
  });
});
