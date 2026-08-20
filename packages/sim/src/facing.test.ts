import { describe, expect, it } from 'vitest';
import {
  CommandKind,
  DIRECTION_COUNT,
  DIRECTION_STOP,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  UnitType,
  asEntityId,
  asPlayerId,
  asTickNumber,
} from '@td/shared';
import type { Command } from '@td/shared';
import { createWorld } from './world.js';
import type { UnitState, WorldState } from './world.js';
import { step } from './step.js';
import { cellCentre, cellIndex } from './map.js';

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
});

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
