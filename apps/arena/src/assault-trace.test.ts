import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ruleTuning,
  AttackStance,
  MAP_CELL_COUNT,
  StructureKind,
  UnitType,
  asEntityId,
  asPlayerId,
  asTickNumber,
} from '@td/shared';
import { createWorld, step, cellCentre, cellIndex } from '@td/sim';
import type { CombatObservation, WorldState } from '@td/sim';
import { createAssaultTrace, initialAssaultState } from './assault-trace.js';
import { collectAssaultEpisodes } from './assault-episodes.js';
import type { EndTick } from './assault-trace.js';
import { createLogWriter } from './log.js';
import { ingestFile, openDatabase } from './ingest.js';
import type { MatchHeader } from './records.js';

const root = fileURLToPath(new URL('../../../.matchlog/assault-tests', import.meta.url));
mkdirSync(root, { recursive: true });
const header: MatchHeader = {
  t: 'match',
  matchId: 'trace',
  kind: 'arena',
  worldSeed: 1,
  aiSeeds: [1, 2],
  profiles: ['a', 'b'],
  gitSha: 'sha',
  gitDirty: false,
  startedAt: '',
  tuning: { ...ruleTuning() },
  effectiveAssaultRange: 4000,
  traceVersion: 1,
  traceEnabled: true,
  tickRate: 30,
  tickCap: 1,
};
const initial: EndTick = {
  type: 'assault-end-tick',
  tick: 0,
  sequence: 0,
  phase: 'end-tick',
  winner: null,
  participants: [
    {
      kind: 'structure',
      id: 10,
      owner: 1,
      subtype: 2,
      alive: true,
      health: 200,
      builtAtTick: 1,
      ready: false,
    },
  ],
};

describe('доставка трассы', () => {
  it.each(['tower', 'nuke', 'late-hp'])(
    'два настоящих step проходят writer и SQLite: %s',
    (cause) => {
      const original = createWorld(42);
      let world: WorldState = {
        ...original,
        map: { ...original.map, cells: new Uint8Array(MAP_CELL_COUNT) },
        nav: [],
        generals: [],
        players: original.players.map((p) => ({
          ...p,
          stance: AttackStance.Engage,
          targetStructure: p.id === 0 ? asEntityId(10) : p.targetStructure,
        })),
        structures: [
          ...original.structures,
          {
            id: asEntityId(10),
            owner: asPlayerId(1),
            kind: StructureKind.TowerBasic,
            cell: cellIndex(20, 20),
            health: 200,
            kills: 0,
            facing: 1,
            builtAtTick: asTickNumber(0),
            demolishAtTick: asTickNumber(0),
            readyAtTick: asTickNumber(cause === 'tower' ? 2 : 100),
          },
        ],
        units: [
          {
            id: asEntityId(11),
            owner: asPlayerId(0),
            unitType: UnitType.Assault,
            position: cellCentre(cellIndex(17, 20)),
            health: cause === 'tower' ? 1 : 100,
            kills: 0,
            facing: 1,
            readyAtTick: asTickNumber(2),
          },
        ],
        nukes:
          cause === 'tower'
            ? []
            : [
                {
                  id: asEntityId(12),
                  owner: asPlayerId(1),
                  cell: cellIndex(20, 20),
                  radius: cause === 'nuke' ? 5000 : 1000,
                  damage: cause === 'nuke' ? 150 : 50,
                  detonateAtTick: asTickNumber(2),
                },
              ],
        nextEntityId: 20,
      };
      const dir = mkdtempSync(join(root, 'step-'));
      const path = join(dir, 'step.jsonl.gz');
      const writer = createLogWriter(path);
      writer.write({ ...header, tickCap: 2 });
      const observer = createAssaultTrace(writer, initialAssaultState(world));
      world = step(world, [], observer);
      world = step(world, [], observer);
      writer.write({
        t: 'end',
        ticks: world.tick,
        winner: world.winner,
        endReason: 'timeout',
        wallMs: 0,
      });
      writer.close();
      const db = openDatabase(join(dir, 'step.sqlite'));
      try {
        ingestFile(db, path);
        const events = db
          .prepare(
            "select payload from assault_event where type!='assault-tower' order by tick,sequence",
          )
          .all()
          .map((r) => JSON.parse(String(r.payload)) as CombatObservation);
        const result = collectAssaultEpisodes(events, 2, null);
        expect(result.contacts[0]).toMatchObject({
          endTick: 2,
          outcome: cause === 'late-hp' ? 'cap' : 'attacker-died',
          demolitionTicks: null,
          towerHpAtEndOfTick: cause === 'tower' ? 220 : cause === 'nuke' ? 40 : 140,
        });
        expect(() =>
          collectAssaultEpisodes(
            events.filter((e) => !(e.type === 'assault-end-tick' && e.tick === 2)),
            2,
            null,
          ),
        ).toThrow();
        if (cause !== 'late-hp')
          expect(() =>
            collectAssaultEpisodes(
              events.filter((e) => e.type !== 'assault-terminal'),
              2,
              null,
            ),
          ).toThrow('missing terminal');
      } finally {
        db.close();
      }
    },
  );
  it('gzip writer и повторный ingest сохраняют состояние и ID', () => {
    const dir = mkdtempSync(join(root, 'trace-'));
    const path = join(dir, 'trace.jsonl.gz');
    const writer = createLogWriter(path);
    writer.write(header);
    const observer = createAssaultTrace(writer, initial);
    observer({
      ...initial,
      tick: 1,
      participants: [
        { ...initial.participants[0]!, health: -10, alive: false, ready: true },
        { ...initial.participants[0]!, id: 11 },
      ],
    });
    writer.write({ t: 'end', ticks: 1, winner: null, endReason: 'timeout', wallMs: 1 });
    writer.close();
    const db = openDatabase(join(dir, 'trace.sqlite'));
    try {
      const first = ingestFile(db, path);
      expect(ingestFile(db, path)).toEqual(first);
      expect(db.prepare('select count(*) as n from assault_metadata').get()).toMatchObject({
        n: 1,
      });
      const payloads = db
        .prepare("select payload from assault_event where type = 'assault-end-tick' order by tick")
        .all()
        .map((r) => JSON.parse(String(r.payload)) as EndTick);
      expect(payloads[1]?.participants).toEqual([
        { ...initial.participants[0]!, health: -10, alive: false, ready: true },
        { ...initial.participants[0]!, id: 11 },
      ]);
      expect(
        db.prepare("select count(*) as n from assault_event where type = 'assault-tower'").get(),
      ).toMatchObject({ n: 4 });
    } finally {
      db.close();
    }
  });

  it('ошибка writer не скрывается наблюдателем', () => {
    expect(() =>
      createAssaultTrace(
        {
          write: () => {
            throw new Error('disk');
          },
          close: () => undefined,
        },
        initial,
      ),
    ).toThrow('disk');
  });

  it('миграция добавляет диагностику в существующую базу без выдуманной metadata', () => {
    const dir = mkdtempSync(join(root, 'migration-'));
    const path = join(dir, 'old.sqlite');
    let db = openDatabase(path);
    db.exec(
      'drop table assault_metadata; drop table assault_event; drop table assault_sample; drop table arena_migration',
    );
    db.close();
    db = openDatabase(path);
    try {
      expect(db.prepare('select count(*) as n from assault_metadata').get()).toMatchObject({
        n: 0,
      });
      expect(db.prepare('select name from arena_migration').get()).toMatchObject({
        name: 'assault-trace-v1',
      });
    } finally {
      db.close();
    }
  });
});
