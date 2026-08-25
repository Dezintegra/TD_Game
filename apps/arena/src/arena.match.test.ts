import { afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TICKS_PER_SECOND } from '@td/shared';
import { DEFAULT_PROFILE_ID } from '@td/ai';
import { createLogWriter } from './log.js';
import { runMatch } from './match.js';
import { ingestFile, openDatabase } from './ingest.js';
import { reportBatch, reportMatch } from './report.js';
import type { LogRecord } from './records.js';

/**
 * Арена целиком: прогон, лог, сборка базы, сводка.
 *
 * Матч прогоняется ОДИН на весь файл, а не по разу на тест. Причина
 * прозаическая: минута игры считается несколько секунд, и дюжина тестов
 * со своим матчем каждый превращала прогон `pnpm verify` в минуту
 * ожидания на ровном месте. Матч детерминирован, тесты его не меняют,
 * делить один результат безопасно.
 *
 * Проверяются не игровые исходы, а то, что инструмент не теряет
 * и не задваивает сведения: на длинном матче те же ошибки видны ровно
 * так же, только ждать дольше.
 */

const SECONDS = 60;
const SEED = 777;
const MATCH_ID = `test-${String(SEED)}`;

const dir = mkdtempSync(join(tmpdir(), 'arena-test-'));
const logPath = join(dir, 'match.jsonl');

const log = createLogWriter(logPath);
runMatch({
  matchId: MATCH_ID,
  worldSeed: SEED,
  aiSeeds: [SEED ^ 0x11, SEED ^ 0x22],
  profiles: [DEFAULT_PROFILE_ID, DEFAULT_PROFILE_ID],
  log,
  tickCap: SECONDS * TICKS_PER_SECOND,
});

const linesOf = (path: string): LogRecord[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogRecord);

const records = linesOf(logPath);

/** База, собранная из общего лога. Тоже одна на файл. */
const db = openDatabase(join(dir, 'arena.sqlite'));
ingestFile(db, logPath);

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('прогон матча', () => {
  it('матч завершается и не висит вечно', () => {
    const footer = records.find((record) => record.t === 'end');

    expect(footer?.ticks).toBe(SECONDS * TICKS_PER_SECOND);
    // Минуты на разгром не хватает никому — это ничья по времени,
    // полноценный исход, а не сбой прогона.
    expect(footer?.endReason).toBe('timeout');
  });

  it('лог начинается заголовком и кончается итогом', () => {
    expect(records[0]?.t).toBe('match');
    expect(records[records.length - 1]?.t).toBe('end');
  });

  it('снимки снимаются раз в игровую секунду по каждой стороне', () => {
    expect(records.filter((record) => record.t === 'sample').length).toBe(SECONDS * 2);
  });

  it('записаны решения обеих сторон', () => {
    const players = new Set(
      records.filter((record) => record.t === 'decision').map((record) => record.player),
    );

    expect([...players].sort()).toEqual([0, 1]);
  });

  it('у каждой команды есть исход', () => {
    const commands = records.filter((record) => record.t === 'command');

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      // Принята — причины нет; отклонена — причина есть. Третьего
      // не дано: команда без исхода и была бы тем самым враньём,
      // ради устранения которого всё затевалось.
      expect(command.accepted ? command.rejectReason === null : command.rejectReason !== null).toBe(
        true,
      );
    }
  });

  it('матч воспроизводится: тот же seed даёт тот же лог', () => {
    const again = join(dir, 'again.jsonl');
    const writer = createLogWriter(again);

    runMatch({
      matchId: MATCH_ID,
      worldSeed: SEED,
      aiSeeds: [SEED ^ 0x11, SEED ^ 0x22],
      profiles: [DEFAULT_PROFILE_ID, DEFAULT_PROFILE_ID],
      log: writer,
      tickCap: SECONDS * TICKS_PER_SECOND,
    });

    // Заголовок и итог содержат время съёмки и длительность счёта —
    // они от прогона к прогону разные и по делу не значат ничего.
    const meaningful = (all: readonly LogRecord[]): string =>
      JSON.stringify(all.filter((record) => record.t !== 'match' && record.t !== 'end'));

    expect(meaningful(linesOf(again))).toBe(meaningful(records));
  });
});

describe('сборка базы', () => {
  it('идемпотентна: повторная сборка не задваивает строки', () => {
    const decisions = (): number =>
      (db.prepare('select count(*) as n from decision').get() as { n: number }).n;

    const before = decisions();
    ingestFile(db, logPath);

    expect(decisions()).toBe(before);
    expect((db.prepare('select count(*) as n from match').get() as { n: number }).n).toBe(1);
  });

  it('оборванная последняя строка не рушит сборку', () => {
    // Прерванный прогон оставляет ровно такой файл: годные строки
    // и обрубок в конце. Портится копия, а не общий лог.
    const truncated = join(dir, 'truncated.jsonl');
    copyFileSync(logPath, truncated);
    appendFileSync(truncated, '{"t":"sample","tick":1,"pla');

    const result = ingestFile(db, truncated);

    expect(result.broken).toBe(1);
    expect(result.matches).toBe(1);
    expect(result.rows).toBeGreaterThan(0);
  });

  it('в базу попадает версия кода', () => {
    const row = db.prepare('select git_sha, git_dirty from match').get() as {
      git_sha: string;
      git_dirty: number;
    };

    // Без версии сравнение матчей, сыгранных разными сборками,
    // превращается в гадание.
    expect(typeof row.git_sha).toBe('string');
    expect([0, 1]).toContain(row.git_dirty);
  });

  it('оценки всех рубежей доезжают до базы, а не только выбранного', () => {
    const row = db
      .prepare(
        `select count(*) as total, sum(chosen) as chosen
           from frontier where match_id = ?`,
      )
      .get(MATCH_ID) as { total: number; chosen: number };

    expect(row.total).toBeGreaterThan(row.chosen);
    expect(row.chosen).toBeGreaterThan(0);
  });

  it('клетки башен доезжают до базы', () => {
    // Число башен в снимке отвечает «сколько», клетки — «где».
    // Без вторых нельзя сказать, разбросаны ли башни по карте
    // или собраны в кучу, а вся правка ровно об этом.
    const row = db
      .prepare(
        `select count(*) as rows, count(distinct tick) as moments
           from tower where match_id = ?`,
      )
      .get(MATCH_ID) as { rows: number; moments: number };

    expect(row.rows).toBeGreaterThan(0);
    // Снимаются реже состояния — раз в десять секунд, — поэтому моментов
    // заведомо меньше, чем секунд матча.
    expect(row.moments).toBeLessThan(SECONDS);
  });

  it('места стен доезжают до базы вместе с геометрией подхода', () => {
    // Коридор подхода через минуту уже другой, а мира в базе нет:
    // не снятая при постройке ширина потеряна навсегда.
    const row = db
      .prepare(
        `select count(*) as walls, sum(on_path) as on_path, max(narrowest) as narrowest
           from wall_site where match_id = ?`,
      )
      .get(MATCH_ID) as { walls: number; on_path: number; narrowest: number };

    expect(row.walls).toBeGreaterThan(0);
    expect(row.narrowest).toBeGreaterThan(0);
  });

  it('в базе есть то, чего не произошло', () => {
    // Мир показывает, что случилось; только эта таблица покажет, чего
    // противник хотел и что ему помешало.
    const notes = db
      .prepare('select distinct note from attempt where match_id = ? and note is not null')
      .all(MATCH_ID);

    expect(notes.length).toBeGreaterThan(0);
  });
});

describe('сводка', () => {
  const text = reportMatch(db, MATCH_ID);

  it('помещается в десятки строк, а не в тысячи', () => {
    const lines = text.split('\n').length;

    expect(lines).toBeGreaterThan(10);
    expect(lines).toBeLessThan(120);
  });

  it('приводит величины и не выносит суждений', () => {
    // Инструмент, который сам решает, что хорошо, незаметно начинает
    // измерять то, что подтверждает его представление о хорошем.
    const both = `${text}\n${reportBatch(db)}`.toLowerCase();

    for (const judgement of ['хорошо', 'плохо', 'лучше', 'хуже', 'проблема', 'ошибка']) {
      expect(both).not.toContain(judgement);
    }
  });

  it('содержит то, ради чего затевалась', () => {
    expect(text).toContain('где стоял генерал');
    expect(text).toContain('что помешало покупке');
    expect(text).toContain('отрыв выбранного рубежа');
  });

  it('сводка пачки называет потери башен и их разброс', () => {
    const batch = reportBatch(db);

    expect(batch).toContain('башни и их потери');
    expect(batch).toContain('башен на пике');
    expect(batch).toContain('построек за матч на сторону');
  });

  it('сводка пачки называет, куда ложатся стены', () => {
    const batch = reportBatch(db);

    expect(batch).toContain('куда ложатся стены');
    expect(batch).toContain('в горле');
  });

  it('неизвестный матч не роняет сводку', () => {
    expect(reportMatch(db, 'нет-такого')).toContain('не найден');
  });
});
