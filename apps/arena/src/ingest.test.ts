import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { asPlayerId } from '@td/shared';
import { NukeNote } from '@td/ai';
import { ingestFile, isLogName, openDatabase } from './ingest.js';
import { createLogWriter, logPathFor } from './log.js';
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

/**
 * Решение противника с судьбой ядерного удара.
 *
 * Собирается вручную, а не прогоном матча: проверяется здесь дорога
 * от записи до столбца, а не поведение противника. Матч дал бы те же
 * столбцы за четверть часа и с разбросом.
 */
const decision = (
  tick: number,
  nuke: { readonly nukeNote?: NukeNote; readonly nukeNet?: number; readonly nukeCost?: number },
): LogRecord => ({
  t: 'decision',
  tick,
  player: asPlayerId(0),
  phaseIndex: 1,
  waitStreak: 0,
  impatient: false,
  escorting: false,
  liveUnits: 3,
  nearbyUnits: 1,
  spendOrder: [],
  attempts: [],
  frontiers: [],
  generalCell: 42,
  generalFromHome: 7,
  approachShortest: 30,
  energy: 100,
  struck: false,
  pushed: false,
  commandCount: 0,
  ...nuke,
});

/** Столбцы судьбы удара, как они легли в базу. */
const nukesIn = (db: DatabaseSync, matchId: string): unknown[] =>
  db
    .prepare(
      'select tick, nuke_note, nuke_net, nuke_cost from decision where match_id = ? order by tick',
    )
    .all(matchId);

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

  it('прерванный прогон оставляет годные записи', () => {
    // Ради этого свойства писатель и дописывает в конец, а не переписывает
    // файл целиком. Проверка нужна отдельно от чтения: годный сжатый лог
    // читается и обычным gunzipSync — а вот недописанный он роняет
    // целиком, вместе с порциями, которые легли на диск задолго до обрыва.
    const whole = [HEADER, command(10), command(20)];
    const lost = [command(30), command(40), FOOTER];

    const path = join(dir, 'cut.jsonl.gz');
    const packed = Buffer.concat([
      asMultiMemberGzip(whole, whole.length),
      asMultiMemberGzip(lost, lost.length),
    ]);
    // Обрыв посреди последней порции: диск успел принять её начало.
    writeFileSync(path, packed.subarray(0, packed.length - 8));

    const result = ingestFile(db, path);

    // Матч записан, две команды до обрыва на месте. Что уцелело
    // от оборванной порции — дело случая, поэтому проверяется нижняя
    // граница, а не точное число: важно, что уцелевшее не потеряно.
    expect(result.matches).toBe(1);
    expect(commandsIn(db, 'проверка').length).toBeGreaterThanOrEqual(2);
  });

  it('написанное писателем читается сборкой', () => {
    // Круг замыкается здесь: до этого теста писатель и читатель
    // проверялись порознь, и разъехаться они могли бы молча — сборка
    // просто не нашла бы файла и промолчала о пустом отчёте.
    //
    // Записей нарочно больше, чем помещается в одну порцию: писатель
    // сбрасывает их по 512, и на меньшем числе многочленность архива
    // не проверялась бы вовсе.
    const path = logPathFor(dir, 'написанное');
    const writer = createLogWriter(path);

    writer.write(HEADER);
    for (let tick = 1; tick <= 600; tick += 1) writer.write(command(tick));
    writer.write(FOOTER);
    writer.close();

    const result = ingestFile(db, path);

    expect(result.matches).toBe(1);
    expect(result.broken).toBe(0);
    expect(commandsIn(db, 'проверка')).toHaveLength(600);
  });

  it('судьба удара доезжает до базы: помеха, ценность цели и цена пуска', () => {
    // Три случая в одном логе, и все три разные по смыслу:
    //  — обход не выполнялся: обеих величин нет, и в базе они `null`,
    //    а не ноль. Ноль читался бы как «искали и нашли пустоту»;
    //  — цель дешевле пуска: величины есть, и по ним видно, во сколько раз
    //    цель не дотянула;
    //  — лучшая точка хуже пустой карты: ценность ОТРИЦАТЕЛЬНАЯ. Это
    //    значит, что своего рядом больше чужого, и обрезать такое нулём
    //    при записи значило бы стереть диагноз.
    const records = [
      HEADER,
      decision(10, { nukeNote: NukeNote.NotSearched }),
      decision(20, { nukeNote: NukeNote.TargetTooCheap, nukeNet: 120.4, nukeCost: 400 }),
      decision(30, { nukeNote: NukeNote.TargetTooCheap, nukeNet: -37.5, nukeCost: 400 }),
      FOOTER,
    ];

    const path = join(dir, 'nuke.jsonl');
    writeFileSync(path, asJsonl(records));

    expect(ingestFile(db, path).matches).toBe(1);
    // `toEqual`, а не `toStrictEqual`: строки из node:sqlite приходят
    // объектами без прототипа, и строгое сравнение спорит о прототипе,
    // а не о значениях.
    expect(nukesIn(db, 'проверка')).toEqual([
      { tick: 10, nuke_note: 'not-searched', nuke_net: null, nuke_cost: null },
      { tick: 20, nuke_note: 'target-too-cheap', nuke_net: 120, nuke_cost: 400 },
      { tick: 30, nuke_note: 'target-too-cheap', nuke_net: -37, nuke_cost: 400 },
    ]);
  });

  it('удар состоялся — помехи в базе нет', () => {
    const records = [HEADER, { ...decision(10, { nukeNet: 900, nukeCost: 400 }), struck: true }];

    const path = join(dir, 'struck.jsonl');
    writeFileSync(path, asJsonl(records as readonly LogRecord[]));
    ingestFile(db, path);

    // `toEqual`, а не `toStrictEqual`: строки из node:sqlite приходят
    // объектами без прототипа, и строгое сравнение спорит о прототипе,
    // а не о значениях.
    expect(nukesIn(db, 'проверка')).toEqual([
      { tick: 10, nuke_note: null, nuke_net: 900, nuke_cost: 400 },
    ]);
  });

  it('имя лога узнаётся по обоим расширениям', () => {
    expect(isLogName('матч.jsonl')).toBe(true);
    expect(isLogName('матч.jsonl.gz')).toBe(true);
    expect(isLogName('arena.sqlite')).toBe(false);
  });
});
