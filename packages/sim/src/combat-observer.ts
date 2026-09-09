import { UnitType, isArmedStructure } from '@td/shared';
import type { AttackStance, Vec2 } from '@td/shared';
import type { Working } from './working.js';

export interface CombatIdentity {
  kind: 'unit' | 'structure' | 'general';
  id: number;
  owner: number;
  subtype: number | null;
}

export type MotionReason =
  | 'assigned-target'
  | 'hostile'
  | 'armed-structure'
  | 'obstacle'
  | 'no-navigation'
  | 'no-step'
  | 'occupancy'
  | 'step';

export interface AssaultMotion {
  type: 'assault-motion';
  tick: number;
  sequence: number;
  phase: 'movement';
  unit: CombatIdentity;
  stance: AttackStance;
  targetStructure: number | null;
  range: number;
  readyAtTick: number;
  cooldown: number;
  before: Vec2;
  after: Vec2;
  reason: MotionReason;
  witness: CombatIdentity | null;
  distanceSquared: number | null;
  visible: boolean | null;
}

export interface AssaultPosition {
  type: 'assault-position';
  tick: number;
  sequence: number;
  phase: 'post-crowd';
  unit: CombatIdentity;
  position: Vec2;
}

export interface AssaultShot {
  type: 'assault-shot';
  tick: number;
  sequence: number;
  phase: 'combat';
  shooter: CombatIdentity;
  target: CombatIdentity;
  from: Vec2;
  to: Vec2;
  damage: number;
  healthBefore: number;
  healthAfter: number;
  healthLost: number;
  lethal: boolean;
  killsBefore: number;
  readyAtTick: number;
  cooldown: number;
}
export interface AssaultParticipant extends CombatIdentity {
  alive: boolean;
  health: number;
  builtAtTick: number | null;
  ready: boolean | null;
}
export interface AssaultTerminal {
  type: 'assault-terminal';
  tick: number;
  sequence: number;
  phase: 'combat' | 'nuke' | 'demolition';
  entity: CombatIdentity;
  reason: 'damage' | 'demolition';
  healthBefore: number;
  healthAfter: number;
}
export interface AssaultEndTick {
  type: 'assault-end-tick';
  tick: number;
  sequence: number;
  phase: 'end-tick';
  winner: number | null;
  participants: AssaultParticipant[];
}
export type CombatObservation =
  AssaultMotion | AssaultPosition | AssaultShot | AssaultTerminal | AssaultEndTick;
export type CombatObserver = (event: CombatObservation) => void;
export interface CombatObservationContext {
  observer: CombatObserver;
  sequence: number;
  phase?: 'combat' | 'nuke' | 'demolition';
}

export const observeTerminal = (
  working: Working,
  entity: CombatIdentity,
  healthBefore: number,
  healthAfter: number,
  reason: 'damage' | 'demolition',
): void => {
  emitCombatObservation(working, {
    type: 'assault-terminal',
    tick: working.tick,
    sequence: 0,
    phase: working.observation?.phase ?? 'combat',
    entity,
    reason,
    healthBefore,
    healthAfter,
  });
};

export const observeEndTick = (working: Working): void => {
  if (working.observation === undefined) return;
  const participants: AssaultParticipant[] = [];
  for (const unit of working.units) {
    if (unit.unitType !== UnitType.Assault) continue;
    participants.push({
      kind: 'unit',
      id: unit.id,
      owner: unit.owner,
      subtype: unit.unitType,
      alive: unit.alive,
      health: unit.health,
      builtAtTick: null,
      ready: null,
    });
  }
  for (const structure of working.structures) {
    if (!isArmedStructure(structure.kind)) continue;
    participants.push({
      kind: 'structure',
      id: structure.id,
      owner: structure.owner,
      subtype: structure.kind,
      alive: structure.alive,
      health: structure.health,
      builtAtTick: structure.builtAtTick,
      ready: working.tick >= structure.builtAtTick,
    });
  }
  emitCombatObservation(working, {
    type: 'assault-end-tick',
    tick: working.tick,
    sequence: 0,
    phase: 'end-tick',
    winner: working.winner,
    participants,
  });
};

/** DTO создаётся вызывающим только при включённой диагностике. */
export const emitCombatObservation = (working: Working, event: CombatObservation): void => {
  const context = working.observation;
  if (context === undefined) return;
  event.sequence = context.sequence++;
  context.observer(event);
};

export const observePostCrowd = (working: Working): void => {
  if (working.observation === undefined) return;
  for (const unit of working.units) {
    if (!unit.alive || unit.unitType !== UnitType.Assault) continue;
    emitCombatObservation(working, {
      type: 'assault-position',
      tick: working.tick,
      sequence: 0,
      phase: 'post-crowd',
      unit: { kind: 'unit', id: unit.id, owner: unit.owner, subtype: unit.unitType },
      position: { x: unit.x, y: unit.y },
    });
  }
};
