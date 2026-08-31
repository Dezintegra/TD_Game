import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { ingestFile, isLogName, openDatabase } from './ingest.js';
import type { LogRecord } from './records.js';

/**
 * Сборка базы из сжатого лога.
 *
 * Проверяется главное свойство: сжатие меняет хранение и не меняет
 * содержимое. Сжатый лог и его несжатый близнец обязаны давать в базе
 * одно и то же — иначе разбор матчей начал бы зависеть от того, в каком
 * виде лежал файл.
 */

const HEADER: LogRecord = {
  t: 'match',
  matchId: 'проверка',
  kind: 'arena',
  worldSeed: 7,
  aiSeeds: [1, 2],
  profiles: ['левый', 'правый'],
  gitSha: 'abcdef12',
  gitDirty: false,
  startedAt: '2026-08-31T10:00:00.000Z',
};

const command = (tick: number): LogRecord => ({
  t: 'command',
  tick,
  player: 0,
  kind: 1,
  arg0: tick,
  arg1: 0,
  accepted: true,
  rejectReason: null,
});

const FOOTER: LogRecord = {
  t: 'end',
  ticks: 90,
  winner: 0,
  endReason: 'base-destroyed',
  wallMs: 5,
};

const asJsonl = (records: readonly LogRecord[]): string =>
  `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

/** Столько же порций, сколько сбрасывает писатель, — по одному члену на каждую. */
const asMultiMemberGzip = (records: readonly LogRecord[], perChunk: number): Buffer => {
  const members: Buffer[] = [];

  for (let at = 0; at < records.length; at += perChunk) {
    members.push(gzipSync(Buffer.from(asJsonl(records.slice(at, at + perChunk)), 'utf8')));
  }

  return Buffer.concat(members);
};

/** Что легло в базу по этому матчу: только факты, по которым и сверяем. */
const commandsIn = (db: DatabaseSync, matchId: string): unknown[] =>
  db.prepare('select tick, arg0 from command where match_id = ? order by tick').all(matchId);

describe('сборка базы из сжатого лога', () => {
  let dir: string;
  let db: DatabaseSync;

  beforeEach(() => {
    // Свой каталог на каждый тест: соседняя сессия гоняет арену в том же
    // `.matchlog`, и общее имя файла увело бы тесты друг другу под ноги.
    dir = mkdtempSync(join(tmpdir(), 'arena-ingest-'));
    db = openDatabase(join(dir, 'db.sqlite'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('сжатый лог даёт в базе то же, что несжатый', () => {
    const records = [HEADER, command(10), command(20), command(30), FOOTER];

    const plain = join(dir, 'plain.jsonl');
    writeFileSync(plain, asJsonl(records));
    const fromPlain = ingestFile(db, plain);

    const wanted = commandsIn(db, 'проверка');

    // Тот же матч, но сжатый. Сборка идемпотентна: прежние строки матча
    // удаляются перед вставкой, поэтому сравнивать можно в одной базе.
    const packed = join(dir, 'packed.jsonl.gz');
    writeFileSync(packed, asMultiMemberGzip(records, 2));
    const fromPacked = ingestFile(db, packed);

    expect(fromPacked).toStrictEqual(fromPlain);
    expect(commandsIn(db, 'проверка')).toStrictEqual(wanted);
    expect(wanted).toHaveLength(3);
  });

  it('многочленный архив читается целиком', () => {
    // Писатель дописывает каждую порцию отдельным членом. Если бы чтение
    // останавливалось на первом члене, в базу попала бы только первая
    // порция — и заметили бы это не сразу, потому что заголовок в ней есть
    // и матч выглядел бы записанным.
    const records = [HEADER, command(10), command(20), command(30), command(40), FOOTER];

    const path = join(dir, 'many.jsonl.gz');
    writeFileSync(path, asMultiMemberGzip(records, 1));

    expect(ingestFile(db, path).broken).toBe(0);
    expect(commandsIn(db, 'проверка')).toHaveLength(4);
  });

  it('имя лога узнаётся по обоим расширениям', () => {
    expect(isLogName('матч.jsonl')).toBe(true);
    expect(isLogName('матч.jsonl.gz')).toBe(true);
    expect(isLogName('arena.sqlite')).toBe(false);
  });
});
