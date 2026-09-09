import { UnitType, isArmedStructure } from '@td/shared';
import type { CombatObservation, CombatObserver, WorldState } from '@td/sim';
import type { LogWriter } from './log.js';
import type { AssaultTraceRecord } from './records.js';

export const ASSAULT_TRACE_VERSION = 1;
export type EndTick = Extract<CombatObservation, { type: 'assault-end-tick' }>;
export type Participant = EndTick['participants'][number];

/** Начальная опись имеет ту же форму, но тик исходного мира. */
export const initialAssaultState = (world: WorldState): EndTick => ({
  type: 'assault-end-tick',
  phase: 'end-tick',
  sequence: 0,
  tick: world.tick,
  winner: world.winner,
  participants: [
    ...world.units
      .filter((u) => u.unitType === UnitType.Assault)
      .map((u) => ({
        kind: 'unit' as const,
        id: u.id,
        owner: u.owner,
        subtype: u.unitType,
        alive: true,
        health: u.health,
        builtAtTick: null,
        ready: null,
      })),
    ...world.structures
      .filter((s) => isArmedStructure(s.kind))
      .map((s) => ({
        kind: 'structure' as const,
        id: s.id,
        owner: s.owner,
        subtype: s.kind,
        alive: true,
        health: s.health,
        builtAtTick: s.builtAtTick,
        ready: world.tick >= s.builtAtTick,
      })),
  ],
});

export const createAssaultTrace = (log: LogWriter, initial: EndTick): CombatObserver => {
  let towers = new Map<number, Participant>();
  const observer: CombatObserver = (event) => {
    log.write({ ...event, t: event.type } as AssaultTraceRecord);
    if (event.type !== 'assault-end-tick') return;
    const next = new Map<number, Participant>();
    let sequence = 0;
    const write = (p: Participant, change: 'appeared' | 'ready' | 'removed') =>
      log.write({
        t: 'assault-tower',
        tick: event.tick,
        sequence: sequence++,
        id: p.id,
        owner: p.owner,
        event: change,
      });
    for (const p of event.participants) {
      if (p.kind !== 'structure') continue;
      const previous = towers.get(p.id);
      if (previous === undefined) write(p, 'appeared');
      if (p.ready === true && previous?.ready !== true) write(p, 'ready');
      if (!p.alive) write(p, 'removed');
      else next.set(p.id, p);
    }
    for (const p of towers.values()) {
      if (
        !event.participants.some(
          (candidate) => candidate.kind === 'structure' && candidate.id === p.id,
        )
      )
        write(p, 'removed');
    }
    towers = next;
  };
  observer(initial);
  return observer;
};
