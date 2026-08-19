import { describe, expect, it } from 'vitest';
import { CommandKind, asPlayerId, asTickNumber, cellsToUnits, vec2 } from '@td/shared';
import type { Command } from '@td/shared';
import { createWorld, STARTING_GOLD } from './world.js';
import { step } from './step.js';

const placeTower = (x: number, y: number): Command => ({
  kind: CommandKind.PlaceTower,
  player: asPlayerId(0),
  tick: asTickNumber(0),
  position: vec2(cellsToUnits(x), cellsToUnits(y)),
  towerType: 0,
});

describe('шаг симуляции', () => {
  it('не мутирует входное состояние', () => {
    const world = createWorld(42);
    const snapshot = structuredClone(world);

    step(world, [placeTower(3, 3)]);

    expect(world).toEqual(snapshot);
  });

  it('увеличивает номер тика ровно на единицу', () => {
    const world = createWorld(42);
    expect(step(world, []).tick).toBe(1);
  });

  it('ставит башню и списывает золото', () => {
    const after = step(createWorld(42), [placeTower(3, 3)]);

    expect(after.towers).toHaveLength(1);
    expect(after.players[0]?.gold).toBeLessThan(STARTING_GOLD);
  });

  it('не даёт поставить две башни в одну клетку', () => {
    const after = step(createWorld(42), [placeTower(3, 3), placeTower(3, 3)]);

    expect(after.towers).toHaveLength(1);
  });

  it('игнорирует постройку при нехватке золота', () => {
    let world = createWorld(42);
    // Ставим башни, пока золото не кончится.
    for (let index = 0; index < 10; index += 1) {
      world = step(world, [placeTower(index, 0)]);
    }

    expect(world.players[0]?.gold).toBeGreaterThanOrEqual(0);
    expect(world.towers.length).toBeLessThan(10);
  });
});
