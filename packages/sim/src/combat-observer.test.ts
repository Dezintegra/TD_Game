import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AttackStance,
  MAP_CELL_COUNT,
  StructureKind,
  UnitType,
  asEntityId,
  asPlayerId,
  asTickNumber,
  resetRuleTuning,
} from '@td/shared';
import { createWorld } from './world.js';
import type { WorldState } from './world.js';
import { cellCentre, cellIndex } from './map.js';
import { step } from './step.js';
import { toWorking } from './working.js';
import { moveUnits } from './movement.js';
import { allPlayerStats } from './stats.js';
import { buildCombatIndices } from './combat.js';
import { UNREACHABLE } from './navigation.js';
import type { CombatObservation } from './combat-observer.js';

afterEach(resetRuleTuning);

const scene = (assigned = true, stance: AttackStance = AttackStance.Engage): WorldState => {
  const world = createWorld(42);
  return {
    ...world,
    map: { ...world.map, cells: new Uint8Array(MAP_CELL_COUNT) },
    nav: [],
    players: world.players.map((p) => ({
      ...p,
      stance,
      targetStructure: assigned && p.id === 0 ? asEntityId(10) : p.targetStructure,
    })),
    generals: [],
    structures: [
      ...world.structures,
      {
        id: asEntityId(10),
        owner: asPlayerId(1),
        kind: StructureKind.TowerBasic,
        cell: cellIndex(20, 20),
        health: 200,
        kills: 0,
        readyAtTick: asTickNumber(100),
        builtAtTick: asTickNumber(0),
        demolishAtTick: asTickNumber(0),
        facing: 1,
      },
    ],
    units: [
      {
        id: asEntityId(11),
        owner: asPlayerId(0),
        unitType: UnitType.Assault,
        position: cellCentre(cellIndex(17, 20)),
        health: 100,
        kills: 0,
        facing: 1,
        readyAtTick: asTickNumber(0),
      },
    ],
    nextEntityId: 12,
  };
};

const observe = (world: WorldState) => {
  const events: CombatObservation[] = [];
  const result = step(world, [], (event) => events.push(event));
  expect(result).toEqual(step(world, []));
  return { result, events, motion: events.find((e) => e.type === 'assault-motion') };
};

describe('факты движения Assault', () => {
  it('nuke завершает тик после выстрела и сохраняет оба погибших объекта', () => {
    const world = scene();
    const { events } = observe({
      ...world,
      nukes: [
        {
          id: asEntityId(20),
          owner: asPlayerId(1),
          cell: cellIndex(19, 20),
          radius: 5000,
          damage: 1000,
          detonateAtTick: asTickNumber(1),
        },
      ],
    });
    const terminal = events.filter((e) => e.type === 'assault-terminal');
    expect(terminal).toMatchObject([
      { phase: 'nuke', entity: { id: 11 }, healthAfter: -900 },
      { phase: 'nuke', entity: { id: 10 }, healthAfter: -810 },
    ]);
    expect(events.findIndex((e) => e.type === 'assault-shot')).toBeLessThan(
      events.indexOf(terminal[0]!),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'assault-end-tick',
      participants: [
        { id: 11, alive: false, health: -900 },
        { id: 10, alive: false, health: -810 },
      ],
    });
  });

  it('собственный разбор отличается от урона и сохраняется на тике победы', () => {
    const world = scene();
    const { events } = observe({
      ...world,
      structures: world.structures
        .filter((s) => s.owner === 1)
        .map((s) => (s.id === 10 ? { ...s, demolishAtTick: asTickNumber(1) } : s)),
    });
    expect(events.find((e) => e.type === 'assault-terminal')).toMatchObject({
      phase: 'demolition',
      reason: 'demolition',
      entity: { id: 10 },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'assault-end-tick',
      winner: 1,
      participants: expect.arrayContaining([expect.objectContaining({ id: 10, alive: false })]),
    });
  });

  it('конец тика хранит HP башни после позднего взрыва', () => {
    const world = scene();
    const { events } = observe({
      ...world,
      nukes: [
        {
          id: asEntityId(20),
          owner: asPlayerId(1),
          cell: cellIndex(20, 20),
          radius: 1000,
          damage: 50,
          detonateAtTick: asTickNumber(1),
        },
      ],
    });
    expect(events.find((e) => e.type === 'assault-shot')).toMatchObject({ healthAfter: 190 });
    expect(events.at(-1)).toMatchObject({
      participants: expect.arrayContaining([expect.objectContaining({ id: 10, health: 140 })]),
    });
  });
  it('выстрел сохраняет прямую цель, урон и добивание', () => {
    const world = scene();
    const { events } = observe({
      ...world,
      structures: world.structures.map((s) => (s.id === 10 ? { ...s, health: 1 } : s)),
    });
    expect(events.find((e) => e.type === 'assault-shot')).toMatchObject({
      target: { kind: 'structure', id: 10 },
      damage: 10,
      healthBefore: 1,
      healthAfter: -9,
      healthLost: 1,
      lethal: true,
      readyAtTick: 31,
      cooldown: 30,
    });
  });

  it('перезарядка и гибель до стрельбы не создают выстрел', () => {
    const world = scene();
    expect(
      observe({
        ...world,
        units: world.units.map((u) => ({ ...u, readyAtTick: asTickNumber(100) })),
      }).events.some((e) => e.type === 'assault-shot'),
    ).toBe(false);
    const dead = {
      ...world,
      units: world.units.map((u) => ({ ...u, health: 1 })),
      structures: world.structures.map((s) => ({ ...s, readyAtTick: asTickNumber(0) })),
    };
    expect(observe(dead).events.some((e) => e.type === 'assault-shot')).toBe(false);
  });

  it('встречный юнит получает выстрел вместо башни', () => {
    const world = scene(false);
    const { events } = observe({
      ...world,
      units: [
        ...world.units,
        {
          ...world.units[0]!,
          id: asEntityId(12),
          owner: asPlayerId(1),
          position: cellCentre(cellIndex(18, 21)),
          readyAtTick: asTickNumber(100),
        },
      ],
    });
    expect(events.find((e) => e.type === 'assault-shot')).toMatchObject({
      target: { kind: 'unit', id: 12 },
    });
  });
  it.each([false, true])('различает отсутствие шага и пролом: %s', (breach) => {
    const world = scene(false, AttackStance.Breakthrough);
    const working = toWorking({
      ...world,
      structures: [
        ...world.structures,
        {
          ...world.structures[2]!,
          id: asEntityId(12),
          kind: StructureKind.Wall,
          cell: cellIndex(18, 20),
        },
      ],
    });
    const distances = new Int32Array(MAP_CELL_COUNT).fill(UNREACHABLE);
    if (breach) distances[cellIndex(18, 20)] = 1;
    working.nav[0] = {
      walk: new Int32Array(MAP_CELL_COUNT).fill(UNREACHABLE),
      breach: distances,
      revision: 0,
      computedAtTick: asTickNumber(0),
    };
    const observer = vi.fn();
    working.observation = { observer, sequence: 0 };
    moveUnits(working, allPlayerStats(working.players), buildCombatIndices(working));
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({ reason: breach ? 'obstacle' : 'no-step', visible: null }),
    );
    if (breach) expect(observer.mock.calls[0]?.[0].witness.id).toBe(12);
  });

  it('живой встречный имеет приоритет остановки перед башней', () => {
    const world = scene(false);
    const unit = world.units[0]!;
    const { motion } = observe({
      ...world,
      units: [
        ...world.units,
        {
          ...unit,
          id: asEntityId(12),
          owner: asPlayerId(1),
          position: cellCentre(cellIndex(18, 21)),
        },
      ],
    });
    expect(motion).toMatchObject({ reason: 'hostile', witness: { kind: 'unit', id: 12 } });
  });
  it.each([AttackStance.Engage, AttackStance.Breakthrough])(
    'назначенная башня останавливает в stance %s',
    (stance) => {
      const { motion, events } = observe(scene(true, stance));
      expect(motion).toMatchObject({
        reason: 'assigned-target',
        witness: { id: 10 },
        visible: true,
        tick: 1,
        distanceSquared: 6250000,
      });
      expect(events.map((e) => e.sequence)).toEqual(events.map((_e, i) => i));
    },
  );

  it('встречная башня останавливает только Engage', () => {
    expect(observe(scene(false)).motion?.reason).toBe('armed-structure');
    expect(observe(scene(false, AttackStance.Breakthrough)).motion?.reason).toBe('step');
  });

  it('стена закрывает встречную башню, не становясь стреляющей целью', () => {
    const world = scene(false);
    const tower = world.structures[2]!;
    const blocked = {
      ...world,
      structures: [
        ...world.structures,
        { ...tower, id: asEntityId(12), kind: StructureKind.Wall, cell: cellIndex(19, 20) },
      ],
    };
    expect(observe(blocked).motion?.reason).toBe('step');
  });

  it('отсутствие навигации имеет собственную причину', () => {
    const working = toWorking(scene(false, AttackStance.Breakthrough));
    const observer = vi.fn();
    working.observation = { observer, sequence: 0 };
    moveUnits(working, allPlayerStats(working.players), buildCombatIndices(working));
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'no-navigation', visible: null }),
    );
  });

  it('правка DTO не меняет мир и расталкивание записано отдельно', () => {
    const world = scene();
    const unit = world.units[0]!;
    const crowded = { ...world, units: [...world.units, { ...unit, id: asEntityId(12) }] };
    const { events, motion } = observe(crowded);
    const position = events.find((e) => e.type === 'assault-position');
    expect(position?.type === 'assault-position' && position.position).not.toEqual(motion?.after);
    expect(
      step(crowded, [], (event) => {
        if (event.type === 'assault-motion') {
          Object.assign(event.before, { x: -999 });
          Object.assign(event.after, { x: -999 });
          event.unit.id = -1;
        }
      }),
    ).toEqual(step(crowded, []));
  });
});
