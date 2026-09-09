import type { CombatObservation } from '@td/sim';
import type { EndTick, Participant } from './assault-trace.js';

export type EpisodeOutcome =
  | 'tower-destroyed'
  | 'attacker-died'
  | 'demolition'
  | 'unknown-removal'
  | 'target-changed'
  | 'contact-lost'
  | 'cap'
  | 'match-end';
export interface AssaultEpisode {
  towerId: number;
  unitId: number | null;
  startTick: number;
  endTick: number;
  firstStopTick: number | null;
  firstTowerHitTick: number | null;
  hits: number;
  otherShots: number;
  outcome: EpisodeOutcome;
  demolitionTicks: number | null;
  towerHpAtEndOfTick: number;
  cooldown: number;
}
interface Active {
  towerId: number;
  unitId: number | null;
  startTick: number;
  firstStopTick: number | null;
  lastContact: number;
  cooldown: number;
  assigned: boolean;
  attackers: Set<number>;
}
const keyOf = (p: { kind: string; id: number }) => `${p.kind}:${p.id}`;

/** Потерянный terminal/end-tick не превращается в достоверную гибель или cap. */
export const validateAssaultTrace = (
  events: readonly CombatObservation[],
  lastTick: number,
): Map<number, EndTick> => {
  const ends = new Map<number, EndTick>();
  const terminals = new Set<string>();
  let tick = -1;
  let sequence = -1;
  for (const e of events) {
    if (e.tick < tick || (e.tick === tick && e.sequence <= sequence))
      throw new Error('unordered trace');
    if (e.tick !== tick) sequence = -1;
    tick = e.tick;
    sequence = e.sequence;
    if (e.type === 'assault-terminal') terminals.add(`${e.tick}:${keyOf(e.entity)}`);
    if (e.type === 'assault-end-tick') {
      if (ends.has(e.tick)) throw new Error('duplicate end-tick');
      const identities = new Set<string>();
      for (const p of e.participants) {
        if (identities.has(keyOf(p))) throw new Error('duplicate participant');
        identities.add(keyOf(p));
        if (!p.alive && !terminals.has(`${e.tick}:${keyOf(p)}`))
          throw new Error('missing terminal');
      }
      ends.set(e.tick, e);
    }
  }
  if (ends.size !== lastTick + 1) throw new Error('incomplete end-tick trace');
  for (let t = 0; t <= lastTick; t++) if (!ends.has(t)) throw new Error('missing end-tick');
  return ends;
};

export const collectAssaultEpisodes = (
  events: readonly CombatObservation[],
  lastTick: number,
  winner: number | null,
) => {
  const ends = validateAssaultTrace(events, lastTick);
  const contacts = new Map<string, Active>();
  const sieges = new Map<number, Active>();
  const episodes: AssaultEpisode[] = [];
  const towers = new Set<number>();
  for (const end of ends.values())
    for (const p of end.participants) if (p.kind === 'structure') towers.add(p.id);
  const shots = events.filter((e) => e.type === 'assault-shot');
  const finish = (active: Active, endTick: number, outcome: EpisodeOutcome) => {
    const state = ends
      .get(endTick)
      ?.participants.find((p) => p.kind === 'structure' && p.id === active.towerId);
    if (state === undefined) throw new Error('missing tower end-tick health');
    const own = shots.filter(
      (e) =>
        e.tick >= active.startTick &&
        e.tick <= endTick &&
        (active.unitId === null || e.shooter.id === active.unitId),
    );
    const hits = own.filter((e) => e.target.kind === 'structure' && e.target.id === active.towerId);
    const first = hits[0]?.tick ?? null;
    episodes.push({
      towerId: active.towerId,
      unitId: active.unitId,
      startTick: active.startTick,
      endTick,
      firstStopTick: active.firstStopTick,
      firstTowerHitTick: first,
      hits: hits.length,
      otherShots: own.length - hits.length,
      outcome,
      cooldown: active.cooldown,
      demolitionTicks: outcome === 'tower-destroyed' && first !== null ? endTick - first : null,
      towerHpAtEndOfTick: Math.max(0, state.health),
    });
  };
  const begin = (
    towerId: number,
    unitId: number,
    tick: number,
    cooldown: number,
    stopped: boolean,
    assigned: boolean,
  ) => {
    const key = `${unitId}:${towerId}`;
    let active = contacts.get(key);
    if (active === undefined) {
      active = {
        towerId,
        unitId,
        startTick: tick,
        firstStopTick: stopped ? tick : null,
        lastContact: tick,
        cooldown,
        assigned,
        attackers: new Set([unitId]),
      };
      contacts.set(key, active);
    }
    active.lastContact = tick;
    active.cooldown = cooldown;
    if (stopped && active.firstStopTick === null) active.firstStopTick = tick;
    return active;
  };
  const terminalAt = new Map<string, Extract<CombatObservation, { type: 'assault-terminal' }>>();
  for (const e of events) {
    if (e.type === 'assault-motion') {
      for (const [key, a] of contacts)
        if (a.unitId === e.unit.id && a.assigned && e.targetStructure !== a.towerId) {
          finish(a, e.tick, 'target-changed');
          contacts.delete(key);
        }
      if (
        e.witness?.kind === 'structure' &&
        towers.has(e.witness.id) &&
        (e.reason === 'assigned-target' || e.reason === 'armed-structure')
      )
        begin(e.witness.id, e.unit.id, e.tick, e.cooldown, true, e.reason === 'assigned-target');
    }
    if (e.type === 'assault-shot' && e.target.kind === 'structure' && towers.has(e.target.id)) {
      if (
        terminalAt.has(`${e.tick}:structure:${e.target.id}`) &&
        episodes.some(
          (a) => a.towerId === e.target.id && a.endTick === e.tick && a.unitId === e.shooter.id,
        )
      )
        continue;
      const a = begin(e.target.id, e.shooter.id, e.tick, e.cooldown, false, false);
      let group = sieges.get(e.target.id);
      if (group === undefined) {
        group = { ...a, unitId: null, attackers: new Set() };
        sieges.set(e.target.id, group);
      }
      group.attackers.add(e.shooter.id);
      const terminal = terminalAt.get(`${e.tick}:structure:${e.target.id}`);
      if (terminal !== undefined) {
        for (const [key, contact] of contacts)
          if (contact.towerId === e.target.id) {
            finish(contact, e.tick, 'tower-destroyed');
            contacts.delete(key);
          }
        finish(group, e.tick, 'tower-destroyed');
        sieges.delete(e.target.id);
      }
    }
    if (e.type === 'assault-terminal') {
      terminalAt.set(`${e.tick}:${keyOf(e.entity)}`, e);
      for (const [key, a] of contacts) {
        const tower = e.entity.kind === 'structure' && e.entity.id === a.towerId;
        const unit = e.entity.kind === 'unit' && e.entity.id === a.unitId;
        if (tower || unit) {
          finish(
            a,
            e.tick,
            unit ? 'attacker-died' : e.reason === 'damage' ? 'tower-destroyed' : 'demolition',
          );
          contacts.delete(key);
        }
      }
      for (const [id, a] of sieges) {
        if (e.entity.kind === 'unit') a.attackers.delete(e.entity.id);
        const tower = e.entity.kind === 'structure' && e.entity.id === id;
        if (tower || a.attackers.size === 0) {
          finish(
            a,
            e.tick,
            tower ? (e.reason === 'damage' ? 'tower-destroyed' : 'demolition') : 'attacker-died',
          );
          sieges.delete(id);
        }
      }
    }
    if (e.type === 'assault-end-tick') {
      const alive = new Map<string, Participant>(e.participants.map((p) => [keyOf(p), p]));
      for (const [key, a] of contacts) {
        if (!alive.has(`unit:${a.unitId}`) || !alive.has(`structure:${a.towerId}`)) {
          finish(a, e.tick, 'unknown-removal');
          contacts.delete(key);
        } else if (e.tick - a.lastContact >= a.cooldown) {
          finish(a, e.tick, 'contact-lost');
          contacts.delete(key);
        }
      }
    }
  }
  for (const a of [...contacts.values(), ...sieges.values()])
    finish(a, lastTick, winner === null ? 'cap' : 'match-end');
  return {
    contacts: episodes.filter((e) => e.unitId !== null),
    sieges: episodes.filter((e) => e.unitId === null),
  };
};
