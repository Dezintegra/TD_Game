import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { TICKS_PER_SECOND } from '@td/shared';
import { DEFAULT_PROFILE_ID } from '@td/ai';
import { createLogWriter } from './log.js';
import { runMatch } from './match.js';
import { replayAndReport } from './replay.js';
import { ingestFile, openDatabase } from './ingest.js';
import { reportBatch, reportMatch } from './report.js';
import { printTempo } from './tempo.js';

/**
 * Арена — инструмент разработки, а не часть игры.
 *
 * Четыре команды: гонять матчи, воспроизводить записанные, собирать базу
 * из логов, печатать сводки. Разбор аргументов написан руками, без
 * библиотеки: команд четыре, флагов десяток, и зависимость ради этого
 * была бы дороже самого разбора.
 */

const USAGE = `
арена — безголовые матчи и разбор поведения противника

  arena run [--matches N] [--seed N] [--profiles A,B] [--jobs N] [--seconds N]
      Прогнать N матчей компьютер-против-компьютера. Матчи независимы
      и считаются параллельно по числу ядер.

  arena replay <файл>
      Воспроизвести записанный матч и создать подробный лог: решения
      компьютерных сторон восстанавливаются прогоном, мир ведут
      записанные команды. Сверяются и контрольные суммы, и команды
      компьютера; расхождение — остановка с указанием тика, без лога.

  arena tempo <файл>
      Показать, вовремя ли шёл записанный матч. Контрольные суммы
      снимаются раз в игровую секунду, значит между двумя соседними
      обязана пройти секунда реального времени; всё сверх — отставание
      сервера, то самое, что игрок видит рывком.

  arena ingest [каталог]
      Собрать базу SQLite из логов. Идемпотентно: повторный прогон
      того же лога строки не задваивает.

  arena report [идентификатор матча]
      Напечатать сводку. Без аргумента — по всей пачке.

Логи и база лежат в .matchlog/ в корне репозитория. Записи матчей,
сыгранных людьми, кладёт туда же игровой сервер, запущенный с MATCHLOG=1.
`.trim();

// ─────────────────────────────────────────────────────────────────────────
// Пути
// ─────────────────────────────────────────────────────────────────────────

/**
 * Корень репозитория — каталог с `pnpm-workspace.yaml`.
 *
 * Ищется вверх от места запуска, а не берётся из `process.cwd()`:
 * арену запускают и из корня, и из своего каталога, и логи в обоих
 * случаях должны ложиться в одно и то же место.
 */
const repoRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }

  return process.cwd();
};

/**
 * Куда класть логи и базу.
 *
 * Переменная нужна не для красоты. В одном рабочем дереве работают
 * несколько сессий разом, и каждая гоняет свои пачки матчей: без
 * отдельного каталога их логи ложатся вперемешку, сводка считает чужие
 * матчи своими, а уборка перед прогоном сносит чужую работу. Имя
 * и смысл те же, что у `MATCHLOG_DIR` игрового сервера.
 */
const LOG_DIR = resolve(process.env['ARENA_DIR'] ?? join(repoRoot(), '.matchlog'));
const DB_PATH = join(LOG_DIR, 'arena.sqlite');

// ─────────────────────────────────────────────────────────────────────────
// Аргументы
// ─────────────────────────────────────────────────────────────────────────

const flagsOf = (argv: readonly string[]): ReadonlyMap<string, string> => {
  const flags = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith('--')) continue;

    const next = argv[index + 1];
    flags.set(token.slice(2), next === undefined || next.startsWith('--') ? 'true' : next);
  }

  return flags;
};

const numberFlag = (flags: ReadonlyMap<string, string>, name: string, fallback: number): number => {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new Error(`флаг --${name} должен быть числом, получено «${raw}»`);

  return value;
};

// ─────────────────────────────────────────────────────────────────────────
// run
// ─────────────────────────────────────────────────────────────────────────

const matchIdOf = (seed: number, profiles: readonly string[]): string =>
  `s${String(seed)}-${profiles.join('-vs-')}`;

const runOne = (seed: number, profiles: readonly string[], seconds: number | undefined): void => {
  const matchId = matchIdOf(seed, profiles);
  const log = createLogWriter(join(LOG_DIR, `${matchId}.jsonl`));

  const result = runMatch({
    matchId,
    worldSeed: seed,
    // Seed противника отличается от seed мира: иначе манера игры была бы
    // жёстко связана с картой, и «тот же противник на другой карте»
    // стало бы невыразимо.
    aiSeeds: [seed ^ 0x5bf03635, seed ^ 0x2f6e1a77],
    profiles,
    log,
    ...(seconds === undefined ? {} : { tickCap: seconds * TICKS_PER_SECOND }),
  });

  process.stdout.write(
    `${matchId}: ${result.endReason}, победитель ${String(result.winner ?? '—')}, ` +
      `${String(Math.round(result.ticks / TICKS_PER_SECOND))} с игры за ${(result.wallMs / 1000).toFixed(1)} с\n`,
  );
};

/** Раздать seed по процессам примерно поровну. */
const chunked = (seeds: readonly number[], jobs: number): readonly (readonly number[])[] => {
  const chunks: number[][] = Array.from({ length: Math.min(jobs, seeds.length) }, () => []);

  seeds.forEach((seed, index) => {
    // По кругу, а не подряд: матчи с соседними seed могут заметно
    // различаться по длительности, и раздача подряд оставила бы один
    // процесс дожёвывать хвост, пока остальные простаивают.
    chunks[index % chunks.length]?.push(seed);
  });

  return chunks;
};

const spawnWorker = (self: string, args: readonly string[]): Promise<void> =>
  new Promise((done, fail) => {
    const child = spawn(process.execPath, [self, ...args], { stdio: 'inherit' });

    child.on('error', fail);
    child.on('exit', (code) => {
      if (code === 0) done();
      else fail(new Error(`процесс завершился с кодом ${String(code)}`));
    });
  });

const runBatch = async (flags: ReadonlyMap<string, string>): Promise<void> => {
  const matches = numberFlag(flags, 'matches', 4);
  const firstSeed = numberFlag(flags, 'seed', 1000);
  const seconds = flags.has('seconds') ? numberFlag(flags, 'seconds', 0) : undefined;
  const profiles = (flags.get('profiles') ?? `${DEFAULT_PROFILE_ID},${DEFAULT_PROFILE_ID}`).split(
    ',',
  );
  const jobs = Math.max(1, numberFlag(flags, 'jobs', Math.max(1, availableParallelism() - 1)));

  mkdirSync(LOG_DIR, { recursive: true });

  const seeds = Array.from({ length: matches }, (_unused, index) => firstSeed + index);
  process.stdout.write(
    `прогон ${String(matches)} матчей, ${String(jobs)} процессов, ` +
      `профили ${profiles.join(' против ')}\n`,
  );

  const started = Date.now();

  if (jobs === 1) {
    for (const seed of seeds) runOne(seed, profiles, seconds);
  } else {
    // Матчи независимы, разделяемого состояния нет, поэтому параллелизм
    // сводится к раздаче seed по процессам: каждый пишет свой файл,
    // синхронизировать нечего.
    const self = fileURLToPath(import.meta.url);

    await Promise.all(
      chunked(seeds, jobs).map((chunk) =>
        spawnWorker(self, [
          'run-one',
          '--seeds',
          chunk.join(','),
          '--profiles',
          profiles.join(','),
          ...(seconds === undefined ? [] : ['--seconds', String(seconds)]),
        ]),
      ),
    );
  }

  process.stdout.write(
    `готово за ${((Date.now() - started) / 1000).toFixed(1)} с; ` +
      'дальше: arena ingest, затем arena report\n',
  );
};

// ─────────────────────────────────────────────────────────────────────────
// ingest / report
// ─────────────────────────────────────────────────────────────────────────

const ingest = (dir: string): void => {
  if (!existsSync(dir)) throw new Error(`каталог ${dir} не существует — сначала прогоните матчи`);

  const db = openDatabase(DB_PATH);
  let matches = 0;
  let rows = 0;
  let broken = 0;

  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;

    const result = ingestFile(db, join(dir, name));
    matches += result.matches;
    rows += result.rows;
    broken += result.broken;
  }

  db.close();

  process.stdout.write(
    `собрано: матчей ${String(matches)}, строк ${String(rows)}` +
      `${broken > 0 ? `, пропущено битых строк ${String(broken)}` : ''}\n` +
      `база: ${DB_PATH}\n`,
  );
};

const report = (matchId: string | undefined): void => {
  if (!existsSync(DB_PATH)) throw new Error('базы нет — сначала выполните `arena ingest`');

  const db = openDatabase(DB_PATH);
  process.stdout.write(`${matchId === undefined ? reportBatch(db) : reportMatch(db, matchId)}\n`);
  db.close();
};

// ─────────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const [, , command, ...rest] = process.argv;
  const flags = flagsOf(rest);

  switch (command) {
    case 'run':
      await runBatch(flags);
      return;

    case 'run-one': {
      // Служебная команда: её запускает `run` в дочерних процессах.
      const seeds = (flags.get('seeds') ?? '').split(',').map(Number).filter(Number.isFinite);
      const profiles = (flags.get('profiles') ?? DEFAULT_PROFILE_ID).split(',');
      const seconds = flags.has('seconds') ? numberFlag(flags, 'seconds', 0) : undefined;

      for (const seed of seeds) runOne(seed, profiles, seconds);
      return;
    }

    case 'replay': {
      const path = rest[0];
      if (path === undefined) throw new Error('укажите файл записи: arena replay <файл>');

      replayAndReport(resolve(path), LOG_DIR);
      return;
    }

    case 'tempo': {
      const path = rest[0];
      if (path === undefined) throw new Error('укажите файл записи: arena tempo <файл>');

      printTempo(resolve(path));
      return;
    }

    case 'ingest':
      ingest(rest[0] === undefined || rest[0].startsWith('--') ? LOG_DIR : resolve(rest[0]));
      return;

    case 'report':
      report(rest[0] === undefined || rest[0].startsWith('--') ? undefined : rest[0]);
      return;

    default:
      process.stdout.write(`${USAGE}\n`);
      process.exitCode = command === undefined ? 0 : 1;
  }
};

// Ошибка печатается сообщением, а не стеком: почти все они адресованы
// человеку («базы нет», «воспроизведение разошлось на тике таком-то»),
// и стек в этих случаях только мешает читать.
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
