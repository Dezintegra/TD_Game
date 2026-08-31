import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asPlayerId, flatten } from '@td/shared';
import type { Command, MatchSide, ThinRecord } from '@td/shared';
import { checksum, createWorld, step } from '@td/sim';
import { DEFAULT_PROFILE_ID, createOpponent, profileByName } from '@td/ai';
import { replay } from './replay.js';
import { readLogText } from './ingest.js';
import { logPathFor } from './log.js';
import type { LogRecord } from './records.js';

/**
 * Воспроизведение записи: то, ради чего запись существует.
 *
 * Настоящего сервера здесь нет, и он не нужен. Запись — это seed, состав
 * сторон, команды и суммы, и собрать её можно из обычного прогона:
 * важна форма, а не происхождение. Зато проверяется главное — что
 * решения компьютера восстанавливаются, что подмена его команды ловится
 * и что партия двух людей воспроизводится без него вовсе.
 *
 * Опорный матч прогоняется ОДИН на весь файл: минута игры считается
 * несколько секунд, и по матчу на тест превратило бы `pnpm verify`
 * в ожидание на ровном месте.
 */

const SECONDS = 25;
const SEED = 4242;
const AI_SEEDS = [SEED ^ 0x5bf03635, SEED ^ 0x2f6e1a77];
const TPS = 30;
const TICKS = SECONDS * TPS;

const dir = mkdtempSync(join(tmpdir(), 'arena-replay-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Опорный матч, сыгранный так, как его играет сервер.
 *
 * Это не прогон арены, и разница принципиальная. В арене противник решает
 * ДО шага и попадает командой в тот же тик. На сервере он обычный
 * участник: получает кадр, применяет его к своей копии мира и решает уже
 * ПОСЛЕ — то есть видит мир следующего тика (`joinMatch` в `@td/bot`
 * решает по `guest.confirmed`, а тот к моменту вызова уже шагнул).
 *
 * Прогон арены в роли опорного матча дал бы тест, который проходит
 * на выдуманных данных и падает на настоящих. Ровно это и случилось
 * при первой живой проверке: расхождение на 32-й команде.
 */
const played = (() => {
  const commands: { tick: number; player: number; kind: number; arg0: number; arg1: number }[] = [];
  const checksums = new Map<number, number>();

  const opponents = [0, 1].map((player) =>
    createOpponent(asPlayerId(player), AI_SEEDS[player] ?? 0, profileByName(DEFAULT_PROFILE_ID)),
  );

  let world = createWorld(SEED);
  let pending: Command[] = [];

  for (let tick = 0; tick < TICKS && world.winner === null; tick += 1) {
    // Команды, решённые на прошлом шаге, исполняются сейчас — и тик
    // исполнения это тик мира ДО шага, тот самый, по которому
    // воспроизведение будет их подавать.
    const at = world.tick;
    for (const command of pending) {
      const [arg0, arg1] = flatten(command);
      commands.push({ tick: at, player: command.player, kind: command.kind, arg0, arg1 });
    }

    world = step(world, pending);
    if (world.tick % TPS === 0) checksums.set(world.tick, checksum(world));

    pending = opponents.flatMap((opponent) => [...opponent.decide(world)]);
  }

  return { commands, checksums, ticks: world.tick };
})();

const readLog = (path: string): LogRecord[] =>
  readLogText(path)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogRecord);

const HUMAN: MatchSide = { who: 'human' };
const computer = (side: number): MatchSide => ({
  who: 'computer',
  profile: DEFAULT_PROFILE_ID,
  seed: AI_SEEDS[side] ?? 0,
});

interface Tweak {
  /** Подменить команду с этим номером по порядку у этой стороны. */
  readonly spoil?: { readonly player: number; readonly index: number; readonly kind: number };
}

/** Собрать запись матча в том виде, в каком её пишет сервер. */
const writeThin = (name: string, sides: readonly MatchSide[], tweak: Tweak = {}): string => {
  const lines: string[] = [
    JSON.stringify({
      t: 'thin',
      matchId: name,
      worldSeed: SEED,
      sides,
      gitSha: '',
      gitDirty: true,
      startedAt: '2026-08-21T12:00:00.000Z',
    }),
  ];

  const counts = new Map<number, number>();

  for (const command of played.commands) {
    const seen = counts.get(command.player) ?? 0;
    counts.set(command.player, seen + 1);

    const spoiled =
      tweak.spoil !== undefined &&
      tweak.spoil.player === command.player &&
      tweak.spoil.index === seen;

    lines.push(
      JSON.stringify({
        t: 'cmd',
        tick: command.tick,
        player: command.player,
        kind: spoiled ? tweak.spoil?.kind : command.kind,
        arg0: command.arg0,
        arg1: command.arg1,
      }),
    );
  }

  for (const [tick, value] of played.checksums) {
    lines.push(JSON.stringify({ t: 'sum', tick, value }));
  }

  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, `${lines.join('\n')}\n`);

  return path;
};

const decisionsIn = (path: string): LogRecord[] =>
  readLog(path).filter((record) => record.t === 'decision');

describe('матч человека против компьютера', () => {
  // Воспроизводится ОДИН раз на три проверки: прогон занимает секунды,
  // а результат от повторения не меняется.
  const result = replay(writeThin('human-vs-ai', [HUMAN, computer(1)]), dir);

  it('воспроизводится и сверяется по обоим счетам', () => {
    expect(result.checksums).toBeGreaterThan(0);
    // Сверены не только суммы, но и команды компьютера: суммы сошлись бы
    // и с переписанным противником, потому что мир ведут записанные
    // команды.
    expect(result.commands).toBeGreaterThan(0);
    expect(result.computerSides).toEqual([1]);
  });

  it('восстанавливает решения компьютера — то, ради чего разбор и есть', () => {
    const decisions = decisionsIn(result.logPath);

    expect(decisions.length).toBeGreaterThan(0);
    // Решения только компьютерной стороны: за человека решать некому.
    expect(new Set(decisions.map((record) => (record as { player: number }).player))).toEqual(
      new Set([1]),
    );
  });

  it('в подробном логе есть команды обеих сторон', () => {
    const players = new Set(
      readLog(result.logPath)
        .filter((record) => record.t === 'command')
        .map((record) => (record as { player: number }).player),
    );

    expect(players).toEqual(new Set([0, 1]));
  });
});

describe('матч двух людей', () => {
  it('воспроизводится, и решений в нём нет ни одного', () => {
    const path = writeThin('human-vs-human', [HUMAN, HUMAN]);
    const result = replay(path, dir);

    expect(result.computerSides).toEqual([]);
    expect(result.checksums).toBeGreaterThan(0);
    // Решать было некому — и выдумывать решения воспроизведение не стало.
    expect(decisionsIn(result.logPath)).toHaveLength(0);
    // Зато поведение людей записано целиком: обе стороны на месте.
    const players = new Set(
      readLog(result.logPath)
        .filter((record) => record.t === 'command')
        .map((record) => (record as { player: number }).player),
    );
    expect(players).toEqual(new Set([0, 1]));
  });
});

describe('сверка ловит расхождение', () => {
  it('изменившийся компьютер ловится, хотя суммы сходятся', () => {
    // Здесь и виден смысл второй сверки. Мир ведут записанные команды,
    // поэтому контрольные суммы совпадут при любом противнике — хоть
    // переписанном целиком. Ловит подмену только совпадение его
    // восстановленных команд с записанными.
    //
    // Роль «переписанного противника» играет другой профиль: он строит
    // стены вдвое реже, и разойтись с записью обязан.
    const path = writeThin('other-mind', [
      HUMAN,
      { who: 'computer', profile: 'wall-light-2026-08', seed: AI_SEEDS[1] ?? 0 },
    ]);

    let message = '';
    try {
      replay(path, dir);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/другое решение|меньше команд/u);
    // Именно вторая сверка, а не первая: мир воспроизведён верно,
    // и суммы сошлись.
    expect(message).not.toMatch(/разошлось с записью/u);
    // Разбор не пережил расхождения: подробного лога не осталось.
    expect(existsSync(logPathFor(dir, 'other-mind-replay'))).toBe(false);
  });

  it('незнакомый вид команды не пропускается молча', () => {
    // Ровно этот случай стоил Demolish и SetStance: воспроизведение
    // выбрасывало их и расходилось, а причина выглядела как правка правил.
    const path = writeThin('unknown', [HUMAN, computer(1)], {
      spoil: { player: 0, index: 0, kind: 99 },
    });

    expect(() => replay(path, dir)).toThrow(/неизвестного вида 99/u);
  });

  it('запись без заголовка не воспроизводится', () => {
    const path = join(dir, 'headless.jsonl');
    writeFileSync(path, `${JSON.stringify({ t: 'sum', tick: 30, value: 1 })}\n`);

    expect(() => replay(path, dir)).toThrow(/нет заголовка записи/u);
  });

  it('оборванная последняя строка не рушит воспроизведение', () => {
    const path = writeThin('torn', [HUMAN, computer(1)]);
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"t":"cmd","tick":1,"pla`);

    expect(() => replay(path, dir)).not.toThrow();
  });
});

describe('запись содержит записанное, а не восстановленное', () => {
  it('в записи нет ни одного вида строк, кроме входов', () => {
    const path = writeThin('shape', [HUMAN, computer(1)]);
    const kinds = new Set(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => (JSON.parse(line) as ThinRecord).t),
    );

    expect([...kinds].sort()).toEqual(['cmd', 'sum', 'thin']);
  });
});
