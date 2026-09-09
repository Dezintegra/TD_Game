import { describe, expect, it } from 'vitest';
import type { CombatObservation } from '@td/sim';
import { collectAssaultEpisodes } from './assault-episodes.js';
import type { EndTick } from './assault-trace.js';

const unit = { kind: 'unit' as const, id: 1, owner: 0, subtype: 0 };
const tower = { kind: 'structure' as const, id: 2, owner: 1, subtype: 2 };
const end = (tick: number, dead = false, health = 100): EndTick => ({
  type: 'assault-end-tick',
  phase: 'end-tick',
  tick,
  sequence: 10,
  winner: null,
  participants: [
    { ...unit, alive: !dead, health: dead ? -1 : 100, builtAtTick: null, ready: null },
    { ...tower, alive: true, health, builtAtTick: 0, ready: true },
  ],
});
const shot = (tick: number): CombatObservation => ({
  type: 'assault-shot',
  phase: 'combat',
  sequence: 1,
  tick,
  shooter: unit,
  target: tower,
  from: { x: 0, y: 0 },
  to: { x: 1, y: 0 },
  damage: 10,
  healthBefore: 100,
  healthAfter: 90,
  healthLost: 10,
  lethal: false,
  killsBefore: 0,
  readyAtTick: tick + 2,
  cooldown: 2,
});

describe('эпизоды из фактов', () => {
  it('два стрелка дают два контакта и одну осаду', () => {
    const second = { ...unit, id: 3 };
    const hit = shot(1);
    if (hit.type !== 'assault-shot') throw new Error('fixture');
    const states = [end(0), end(1)];
    for (const state of states)
      state.participants.push({
        ...second,
        alive: true,
        health: 100,
        builtAtTick: null,
        ready: null,
      });
    const result = collectAssaultEpisodes(
      [states[0]!, hit, { ...hit, sequence: 2, shooter: second }, states[1]!],
      1,
      null,
    );
    expect(result.contacts).toHaveLength(2);
    expect(result.sieges).toHaveLength(1);
    expect(result.sieges[0]?.hits).toBe(2);
  });

  it('первый терминальный факт задаёт исход при гибели обоих за тик', () => {
    const final = end(2, true, 0);
    final.participants[1] = { ...final.participants[1]!, alive: false };
    const events: CombatObservation[] = [
      end(0),
      shot(1),
      end(1),
      {
        type: 'assault-terminal',
        phase: 'nuke',
        sequence: 0,
        tick: 2,
        entity: unit,
        reason: 'damage',
        healthBefore: 100,
        healthAfter: -1,
      },
      {
        type: 'assault-terminal',
        phase: 'nuke',
        sequence: 1,
        tick: 2,
        entity: tower,
        reason: 'damage',
        healthBefore: 90,
        healthAfter: 0,
      },
      final,
    ];
    expect(collectAssaultEpisodes(events, 2, null).contacts[0]?.outcome).toBe('attacker-died');
  });
  it('гибель на последнем тике имеет null времени сноса и актуальный HP', () => {
    const events: CombatObservation[] = [
      end(0),
      shot(1),
      end(1),
      {
        type: 'assault-terminal',
        phase: 'nuke',
        sequence: 2,
        tick: 2,
        entity: unit,
        reason: 'damage',
        healthBefore: 100,
        healthAfter: -1,
      },
      end(2, true, 40),
    ];
    const result = collectAssaultEpisodes(events, 2, null);
    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0]).toMatchObject({
      outcome: 'attacker-died',
      demolitionTicks: null,
      endTick: 2,
      towerHpAtEndOfTick: 40,
    });
    expect(result.sieges).toHaveLength(1);
    expect(() => collectAssaultEpisodes(events.slice(0, -1), 2, null)).toThrow();
    expect(() =>
      collectAssaultEpisodes(
        events.filter((e) => e.type !== 'assault-terminal'),
        2,
        null,
      ),
    ).toThrow('missing terminal');
  });
  it('разрушение считает разность тиков без единицы и одну осаду', () => {
    const final = end(2);
    final.participants[1] = { ...final.participants[1]!, alive: false, health: -10 };
    const events: CombatObservation[] = [
      end(0),
      shot(1),
      end(1),
      {
        type: 'assault-terminal',
        phase: 'combat',
        sequence: 0,
        tick: 2,
        entity: tower,
        reason: 'damage',
        healthBefore: 1,
        healthAfter: -10,
      },
      shot(2),
      final,
    ];
    const result = collectAssaultEpisodes(events, 2, null);
    expect(result.contacts).toHaveLength(1);
    expect(result.sieges).toHaveLength(1);
    expect(result.contacts[0]).toMatchObject({
      outcome: 'tower-destroyed',
      hits: 2,
      demolitionTicks: 1,
      towerHpAtEndOfTick: 0,
    });
  });
  it('перерыв и возобновление дают разные контакты при одной башне', () => {
    const events: CombatObservation[] = [end(0), shot(1), end(1), end(2), end(3), shot(4), end(4)];
    const result = collectAssaultEpisodes(events, 4, null);
    expect(result.contacts.map((e) => e.outcome)).toEqual(['contact-lost', 'cap']);
    expect(result.sieges).toHaveLength(1);
    expect(result.sieges[0]?.demolitionTicks).toBeNull();
  });
  it('собственный разбор не является разрушением от огня', () => {
    const final = end(2);
    final.participants[1] = { ...final.participants[1]!, alive: false };
    const events: CombatObservation[] = [
      end(0),
      shot(1),
      end(1),
      {
        type: 'assault-terminal',
        phase: 'demolition',
        sequence: 0,
        tick: 2,
        entity: tower,
        reason: 'demolition',
        healthBefore: 100,
        healthAfter: 100,
      },
      final,
    ];
    expect(collectAssaultEpisodes(events, 2, null).contacts[0]).toMatchObject({
      outcome: 'demolition',
      demolitionTicks: null,
    });
  });
});
