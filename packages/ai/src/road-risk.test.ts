import { describe, expect, it } from 'vitest';
import {
  DIRECTION_SOUTH,
  PPM_ONE,
  STRUCTURE_STATS,
  StructureKind,
  UNIT_STATS,
  UnitType,
  asEntityId,
  asPlayerId,
  asTickNumber,
  cellsToUnits,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { UNREACHABLE, cellAt, cellCentre, createWorld, playerStats } from '@td/sim';
import type { WorldState } from '@td/sim';
import { approachOf, otherPlayer, walkField } from './approach.js';
import { incomingAt, probeRoute } from './posture.js';

/**
 * Опасность дороги к рубежу.
 *
 * Прежняя оценка отвечала на вопрос «опасно ли СТОЯТЬ там», а генерал
 * гибнет по пути: она объявляла гибель невозможной в 88% решений при том,
 * что пятую часть матча генерал проводил мёртвым. Здесь проверяются три
 * слепые зоны, каждая из которых занижала опасность.
 */

const SEED = 20260821;
const ME: PlayerId = asPlayerId(0);
const ENEMY: PlayerId = asPlayerId(1);

const statsOf = (world: WorldState, player: PlayerId) => {
  const state = world.players[player];
  if (state === undefined) throw new Error('нет игрока');
  return playerStats(state);
};

const enemyTowerAt = (cell: number, builtAtTick: number) => ({
  id: asEntityId(8100),
  owner: ENEMY,
  kind: StructureKind.TowerBasic,
  cell,
  health: STRUCTURE_STATS[StructureKind.TowerBasic].health,
  growthPpm: PPM_ONE,
  readyAtTick: asTickNumber(0),
  builtAtTick: asTickNumber(builtAtTick),
});

describe('пробы ложатся на маршрут генерала', () => {
  it('дорога идёт от генерала к рубежу и приближается к нему шаг за шагом', () => {
    const world = createWorld(SEED);
    const approach = approachOf(world, ME);
    if (approach === undefined) throw new Error('вероятный путь не посчитан');

    const general = world.generals[ME];
    if (general === undefined) throw new Error('нет генерала');

    // Поле расстояний ОТ ГЕНЕРАЛА — то же самое, каким пользуется оценка.
    // Именно от него, а не от базы: клетка базы занята постройкой,
    // и разлив от неё не начинается.
    const reach = walkField(approach.occupancy, [cellAt(general.position)]);

    // Достижимость проверяется явно: сентинел недостижимости — большое
    // число, и сравнение «дальше десяти клеток» ему тоже удовлетворяет.
    const frontier = approach.onPath.findIndex((onPath, cell) => {
      const distance = reach[cell] ?? UNREACHABLE;
      return onPath === 1 && distance !== UNREACHABLE && distance > 10;
    });
    expect(frontier).toBeGreaterThan(0);

    const probes = probeRoute(reach, frontier, 4);

    expect(probes.length).toBe(4);
    // Последняя проба — сам рубеж: там генерал и остановится.
    expect(probes[probes.length - 1]).toBe(frontier);

    // Расстояние от генерала растёт вдоль дороги: пробы идут в ту сторону,
    // в которую он пойдёт, а не куда попало.
    for (let index = 1; index < probes.length; index += 1) {
      const before = reach[probes[index - 1] ?? 0] ?? UNREACHABLE;
      const after = reach[probes[index] ?? 0] ?? UNREACHABLE;

      expect(after).toBeGreaterThan(before);
    }
  });

  it('нулевое число проб даёт пустую дорогу', () => {
    const world = createWorld(SEED);
    const approach = approachOf(world, ME);
    if (approach === undefined) throw new Error('вероятный путь не посчитан');

    expect(probeRoute(walkField(approach.occupancy, [0]), 100, 0)).toHaveLength(0);
  });
});

describe('опасность считается на момент прихода, а не на момент решения', () => {
  it('заложенная башня входит в оценку, если достроится раньше прихода', () => {
    const world = createWorld(SEED);
    const spot = world.map.baseCells[ME] ?? 0;
    const beside = spot + 1;

    const soon: WorldState = {
      ...world,
      structures: [...world.structures, enemyTowerAt(beside, world.tick + 100)],
    };

    const stats = statsOf(world, ENEMY);
    const point = cellCentre(spot);

    // Сейчас она не стреляет — и в оценке «прямо сейчас» её нет.
    expect(incomingAt(soon, ME, stats, point, 0).fromStructures).toBe(0);
    // А к приходу генерала уже стреляет.
    expect(incomingAt(soon, ME, stats, point, 200).fromStructures).toBeGreaterThan(0);
  });

  it('подходящий отряд перестаёт считаться безопасным', () => {
    const world = createWorld(SEED);
    const home = world.map.baseCells[ME] ?? 0;
    const enemyBase = world.map.baseCells[otherPlayer(ME)] ?? 0;

    // Точка между базами, ближе к нашей: вражеские войска идут через неё.
    const point = cellCentre(home);
    const stats = statsOf(world, ENEMY);

    const speed = UNIT_STATS[UnitType.Assault].speed;
    const far = cellCentre(enemyBase);

    const marching: WorldState = {
      ...world,
      units: [
        {
          id: asEntityId(8200),
          owner: ENEMY,
          unitType: UnitType.Assault,
          position: far,
          health: UNIT_STATS[UnitType.Assault].health,
          facing: DIRECTION_SOUTH,
          readyAtTick: asTickNumber(0),
        },
      ],
    };

    // Прямо сейчас он далеко и не достаёт.
    expect(incomingAt(marching, ME, stats, point, 0).total).toBe(0);

    // За время, которого хватает пересечь карту, он дойдёт — и достанет.
    const crossing = Math.ceil(cellsToUnits(64) / Math.max(1, speed));
    expect(incomingAt(marching, ME, stats, point, crossing).total).toBeGreaterThan(0);
  });

  it('отряд, идущий мимо, опасностью не считается', () => {
    // Иначе каждый вражеский юнит на карте считался бы бегущим к нам,
    // и генерал не вышел бы из дома вовсе.
    const world = createWorld(SEED);
    const enemyBase = world.map.baseCells[otherPlayer(ME)] ?? 0;
    const stats = statsOf(world, ENEMY);

    // Точка у ЧУЖОЙ базы: она дальше от цели вражеских войск (нашей базы),
    // чем сами войска, стоящие там же.
    const point = cellCentre(enemyBase);

    const idle: WorldState = {
      ...world,
      // Вражеский генерал убран: он стоит у своей базы и достаёт до точки
      // сам, а проверяем мы поведение ЮНИТА.
      generals: world.generals.map((general) =>
        general.owner === ENEMY ? { ...general, alive: false } : general,
      ),
      units: [
        {
          id: asEntityId(8300),
          owner: ENEMY,
          unitType: UnitType.Assault,
          position: cellCentre(world.map.baseCells[ME] ?? 0),
          health: UNIT_STATS[UnitType.Assault].health,
          facing: DIRECTION_SOUTH,
          readyAtTick: asTickNumber(0),
        },
      ],
    };

    expect(incomingAt(idle, ME, stats, point, 10_000).total).toBe(0);
  });
});
