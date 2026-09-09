import type { AttackStance } from '@td/shared';
import {
  MAP_CELL_COUNT,
  StructureKind,
  UnitType,
  asEntityId,
  asPlayerId,
  asTickNumber,
} from '@td/shared';
import { createWorld } from './world.js';
import type { WorldState } from './world.js';
import { cellCentre, cellIndex } from './map.js';

export interface AssaultScene {
  name: string;
  assigned: boolean;
  stance: AttackStance;
  reply: boolean;
  count: number;
  start: number;
  wall?: 'bypass' | 'breach';
  distraction?: boolean;
  crowd?: boolean;
  expected: 'tower-destroyed' | 'attacker-died' | 'cap';
}

/** Запас покрывает осевой подход и 100 перезарядок для пролома стены. */
export const ASSAULT_SCENE_CAP = 4200;
export const assaultSceneWorld = (scene: AssaultScene): WorldState => {
  const world = createWorld(42);
  const tower = {
    id: asEntityId(10),
    owner: asPlayerId(1),
    kind: StructureKind.TowerBasic,
    cell: cellIndex(20, 20),
    health: 200,
    kills: 0,
    readyAtTick: asTickNumber(scene.reply ? 0 : ASSAULT_SCENE_CAP + 1),
    builtAtTick: asTickNumber(0),
    demolishAtTick: asTickNumber(0),
    facing: 1,
  };
  const walls =
    scene.wall === undefined
      ? []
      : (scene.wall === 'breach' ? Array.from({ length: 38 }, (_, i) => i) : [19, 20, 21]).map(
          (y, i) => ({
            ...tower,
            id: asEntityId(100 + i),
            kind: StructureKind.Wall,
            cell: cellIndex(19, y),
            health: 1000,
          }),
        );
  const units = Array.from({ length: scene.count }, (_, i) => ({
    id: asEntityId(20 + i),
    owner: asPlayerId(0),
    unitType: UnitType.Assault,
    position: scene.crowd
      ? cellCentre(cellIndex(scene.start, 20))
      : { x: scene.start * 1000 + 500, y: 20500 + (i - Math.floor(scene.count / 2)) * 500 },
    health: 100,
    kills: 0,
    facing: 1,
    readyAtTick: asTickNumber(0),
  }));
  if (scene.distraction)
    units.push({
      ...units[0]!,
      id: asEntityId(50),
      owner: asPlayerId(1),
      health: 10000,
      position: cellCentre(cellIndex(18, 21)),
      readyAtTick: asTickNumber(ASSAULT_SCENE_CAP + 1),
    });
  return {
    ...world,
    map: { ...world.map, cells: new Uint8Array(MAP_CELL_COUNT) },
    nav: [],
    structures: [...world.structures, tower, ...walls],
    units,
    generals: [],
    nextEntityId: 200,
    players: world.players.map((p) => ({
      ...p,
      stance: scene.stance,
      targetStructure: scene.assigned && p.id === 0 ? tower.id : p.targetStructure,
    })),
  };
};
