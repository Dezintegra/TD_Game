import { describe, expect, it } from 'vitest';
import {
  CommandKind,
  PPM_ONE,
  STRUCTURE_STATS,
  StructureKind,
  asEntityId,
  asPlayerId,
  asTickNumber,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { UNREACHABLE, createWorld } from '@td/sim';
import type { StructureState, WorldState } from '@td/sim';
import { approachOf, otherPlayer } from './approach.js';
import { createOpponent } from './opponent.js';

/**
 * Выбор общей цели войска.
 *
 * Проверяется одно свойство и его следствия: войско нацеливается
 * на башню, стоящую у него на пути, а не идёт сквозь её огонь к базе.
 * Юнит останавливается только у назначенной цели, поэтому цель — это
 * единственный рычаг, которым противник может заставить войско вскрывать
 * оборону, а не гибнуть в ней.
 */

const SEED = 20260821;
const ME: PlayerId = asPlayerId(1);

/** Клетки вероятного пути, упорядоченные по удалению от своей базы. */
const pathCells = (world: WorldState): readonly number[] => {
  const approach = approachOf(world, ME);
  if (approach === undefined) throw new Error('вероятный путь не посчитан');

  const cells: number[] = [];
  for (let cell = 0; cell < approach.onPath.length; cell += 1) {
    if (approach.onPath[cell] !== 1) continue;
    if ((approach.fromHome[cell] ?? UNREACHABLE) === UNREACHABLE) continue;

    cells.push(cell);
  }

  return cells.sort(
    (left, right) => (approach.fromHome[left] ?? 0) - (approach.fromHome[right] ?? 0),
  );
};

const enemyStructure = (cell: number, kind: StructureKind, id: number): StructureState => ({
  id: asEntityId(id),
  owner: asPlayerId(otherPlayer(ME)),
  kind,
  cell,
  health: STRUCTURE_STATS[kind].health,
  growthPpm: PPM_ONE,
  readyAtTick: asTickNumber(0),
  builtAtTick: asTickNumber(0),
});

const withStructures = (world: WorldState, extra: readonly StructureState[]): WorldState => ({
  ...world,
  structures: [...world.structures, ...extra],
});

/**
 * Клетка, назначенная целью на первом же решении.
 *
 * Прежняя цель сбрасывается: команда не отдаётся, когда цель уже та самая,
 * и без сброса тест читал бы молчание как «цели нет».
 */
const targetCell = (world: WorldState): number | undefined => {
  const reset: WorldState = {
    ...world,
    players: world.players.map((player) => ({ ...player, targetStructure: asEntityId(0) })),
  };

  const commands = createOpponent(ME, SEED).decide(reset);
  const target = commands.find((command) => command.kind === CommandKind.SetTarget);

  return target?.cell;
};

const enemyBaseCell = (world: WorldState): number => {
  const cell = world.map.baseCells[otherPlayer(ME)];
  if (cell === undefined) throw new Error('нет базы противника');
  return cell;
};

describe('цель войска выбирается по вероятному пути', () => {
  it('башня на пути становится целью вместо базы', () => {
    // Главная проверка изменения. Прежнее правило смотрело только
    // на свою половину карты, и башни у чужой базы целью не становились
    // ни разу за матч — волна шла сквозь них.
    const world = createWorld(SEED);
    const cells = pathCells(world);
    const far = cells[Math.floor(cells.length * 0.8)];
    if (far === undefined) throw new Error('на пути нет клеток');

    const withTower = withStructures(world, [
      enemyStructure(far, StructureKind.TowerBasic, 9001),
    ]);

    expect(targetCell(withTower)).toBe(far);
    expect(targetCell(withTower)).not.toBe(enemyBaseCell(world));
  });

  it('из двух башен на пути выбирается ближняя по проходимым клеткам', () => {
    const world = createWorld(SEED);
    const cells = pathCells(world);
    const near = cells[Math.floor(cells.length * 0.4)];
    const far = cells[Math.floor(cells.length * 0.8)];
    if (near === undefined || far === undefined) throw new Error('на пути мало клеток');

    // Дальняя добавлена первой: если бы выбор зависел от порядка перебора,
    // тест бы это поймал.
    const withTowers = withStructures(world, [
      enemyStructure(far, StructureKind.TowerBasic, 9002),
      enemyStructure(near, StructureKind.TowerBasic, 9003),
    ]);

    expect(targetCell(withTowers)).toBe(near);
  });

  it('стена целью не становится', () => {
    // Стена не наносит урона, и сносить её войску незачем: условие
    // «стреляет» отсекает её без отдельного правила.
    const world = createWorld(SEED);
    const cells = pathCells(world);
    const spot = cells[Math.floor(cells.length * 0.6)];
    if (spot === undefined) throw new Error('на пути нет клеток');

    const withWall = withStructures(world, [enemyStructure(spot, StructureKind.Wall, 9004)]);

    expect(targetCell(withWall)).toBe(enemyBaseCell(world));
  });

  it('при чистом пути целью остаётся база', () => {
    expect(targetCell(createWorld(SEED))).toBe(enemyBaseCell(createWorld(SEED)));
  });
});
