import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { CommandKind, TICKS_PER_SECOND, asPlayerId, asTickNumber } from '@td/shared';
import type { Command, StructureKind, UnitType } from '@td/shared';
import { DEFAULT_PROFILE_ID } from '@td/ai';
import { createLogWriter } from './log.js';
import { runMatch } from './match.js';
import { ingestFile, openDatabase, stripBom } from './ingest.js';
import { reportBatch, reportMatch } from './report.js';
import type { ThinRecord } from './records.js';

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
      Воспроизвести записанный матч человека, сверяя контрольные суммы,
      и создать подробный лог. Расхождение — остановка с указанием тика.

  arena ingest [каталог]
      Собрать базу SQLite из логов. Идемпотентно: повторный прогон
      того же лога строки не задваивает.

  arena report [идентификатор матча]
      Напечатать сводку. Без аргумента — по всей пачке.

Логи и база лежат в .matchlog/ в корне репозитория.
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

const LOG_DIR = join(repoRoot(), '.matchlog');
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
  if (!Number.isFinite(value)) throw new Error(`флаг --${name} должен быть числом, получено «${raw}»`);

  return value;
};

// ─────────────────────────────────────────────────────────────────────────
// run
// ─────────────────────────────────────────────────────────────────────────

const matchIdOf = (seed: number, profiles: readonly string[]): string =>
  `s${String(seed)}-${profiles.join('-vs-')}`;

const runOne = (
  seed: number,
  profiles: readonly string[],
  seconds: number | undefined,
): void => {
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
// replay
// ─────────────────────────────────────────────────────────────────────────

const commandOf = (record: { kind: number; player: number; tick: number; arg0: number; arg1: number }): Command | undefined => {
  const player = asPlayerId(record.player);
  const tick = asTickNumber(record.tick);

  switch (record.kind) {
    case CommandKind.MoveGeneral:
      return { kind: CommandKind.MoveGeneral, player, tick, direction: record.arg0 };
    case CommandKind.Build:
      // Приведение осознанное: запись пришла из файла, то есть
      // из недоверенного источника, и числу в ней верить нельзя.
      // Проверит его ядро — оно всё равно проверяет каждую команду,
      // и негодную отклонит с причиной.
      return {
        kind: CommandKind.Build,
        player,
        tick,
        cell: record.arg0,
        structure: record.arg1 as StructureKind,
      };
    case CommandKind.TrainUnit:
      return { kind: CommandKind.TrainUnit, player, tick, unitType: record.arg0 as UnitType };
    case CommandKind.SetTarget:
      return { kind: CommandKind.SetTarget, player, tick, cell: record.arg0 };
    case CommandKind.BuyUpgrade:
      return { kind: CommandKind.BuyUpgrade, player, tick, branch: record.arg0 };
    case CommandKind.LaunchNuke:
      return { kind: CommandKind.LaunchNuke, player, tick, cell: record.arg0 };
    default:
      return undefined;
  }
};

const replay = (path: string): void => {
  const records = stripBom(readFileSync(path, 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line): ThinRecord[] => {
      try {
        return [JSON.parse(line) as ThinRecord];
      } catch {
        // Оборванный хвост прерванной записи. Годные строки от этого
        // годными быть не перестали.
        return [];
      }
    });

  const header = records.find((record) => record.t === 'thin');
  if (header === undefined) throw new Error(`в файле ${path} нет заголовка записи`);

  const scripted = new Map<number, Command[]>();
  for (const record of records) {
    if (record.t !== 'cmd') continue;

    const command = commandOf(record);
    if (command === undefined) continue;

    const bucket = scripted.get(record.tick) ?? [];
    bucket.push(command);
    scripted.set(record.tick, bucket);
  }

  const expected = new Map<number, number>();
  for (const record of records) {
    if (record.t === 'sum') expected.set(record.tick, record.value);
  }

  const matchId = `${header.matchId}-replay`;
  const log = createLogWriter(join(LOG_DIR, `${matchId}.jsonl`));

  // Воспроизведение кончается там, где кончилась запись.
  //
  // Продолжать дальше технически можно — противник детерминирован
  // и доиграет сам, — но это было бы враньём: получилось бы «что было
  // бы, если бы человек бросил играть», выданное за запись матча.
  // Разбор таких минут вводил бы в заблуждение ровно там, где он должен
  // давать опору.
  const recorded = Math.max(0, ...expected.keys(), ...scripted.keys());

  // Полная запись — та, где сохранены команды обеих сторон.
  //
  // Такими стали записи сетевых матчей: кадрами приходят действия обоих
  // участников, и клиенту известно всё, что произошло. Подставлять
  // в такую запись думающего противника нельзя — его решения легли бы
  // поверх уже записанных, и воспроизведение разошлось бы на первом же
  // из них. Признак полноты — пустой список профилей: думать некому,
  // потому что думать не о чем.
  //
  // Прежние записи, где сохранены только команды человека, продолжают
  // воспроизводиться по-старому: за соперника доигрывает компьютер.
  const complete = header.profiles.length === 0;

  const result = runMatch({
    matchId,
    worldSeed: header.worldSeed,
    aiSeeds: header.aiSeeds,
    profiles: header.profiles,
    log,
    scripted,
    tickCap: recorded,
    computerPlayers: complete ? [] : [0, 1].filter((player) => player !== header.humanPlayer),
  });

  // Сверка. Расхождение означает, что воспроизведён не тот матч,
  // и продолжать разбор нельзя: анализировали бы мы матч, которого
  // не было.
  for (const [tick, value] of expected) {
    const got = result.checksums.get(tick);
    if (got === undefined) continue;

    if (got !== value) {
      throw new Error(
        `воспроизведение разошлось с записью на тике ${String(tick)}: ` +
          `ожидалось ${String(value)}, получено ${String(got)}. ` +
          'Скорее всего, код изменился с момента записи ' +
          `(запись сделана на ${header.gitSha.slice(0, 8)}${header.gitDirty ? ', дерево было грязным' : ''}).`,
      );
    }
  }

  process.stdout.write(
    `${matchId}: воспроизведено, сверено ${String(expected.size)} контрольных сумм, ` +
      `${String(Math.round(result.ticks / TICKS_PER_SECOND))} с игры\n`,
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

      replay(resolve(path));
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
