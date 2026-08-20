import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { CHILD_TABLES, SCHEMA } from './schema.js';
import type { LogRecord } from './records.js';

/**
 * Сборка базы из логов.
 *
 * Отдельный шаг, а не запись прямо в базу во время матча. Причина
 * практическая: схема будет меняться, и первые же разборы покажут,
 * что половина столбцов не нужна, а трёх недостаёт. При прямой записи
 * каждое такое изменение означало бы переигрывание всех матчей заново.
 *
 * Сборка идемпотентна: повторный прогон того же лога не задваивает
 * строки. Матч определяется своим идентификатором, и его прежние строки
 * удаляются перед вставкой.
 */

const bit = (value: boolean): number => (value ? 1 : 0);

/**
 * Снять метку порядка байтов, если она есть.
 *
 * Наши писатели её не ставят, но файл мог побывать в редакторе — многие
 * из них добавляют BOM молча. Без этой строки первая запись перестаёт
 * разбираться, и инструмент сообщает «нет заголовка» о файле, где
 * заголовок прекрасно виден глазами. Час на такую загадку — час впустую.
 */
export const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

export interface IngestResult {
  readonly matches: number;
  readonly rows: number;
  /** Строки, которые не удалось разобрать. Обычно оборванный хвост. */
  readonly broken: number;
}

/**
 * Та часть модуля, которой мы пользуемся.
 *
 * Описана явно, а не через `typeof import(...)`: аннотации-импорты
 * в проекте запрещены линтом, да и перечислить нужное честнее — видно,
 * что от целого модуля нам требуется один конструктор.
 */
interface SqliteModule {
  readonly DatabaseSync: new (path: string) => DatabaseSync;
}

/**
 * Загрузка `node:sqlite` в обход загрузчика Vite.
 *
 * И статический, и динамический `import('node:sqlite')` здесь не годятся,
 * и это не каприз. Vitest работает поверх Vite, а тот подменяет собой
 * загрузку модулей — включая динамическую. Список встроенных модулей
 * Node внутри Vite старше, чем сам `node:sqlite`, поэтому Vite принимает
 * его за пакет `sqlite` из node_modules и падает, не найдя.
 *
 * `createRequire` — обычный вызов функции, подменять его Vite нечем,
 * и Node разрешает имя сам, как и должен. Работает одинаково и под
 * тестами, и в собранной арене.
 *
 * Загрузка отложена до первого обращения ещё и потому, что модуль помечен
 * экспериментальным и при загрузке печатает предупреждение. Прогону
 * матчей база не нужна вовсе, и пугать этим предупреждением того, кто
 * просто гоняет матчи, незачем.
 */
const loadSqlite = (): SqliteModule =>
  createRequire(import.meta.url)('node:sqlite') as SqliteModule;

export const openDatabase = (path: string): DatabaseSync => {
  const { DatabaseSync: Database } = loadSqlite();

  const db = new Database(path);
  db.exec(SCHEMA);

  return db;
};

/**
 * Разбор одного файла лога.
 *
 * Оборванная последняя строка — штатная ситуация, а не ошибка: прогон
 * могли прервать, и годные первые строки от этого годными быть
 * не перестали. Такая строка пропускается с подсчётом, а не роняет сборку.
 */
const parse = (path: string): { records: LogRecord[]; broken: number } => {
  const lines = stripBom(readFileSync(path, 'utf8')).split('\n');
  const records: LogRecord[] = [];
  let broken = 0;

  for (const line of lines) {
    if (line.length === 0) continue;

    try {
      records.push(JSON.parse(line) as LogRecord);
    } catch {
      broken += 1;
    }
  }

  return { records, broken };
};

export const ingestFile = (db: DatabaseSync, path: string): IngestResult => {
  const { records, broken } = parse(path);

  const header = records.find((record) => record.t === 'match');
  if (header === undefined) return { matches: 0, rows: 0, broken };

  const footer = records.find((record) => record.t === 'end');
  const matchId = header.matchId;

  const insertMatch = db.prepare(`
    insert or replace into match
      (match_id, kind, world_seed, ai_seed_0, ai_seed_1, profile_0, profile_1,
       git_sha, git_dirty, started_at, ticks, winner, end_reason, wall_ms)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSample = db.prepare(`
    insert into sample values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDecision = db.prepare(`
    insert into decision values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAttempt = db.prepare('insert into attempt values (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertFrontier = db.prepare('insert into frontier values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertCommand = db.prepare('insert into command values (?, ?, ?, ?, ?, ?, ?, ?)');

  let rows = 0;

  db.exec('begin');
  try {
    for (const table of CHILD_TABLES) {
      db.prepare(`delete from ${table} where match_id = ?`).run(matchId);
    }

    insertMatch.run(
      matchId,
      header.kind,
      header.worldSeed,
      header.aiSeeds[0] ?? null,
      header.aiSeeds[1] ?? null,
      header.profiles[0] ?? null,
      header.profiles[1] ?? null,
      header.gitSha,
      bit(header.gitDirty),
      header.startedAt,
      footer?.ticks ?? null,
      footer?.winner ?? null,
      footer?.endReason ?? null,
      footer?.wallMs ?? null,
    );

    for (const record of records) {
      switch (record.t) {
        case 'sample':
          insertSample.run(
            matchId,
            record.tick,
            record.player,
            record.energy,
            record.incomePerTick,
            record.unitsAlive,
            record.structures,
            record.towers,
            record.walls,
            record.baseHp,
            record.generalCell,
            record.generalHp,
            bit(record.generalAlive),
            record.queueLen,
            record.upgradeTotalLevel,
            record.targetStructure,
          );
          rows += 1;
          break;

        case 'decision':
          insertDecision.run(
            matchId,
            record.tick,
            record.player,
            record.phaseIndex,
            record.waitStreak,
            bit(record.impatient),
            bit(record.escorting),
            record.liveUnits,
            record.nearbyUnits,
            record.spendOrder.join(','),
            record.energy,
            bit(record.struck),
            record.commandCount,
            record.generalCell,
            record.generalFromHome,
            record.approachShortest,
          );
          rows += 1;

          record.attempts.forEach((attempt, ord) => {
            insertAttempt.run(
              matchId,
              record.tick,
              record.player,
              ord,
              attempt.spending,
              attempt.result,
              attempt.note ?? null,
              attempt.price ?? null,
            );
            rows += 1;
          });

          for (const frontier of record.frontiers) {
            insertFrontier.run(
              matchId,
              record.tick,
              record.player,
              frontier.fraction,
              frontier.cell,
              frontier.coverage,
              frontier.gain,
              frontier.risk,
              frontier.score,
              frontier.deathChance,
              bit(frontier.chosen),
            );
            rows += 1;
          }
          break;

        case 'command':
          insertCommand.run(
            matchId,
            record.tick,
            record.player,
            record.kind,
            record.arg0,
            record.arg1,
            bit(record.accepted),
            record.rejectReason,
          );
          rows += 1;
          break;

        default:
          break;
      }
    }

    db.exec('commit');
  } catch (error) {
    db.exec('rollback');
    throw error;
  }

  return { matches: 1, rows, broken };
};
