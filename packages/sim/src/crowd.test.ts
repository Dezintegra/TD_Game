import { describe, expect, it } from 'vitest';
import {
  DIRECTION_SOUTH,
  FIXED_POINT_SCALE,
  MAP_CELL_COUNT,
  MAP_WIDTH_CELLS,
  SEPARATION_PUSH_SPEED_PERCENT,
  SEPARATION_WALL_CLEARANCE,
  UNIT_SEPARATION_RADIUS,
  UNIT_STATS,
  Terrain,
  UnitType,
  asEntityId,
  asPlayerId,
  asTickNumber,
} from '@td/shared';
import type { UnitState, WorldState } from './world.js';
import { createWorld } from './world.js';
import { cellIndex } from './map.js';
import { separateUnits } from './crowd.js';
import { allPlayerStats } from './stats.js';
import { toWorking } from './working.js';
import type { Working, WorkingUnit } from './working.js';

/**
 * Расталкивание проверяется отдельно от шага симуляции.
 *
 * Причина простая: в полном шаге машины ещё и едут по полю потока,
 * и по конечному положению не отличить, что его дало — движение или
 * толчок. Здесь мир собирается обычным способом, а проход вызывается
 * руками, поэтому каждое утверждение говорит ровно о правиле
 * расталкивания.
 *
 * Правила, которые видны только в связке с движением и боем — проход
 * толпы через узкое место и стрельба в тот же тик, — проверяются
 * в `step.test.ts`.
 */

const SEED = 909;

/** Расстановка ставится в центре карты, вдали от обеих баз. */
const FIELD_X = MAP_WIDTH_CELLS / 2;
const FIELD_Y = MAP_WIDTH_CELLS / 2;

const point = (cellsX: number, cellsY: number): { x: number; y: number } => ({
  x: Math.round(cellsX * FIXED_POINT_SCALE),
  y: Math.round(cellsY * FIXED_POINT_SCALE),
});

const unit = (
  id: number,
  at: { x: number; y: number },
  unitType: UnitType = UnitType.Assault,
  owner = 0,
): UnitState => ({
  id: asEntityId(id),
  owner: asPlayerId(owner),
  unitType,
  position: at,
  health: UNIT_STATS[unitType].health,
  facing: DIRECTION_SOUTH,
  readyAtTick: asTickNumber(0),
});

/**
 * Мир без единой скалы, если они не заданы явно.
 *
 * Генерация кладёт скалы куда угодно, а расстояния здесь заданы числами:
 * случайная скала рядом с расстановкой толкала бы машины сама и ловила бы
 * тест на карте вместо правила.
 */
const arrange = (units: readonly UnitState[], rocks: readonly number[] = []): WorldState => {
  const world = createWorld(SEED);
  const cells = new Uint8Array(MAP_CELL_COUNT);
  for (const cell of rocks) cells[cell] = Terrain.Rock;

  return {
    ...world,
    map: { cells, baseCells: world.map.baseCells },
    units: [...units],
  };
};

/** Один проход расталкивания над подготовленной расстановкой. */
const separate = (world: WorldState, passes = 1): Working => {
  const working = toWorking(world);
  const stats = allPlayerStats(working.players);

  for (let pass = 0; pass < passes; pass += 1) separateUnits(working, stats);

  return working;
};

const byId = (working: Working, id: number): WorkingUnit => {
  const found = working.units.find((entry) => entry.id === asEntityId(id));
  if (found === undefined) throw new Error(`юнит ${id} потерялся`);
  return found;
};

const distance = (a: WorkingUnit, b: WorkingUnit): number => Math.hypot(a.x - b.x, a.y - b.y);

describe('расталкивание: личный радиус', () => {
  it('две машины в одной точке расходятся', () => {
    const same = point(FIELD_X, FIELD_Y);
    const world = arrange([unit(1, { ...same }), unit(2, { ...same })]);

    const after = separate(world);

    expect(distance(byId(after, 1), byId(after, 2))).toBeGreaterThan(0);
  });

  it('и расходятся до суммы радиусов, а не на любое расстояние', () => {
    const same = point(FIELD_X, FIELD_Y);
    const world = arrange([unit(1, { ...same }), unit(2, { ...same })]);

    const wanted = UNIT_SEPARATION_RADIUS[UnitType.Assault] * 2;
    const after = separate(world, 40);

    expect(distance(byId(after, 1), byId(after, 2))).toBeGreaterThanOrEqual(wanted - 1);
    // Разошлись, но не разбежались: расталкивание не разгоняет машины,
    // а лишь устраняет перекрытие.
    expect(distance(byId(after, 1), byId(after, 2))).toBeLessThan(wanted + FIXED_POINT_SCALE);
  });

  it('разведённые машины остаются на месте', () => {
    const world = arrange([unit(1, point(FIELD_X, FIELD_Y)), unit(2, point(FIELD_X + 1, FIELD_Y))]);

    const after = separate(world, 5);

    expect(byId(after, 1)).toMatchObject(point(FIELD_X, FIELD_Y));
    expect(byId(after, 2)).toMatchObject(point(FIELD_X + 1, FIELD_Y));
  });

  it('радиус зависит от типа: Теслы встают дальше друг от друга, чем штурмовики', () => {
    const same = point(FIELD_X, FIELD_Y);

    const assaults = separate(arrange([unit(1, { ...same }), unit(2, { ...same })]), 80);
    const teslas = separate(
      arrange([unit(1, { ...same }, UnitType.Tesla), unit(2, { ...same }, UnitType.Tesla)]),
      80,
    );

    expect(distance(byId(teslas, 1), byId(teslas, 2))).toBeGreaterThan(
      distance(byId(assaults, 1), byId(assaults, 2)),
    );
  });
});

describe('расталкивание: детерминизм и симметрия', () => {
  const crowd = (): UnitState[] => [
    unit(1, point(FIELD_X, FIELD_Y)),
    unit(2, point(FIELD_X, FIELD_Y)),
    unit(3, point(FIELD_X + 0.1, FIELD_Y)),
    unit(4, point(FIELD_X, FIELD_Y + 0.15)),
    unit(5, point(FIELD_X + 0.2, FIELD_Y + 0.2)),
  ];

  it('порядок машин в массиве не влияет на исход', () => {
    const straight = separate(arrange(crowd()), 3);
    const reversed = separate(arrange([...crowd()].reverse()), 3);

    for (const id of [1, 2, 3, 4, 5]) {
      expect(byId(reversed, id)).toMatchObject({
        x: byId(straight, id).x,
        y: byId(straight, id).y,
      });
    }
  });

  it('повёрнутое на пол-оборота войско получает повёрнутый строй', () => {
    // Карта симметрична поворотом на пол-оборота (`rotatedCell`), а поворот
    // меняет знак у любого вектора относительно центра. Значит, войско
    // противника, поставленное поворотом, обязано и разойтись поворотом —
    // иначе одна из сторон получает преимущество из ничего.
    const CENTRE = (MAP_WIDTH_CELLS * FIXED_POINT_SCALE) / 2;
    const turned = (p: { x: number; y: number }) => ({ x: 2 * CENTRE - p.x, y: 2 * CENTRE - p.y });

    const mine = [point(12, 12), point(12, 12), point(12.1, 12), point(12, 12.15)];

    const world = arrange([
      ...mine.map((p, index) => unit(100 + index, p, UnitType.Assault, 0)),
      ...mine.map((p, index) => unit(200 + index, turned(p), UnitType.Assault, 1)),
    ]);

    const after = separate(world, 6);

    for (let index = 0; index < mine.length; index += 1) {
      const ours = byId(after, 100 + index);
      const theirs = byId(after, 200 + index);

      expect({ x: theirs.x, y: theirs.y }).toEqual(turned({ x: ours.x, y: ours.y }));
    }
  });
});

describe('расталкивание: потолок толчка', () => {
  it('Теслу не смещает быстрее половины её собственной скорости', () => {
    const same = point(FIELD_X, FIELD_Y);
    const cap = Math.floor(
      (UNIT_STATS[UnitType.Tesla].speed * SEPARATION_PUSH_SPEED_PERCENT) / 100,
    );

    // Толпа вокруг: суммарный толчок заведомо больше потолка.
    const world = arrange([
      unit(1, { ...same }, UnitType.Tesla),
      ...Array.from({ length: 8 }, (_unused, index) => unit(10 + index, { ...same })),
    ]);

    const before = point(FIELD_X, FIELD_Y);
    const after = byId(separate(world), 1);

    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThanOrEqual(cap);
  });
});

describe('расталкивание: стены', () => {
  /** Скала занимает клетку целиком; ставим её вплотную к расстановке. */
  const rock = cellIndex(FIELD_X, FIELD_Y);

  it('толпа не вдавливает машину в скалу', () => {
    // Машина стои́т вплотную к правому краю скалы, толпа давит слева.
    const nearRock = point(FIELD_X + 1.02, FIELD_Y + 0.5);

    const world = arrange(
      [
        unit(1, nearRock),
        ...Array.from({ length: 6 }, (_unused, index) =>
          unit(10 + index, point(FIELD_X + 1.2, FIELD_Y + 0.5)),
        ),
      ],
      [rock],
    );

    const after = separate(world, 20);
    const machine = byId(after, 1);
    const cell = cellIndex(
      Math.floor(machine.x / FIXED_POINT_SCALE),
      Math.floor(machine.y / FIXED_POINT_SCALE),
    );

    expect(cell).not.toBe(rock);
  });

  it('скала отодвигает машину от своего края на клиренс', () => {
    // Машина одна, толкать её больше некому — значит, сдвинет только стена.
    const world = arrange([unit(1, point(FIELD_X + 1.05, FIELD_Y + 0.5))], [rock]);

    const after = byId(separate(world, 30), 1);
    const edge = (FIELD_X + 1) * FIXED_POINT_SCALE;

    expect(after.x - edge).toBeGreaterThanOrEqual(SEPARATION_WALL_CLEARANCE - 1);
  });
});

describe('расталкивание: кого оно не касается', () => {
  it('погибшая машина не толкает живых', () => {
    const same = point(FIELD_X, FIELD_Y);
    const world = arrange([unit(1, { ...same }), unit(2, { ...same })]);

    const working = toWorking(world);
    const dead = working.units.find((entry) => entry.id === asEntityId(2));
    if (dead !== undefined) dead.alive = false;

    separateUnits(working, allPlayerStats(working.players));

    expect(byId(working, 1)).toMatchObject(same);
  });

  it('генерала расталкивание не двигает', () => {
    const world = arrange([unit(1, point(FIELD_X, FIELD_Y)), unit(2, point(FIELD_X, FIELD_Y))]);

    const working = toWorking(world);
    const general = working.generals[0];
    if (general === undefined) throw new Error('генерала нет');

    general.x = point(FIELD_X, FIELD_Y).x;
    general.y = point(FIELD_X, FIELD_Y).y;
    const before = { x: general.x, y: general.y };

    separateUnits(working, allPlayerStats(working.players));

    expect({ x: general.x, y: general.y }).toEqual(before);
  });
});
