import { UnitType } from '@td/shared';
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

export type CombatObservation = AssaultMotion | AssaultPosition;
export type CombatObserver = (event: CombatObservation) => void;
export interface CombatObservationContext {
  observer: CombatObserver;
  sequence: number;
}

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
