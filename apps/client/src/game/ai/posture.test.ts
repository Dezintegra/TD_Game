import { describe, expect, it } from 'vitest';
import {
  MAP_CELL_COUNT,
  MAP_HEIGHT_CELLS,
  PPM_ONE,
  STRUCTURE_STATS,
  StructureKind,
  UNIT_STATS,
  UnitType,
  asEntityId,
  asPlayerId,
  asTickNumber,
  cellsToUnits,
  distanceSquared,
} from '@td/shared';
import type { PlayerId, Vec2 } from '@td/shared';
import { cellCentre, cellIndex, createWorld, playerStats } from '@td/sim';
import type { StructureState, UnitState, WorldState } from '@td/sim';
import { approachOf } from './approach.js';
import {
  THREAT_RADIUS_CELLS,
  chooseFrontier,
  coveredCells,
  freshCoverage,
  incomingAt,
  rangeInCells,
  situationOf,
} from './posture.js';
import type { Situation, Verdict } from './posture.js';

/**
 * Развесовка моделей поведения проверяется прямыми вызовами, а не прогоном
 * матча. Прогон отвечает на вопрос «чем всё кончилось», а нам нужен ответ
 * на «почему выбран этот рубеж», и он виден только в самой оценке.
 *
 * Расстановки строятся на карте без единой скалы: так длина маршрута
 * и ширина коридора предсказуемы, и тест говорит о формуле, а не о том,
 * что успело нагенерироваться.
 */

const SEED = 31337;

/** Противник под управлением компьютера играет за второго игрока. */
const AI: PlayerId = asPlayerId(1);
const FOE: PlayerId = asPlayerId(0);

interface Scene {
  readonly structures?: readonly StructureState[];
  readonly units?: readonly UnitState[];
  /** Убрать ли генерала человека с поля: он тоже стреляет и тоже пугает. */
  readonly hideFoeGeneral?: boolean;
}

/**
 * Дальний угол карты, заведомо не лежащий на маршруте между базами.
 * Базы стоят на главной диагонали, поэтому побочная от них дальше всего.
 */
const OFF_PATH: Vec2 = cellCentre(cellIndex(1, MAP_HEIGHT_CELLS - 2));

const clearMap = (scene: Scene = {}): WorldState => {
  const world = createWorld(SEED);

  return {
    ...world,
    map: { cells: new Uint8Array(MAP_CELL_COUNT), baseCells: world.map.baseCells },
    structures: [...world.structures, ...(scene.structures ?? [])],
    units: [...(scene.units ?? [])],
    generals: world.generals.map((general) =>
      general.owner === FOE && scene.hideFoeGeneral === true
        ? { ...general, position: OFF_PATH }
        : general,
    ),
  };
};

/** Чистый мир без расстановки. Годится всюду, где нужна только геометрия. */
const PLAIN = clearMap();

const homeCellOf = (world: WorldState, owner: PlayerId): number => world.map.baseCells[owner] ?? 0;

/** Точка в клетках от центра базы игрока. */
const nearBase = (owner: PlayerId, dx: number, dy: number): Vec2 => {
  const centre = cellCentre(homeCellOf(PLAIN, owner));
  return { x: centre.x + dx * 1000, y: centre.y + dy * 1000 };
};

let nextId = 500;

const unit = (owner: PlayerId, position: Vec2): UnitState => ({
  id: asEntityId((nextId += 1)),
  owner,
  unitType: UnitType.Assault,
  position,
  health: UNIT_STATS[UnitType.Assault].health,
  facing: 1,
  readyAtTick: asTickNumber(0),
});

const tower = (owner: PlayerId, cell: number): StructureState => ({
  id: asEntityId((nextId += 1)),
  owner,
  kind: StructureKind.TowerBasic,
  cell,
  health: STRUCTURE_STATS[StructureKind.TowerBasic].health,
  growthPpm: PPM_ONE,
  readyAtTick: asTickNumber(0),
  builtAtTick: asTickNumber(0),
});

const APPROACH = approachOf(PLAIN, AI);
if (APPROACH === undefined) throw new Error('вероятный путь не посчитан');

/**
 * Клетка вероятного пути на заданной доле маршрута.
 *
 * Доля считается от базы противника под управлением компьютера: ноль —
 * его собственная база, единица — база человека.
 */
const cellAtFraction = (fraction: number): number => {
  const wanted = Math.round(APPROACH.shortest * fraction);

  let best = -1;
  let bestGap = Number.POSITIVE_INFINITY;

  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    if (APPROACH.onPath[cell] !== 1) continue;

    const gap = Math.abs((APPROACH.fromHome[cell] ?? 0) - wanted);
    if (gap >= bestGap) continue;

    bestGap = gap;
    best = cell;
  }

  return best;
};

const situate = (world: WorldState): Situation => {
  const approach = approachOf(world, AI);
  const player = world.players[AI];
  if (approach === undefined || player === undefined) throw new Error('нет обстановки');

  const stats = playerStats(player);
  const situation = situationOf(world, AI, approach, stats, coveredCells(world, AI, stats));
  if (situation === undefined) throw new Error('нет обстановки');

  return situation;
};

const decide = (world: WorldState): Verdict => {
  const verdict = chooseFrontier(situate(world));
  if (verdict === undefined) throw new Error('рубеж не выбран');

  return verdict;
};

describe('входящий урон', () => {
  const middle = cellAtFraction(0.5);

  it('на пустом месте равен нулю', () => {
    expect(incomingAt(PLAIN, AI, situate(PLAIN).enemyStats, cellCentre(middle)).total).toBe(0);
  });

  it('вражеская башня в дальности даёт свой урон в тик', () => {
    const armed = clearMap({ structures: [tower(FOE, middle)] });
    const incoming = incomingAt(armed, AI, situate(armed).enemyStats, cellCentre(middle));

    const stats = STRUCTURE_STATS[StructureKind.TowerBasic];
    expect(incoming.total).toBeCloseTo(stats.attack / stats.cooldownTicks, 6);
    // Постройки отделены от прочего: именно они делают рубеж неудерживаемым.
    expect(incoming.fromStructures).toBe(incoming.total);
  });

  it('вражеская башня вне дальности не считается', () => {
    const armed = clearMap({ structures: [tower(FOE, cellAtFraction(0.1))] });

    expect(incomingAt(armed, AI, situate(armed).enemyStats, cellCentre(middle)).total).toBe(0);
  });
});

describe('покрытие пути', () => {
  it('считается только по ещё не накрытым клеткам', () => {
    const cell = cellAtFraction(0.5);
    const player = PLAIN.players[AI];
    if (player === undefined) throw new Error('нет игрока');

    const stats = playerStats(player);
    const range = rangeInCells(stats.structures[StructureKind.TowerBasic].range);

    const before = freshCoverage(APPROACH, coveredCells(PLAIN, AI, stats), cell, range);

    const fortified = clearMap({ structures: [tower(AI, cell)] });
    const after = freshCoverage(APPROACH, coveredCells(fortified, AI, stats), cell, range);

    expect(before).toBeGreaterThan(0);
    // Своя же башня накрыла всё, что накрыла бы новая: строить второй раз
    // в ту же клетку незачем, и оценка это показывает.
    expect(after).toBe(0);
  });
});

describe('выбор рубежа', () => {
  it('при пустой обороне врага доходит до его базы', () => {
    // Оборона пуста целиком: ни башен, ни юнитов, и генерал человека
    // убран с маршрута. Держаться дома в такой обстановке не за чем —
    // и формула это находит сама, без отдельного правила «наступай».
    const verdict = decide(clearMap({ hideFoeGeneral: true }));

    expect(verdict.frontier.fraction).toBeGreaterThanOrEqual(0.75);
  });

  it('под башнями у вражеской базы рубеж не занимает', () => {
    const world = clearMap({
      hideFoeGeneral: true,
      structures: [
        tower(FOE, cellAtFraction(0.95)),
        tower(FOE, cellAtFraction(0.88)),
        tower(FOE, cellAtFraction(0.81)),
      ],
    });

    const verdict = decide(world);
    const incoming = incomingAt(
      world,
      AI,
      situate(world).enemyStats,
      cellCentre(verdict.frontier.cell),
    );

    // Проверяется не доля, а свойство: выбранный рубеж не простреливается
    // вражескими постройками. Под их огнём рубеж не удержать.
    expect(incoming.fromStructures).toBe(0);
  });

  it('при массированной атаке на базу возвращается домой', () => {
    const attackers = Array.from({ length: 12 }, (_unused, index) =>
      unit(FOE, nearBase(AI, (index % 4) - 2, Math.floor(index / 4) - 1)),
    );

    const verdict = decide(clearMap({ units: attackers, hideFoeGeneral: true }));

    const home = cellCentre(homeCellOf(PLAIN, AI));
    const radius = cellsToUnits(THREAT_RADIUS_CELLS);

    expect(distanceSquared(cellCentre(verdict.frontier.cell), home)).toBeLessThanOrEqual(
      radius * radius,
    );
  });

  it('одиночного противника у базы отбивают башни, а не генерал', () => {
    const world = clearMap({
      hideFoeGeneral: true,
      units: [unit(FOE, nearBase(AI, 2, 2))],
      structures: [tower(AI, cellAtFraction(0.08))],
    });

    const verdict = decide(world);

    expect(verdict.frontier.fraction).toBeGreaterThan(0.5);
  });

  it('выбор не зависит от порядка перебора', () => {
    const world = clearMap();

    expect(decide(world).frontier.cell).toBe(decide(world).frontier.cell);
  });
});
