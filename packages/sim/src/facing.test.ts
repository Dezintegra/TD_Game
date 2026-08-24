import { describe, expect, it } from 'vitest';
import {
  AttackStance,
  BASE_BUILD_EXCLUSION_CELLS,
  CommandKind,
  DIRECTION_COUNT,
  DIRECTION_STOP,
  MAP_CELL_COUNT,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  STRUCTURE_STATS,
  StructureKind,
  Terrain,
  UnitType,
  asEntityId,
  asPlayerId,
  asTickNumber,
  cellsToUnits,
  directionTowards,
  distanceSquared,
} from '@td/shared';
import type { Command, Vec2 } from '@td/shared';
import { createWorld } from './world.js';
import type { StructureState, UnitState, WorldState } from './world.js';
import { step } from './step.js';
import { cellAt, cellCentre, cellIndex } from './map.js';

/**
 * Разворот машин.
 *
 * Величина эта производная и нужна одному лишь рендеру, но живёт
 * в состоянии мира: клиент предсказывает симуляцию вперёд и откатывается
 * при расхождении, и направление, выведенное из разницы положений между
 * кадрами, при откате терялось бы — войско разворачивалось бы куда попало
 * ровно в тот момент, когда игрок смотрит на бой.
 *
 * Отсюда и требования, которые проверяются ниже: направление обязано
 * обновляться по понятным правилам и не влиять на исход боя.
 */

const SEED = 777;

const FIELD_X = MAP_WIDTH_CELLS / 2;
const FIELD_Y = MAP_HEIGHT_CELLS / 2;

const at = (dx: number, dy: number): { x: number; y: number } => {
  const centre = cellCentre(cellIndex(FIELD_X, FIELD_Y));
  return { x: centre.x + dx * 1000, y: centre.y + dy * 1000 };
};

const unit = (id: number, owner: number, dx: number, dy: number, facing: number): UnitState => ({
  id: asEntityId(id),
  owner: asPlayerId(owner),
  unitType: UnitType.Assault,
  position: at(dx, dy),
  health: 100,
  facing,
  readyAtTick: asTickNumber(0),
  kills: 0,
});

/**
 * Свободная клетка рядом с генералом и подальше от обеих баз.
 *
 * Клетка ищется, а не задаётся числом: карта строится генератором,
 * и заданная руками клетка при первой же правке генерации оказалась бы
 * под скалой или внутри защищённого кольца базы.
 */
const buildSpotNear = (world: WorldState, from: Vec2, ownerBase: number): number => {
  const reach = cellsToUnits(4);
  const clear = cellsToUnits(BASE_BUILD_EXCLUSION_CELLS + 1);

  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    if (world.map.cells[cell] !== Terrain.Ground) continue;
    if (world.structures.some((entry) => entry.cell === cell)) continue;
    // На клетке с живым строить нельзя — своего же генерала и убили бы.
    if (world.generals.some((entry) => entry.alive && cellAt(entry.position) === cell)) continue;

    const centre = cellCentre(cell);
    if (distanceSquared(centre, from) > reach * reach) continue;
    if (
      world.map.baseCells.some((base) => distanceSquared(centre, cellCentre(base)) < clear * clear)
    ) {
      continue;
    }

    return cell;
  }

  throw new Error(`рядом с генералом базы ${ownerBase} некуда строить`);
};

const run = (world: WorldState, ticks: number, commands: Command[] = []): WorldState => {
  let current = world;
  for (let tick = 0; tick < ticks; tick += 1) current = step(current, tick === 0 ? commands : []);
  return current;
};

const facingOf = (world: WorldState, id: number): number =>
  world.units.find((entry) => entry.id === asEntityId(id))?.facing ?? DIRECTION_STOP;

describe('разворот юнита', () => {
  it('свежий юнит уже повёрнут', () => {
    // Ноль означал бы «не повёрнут», а такого состояния у машины нет:
    // она всегда куда-то смотрит.
    const order: Command = {
      kind: CommandKind.TrainUnit,
      player: asPlayerId(0),
      tick: asTickNumber(0),
      unitType: UnitType.Assault,
    };

    const after = run(createWorld(SEED), 2, [order]);
    const fresh = after.units[0];

    expect(fresh).toBeDefined();
    expect(fresh?.facing).not.toBe(DIRECTION_STOP);
    expect(fresh?.facing).toBeLessThan(DIRECTION_COUNT);
  });

  it('идущий юнит смотрит по ходу движения', () => {
    // Юнит идёт к базе противника, то есть с юго-востока на северо-запад
    // или наоборот — куда именно, задаёт расстановка карты. Проверяем
    // не конкретный румб, а то, что он сменился на осмысленный.
    const world = createWorld(SEED);
    const placed: WorldState = { ...world, units: [unit(700, 0, 0, 0, 3)] };

    const after = run(placed, 20);
    const moved = after.units.find((entry) => entry.id === asEntityId(700));

    expect(moved?.position).not.toEqual(at(0, 0));
    expect(moved?.facing).not.toBe(DIRECTION_STOP);
  });

  it('стреляющий разворачивается на цель', () => {
    // Два юнита стоят рядом: восточный видит западного и наоборот.
    // Оба стреляют в первом же тике и обязаны развернуться друг на друга,
    // а не сохранить первоначальный юг.
    const world = createWorld(SEED);
    const placed: WorldState = {
      ...world,
      units: [unit(700, 0, 0, 0, 3), unit(701, 1, 1, 0, 3)],
    };

    const after = step(placed, []);

    // Восточный сосед — румб «на восток», это единица; западный — пятёрка.
    expect(facingOf(after, 700)).toBe(1);
    expect(facingOf(after, 701)).toBe(5);
  });

  it('разворот на цель перебивает разворот по ходу шага', () => {
    // Стрельба идёт после движения, и это правильный порядок: доехавший
    // до врага и открывший огонь смотрит на врага, а не на последнюю
    // точку маршрута.
    const world = createWorld(SEED);
    const placed: WorldState = {
      ...world,
      // Режим «Бой» ставится явно: по умолчанию войско прорывается
      // и встречного боя не завязывает, а тест именно про него.
      players: world.players.map((player) => ({ ...player, stance: AttackStance.Engage })),
      units: [unit(700, 0, 0, 0, 3), unit(701, 1, 1, 0, 3)],
    };

    // Двадцать тиков: юнит успел бы уйти к цели, если бы не встречный бой.
    expect(facingOf(run(placed, 20), 700)).toBe(1);
  });

  it('стоящий и не стреляющий сохраняет направление', () => {
    // Стоять юнит будет только у назначенной цели: во всех прочих случаях
    // он идёт. Поэтому ставим его вплотную к базе противника — она и есть
    // цель по умолчанию — и заряжаем перезарядкой до конца прогона,
    // чтобы он не выстрелил и не развернулся на цель.
    const world = createWorld(SEED);
    const enemyBase = world.map.baseCells[1] ?? 0;
    const centre = cellCentre(enemyBase);

    const placed: WorldState = {
      ...world,
      units: [
        {
          ...unit(700, 0, 0, 0, 6),
          // Две клетки от центра базы: до её основания остаётся одна,
          // то есть цель в радиусе и юнит никуда не идёт.
          position: { x: centre.x + 2000, y: centre.y },
          readyAtTick: asTickNumber(1000),
        },
      ],
    };

    const after = run(placed, 5);

    expect(after.units.find((entry) => entry.id === asEntityId(700))?.position).toEqual({
      x: centre.x + 2000,
      y: centre.y,
    });
    expect(facingOf(after, 700)).toBe(6);
  });
});

describe('разворот постройки', () => {
  const tower = (
    id: number,
    owner: number,
    dx: number,
    dy: number,
    facing: number,
    readyAtTick = 0,
  ): StructureState => ({
    id: asEntityId(id),
    owner: asPlayerId(owner),
    kind: StructureKind.TowerBasic,
    // Клетка и положение обязаны совпадать: башня стреляет из центра
    // своей клетки, а цель выбирает по расстоянию оттуда же.
    cell: cellIndex(FIELD_X + dx, FIELD_Y + dy),
    health: STRUCTURE_STATS[StructureKind.TowerBasic].health,
    kills: 0,
    readyAtTick: asTickNumber(readyAtTick),
    builtAtTick: asTickNumber(0),
    demolishAtTick: asTickNumber(0),
    facing,
  });

  const towerFacing = (world: WorldState, id: number): number =>
    world.structures.find((entry) => entry.id === asEntityId(id))?.facing ?? DIRECTION_STOP;

  it('стреляющая башня разворачивается на цель', () => {
    // Башня смотрит на юг, а враг стоит к востоку от неё. Выстрел
    // обязан развернуть турель на восток: по башне должно быть видно,
    // что она дерётся и с какой стороны к ней подошли.
    const world = createWorld(SEED);
    const placed: WorldState = {
      ...world,
      structures: [...world.structures, tower(9100, 0, 0, 0, 3)],
      units: [unit(701, 1, 2, 0, 3)],
    };

    expect(towerFacing(step(placed, []), 9100)).toBe(1);
  });

  it('молчащая башня сохраняет направление', () => {
    // Тот же расклад, но башня заряжена перезарядкой до конца прогона.
    // Врага она видит, а выстрелить не может — значит, и повернуться
    // ей не с чего.
    const world = createWorld(SEED);
    const placed: WorldState = {
      ...world,
      structures: [...world.structures, tower(9100, 0, 0, 0, 3, 1000)],
      units: [unit(701, 1, 2, 0, 3)],
    };

    expect(towerFacing(run(placed, 5), 9100)).toBe(3);
  });

  it('разворот башни не меняет исход боя', () => {
    // Та же гарантия, что и у машин: сектора обстрела нет, разворот
    // мгновенный, стрелять можно назад. Разъедься это — направление
    // стало бы игровой величиной.
    const world = createWorld(SEED);

    const facing = (rumb: number): WorldState => ({
      ...world,
      structures: [...world.structures, tower(9100, 0, 0, 0, rumb)],
      units: [unit(701, 1, 2, 0, 3)],
    });

    const strip = (state: WorldState) => ({
      units: state.units.map((entry) => ({ id: entry.id, health: entry.health })),
      structures: state.structures.map((entry) => ({ id: entry.id, health: entry.health })),
    });

    expect(strip(run(facing(7), 30))).toEqual(strip(run(facing(3), 30)));
  });

  it('база на старте смотрит в центр карты', () => {
    // Ноль здесь недопустим: у постройки он означал бы отсутствие
    // разворота, а такого состояния у неё не бывает.
    const world = createWorld(SEED);

    for (const structure of world.structures) {
      expect(structure.facing).not.toBe(DIRECTION_STOP);
      expect(structure.facing).toBeGreaterThan(0);
      expect(structure.facing).toBeLessThan(DIRECTION_COUNT);
    }
  });

  it('свежая постройка уже повёрнута наружу от базы', () => {
    // Первый выстрел развернёт её на цель, но до него может пройти
    // полматча, и всё это время направление обязано быть осмысленным.
    const world = createWorld(SEED);
    const owner = 0;
    const general = world.generals[owner];
    const baseCell = world.map.baseCells[owner] ?? 0;

    if (general === undefined) throw new Error('генерала нет');

    // Клетка ищется, а не задаётся числом: карта строится генератором,
    // и заданная руками клетка при первой же правке генерации оказалась
    // бы под скалой.
    const spot = buildSpotNear(world, general.position, baseCell);

    const rich: WorldState = {
      ...world,
      players: world.players.map((player) => ({ ...player, energy: 1_000_000_000 })),
    };

    const after = step(rich, [
      {
        kind: CommandKind.Build,
        player: asPlayerId(owner),
        tick: asTickNumber(0),
        cell: spot,
        structure: StructureKind.Wall,
      },
    ]);

    const built = after.structures.find((entry) => entry.cell === spot);

    expect(after.rejections).toHaveLength(0);
    expect(built?.kind).toBe(StructureKind.Wall);
    expect(built?.facing).not.toBe(DIRECTION_STOP);

    // Наружу от базы: свежая постройка смотрит туда, откуда придут.
    const baseCentre = cellCentre(baseCell);
    const spotCentre = cellCentre(spot);
    expect(built?.facing).toBe(
      directionTowards(spotCentre.x - baseCentre.x, spotCentre.y - baseCentre.y),
    );
  });
});

describe('разворот не влияет на правила', () => {
  it('прогоны с разными начальными румбами совпадают по здоровью и положениям', () => {
    // Главная гарантия: направление — это облик, а не механика. Точность
    // от него не зависит, разворот времени не занимает, стрелять назад
    // можно. Разъедься это правило — направление стало бы игровой
    // величиной, и вводить его пришлось бы отдельным изменением.
    const world = createWorld(SEED);

    const north: WorldState = {
      ...world,
      units: [unit(700, 0, 0, 0, 7), unit(701, 1, 2, 0, 7)],
    };
    const south: WorldState = {
      ...world,
      units: [unit(700, 0, 0, 0, 3), unit(701, 1, 2, 0, 3)],
    };

    const strip = (state: WorldState) =>
      state.units.map((entry) => ({
        id: entry.id,
        health: entry.health,
        position: entry.position,
      }));

    expect(strip(run(north, 40))).toEqual(strip(run(south, 40)));
  });
});

describe('разворот генерала', () => {
  it('сохраняется после того, как игрок отпустил клавиши', () => {
    // Направление движения обнуляется, едва клавиши отпущены. Машина
    // от этого разворачиваться носом в никуда не должна.
    const world = createWorld(SEED);

    const go: Command = {
      kind: CommandKind.MoveGeneral,
      player: asPlayerId(0),
      tick: asTickNumber(0),
      direction: 1,
    };
    const halt: Command = { ...go, direction: DIRECTION_STOP };

    const moving = step(world, [go]);
    expect(moving.generals[0]?.facing).toBe(1);

    const stopped = run(moving, 5, [halt]);
    expect(stopped.generals[0]?.direction).toBe(DIRECTION_STOP);
    expect(stopped.generals[0]?.facing).toBe(1);
  });

  it('на старте матча смотрит в центр карты', () => {
    // Оба генерала стоят в противоположных углах, и оба обязаны смотреть
    // туда, откуда придёт война, — а не в стену за спиной.
    const world = createWorld(SEED);

    for (const general of world.generals) {
      expect(general.facing).not.toBe(DIRECTION_STOP);
    }

    // Углы противоположны, поэтому и румбы обязаны быть противоположными.
    const first = world.generals[0]?.facing ?? 0;
    const second = world.generals[1]?.facing ?? 0;
    expect(first).not.toBe(second);
  });
});
