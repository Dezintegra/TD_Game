import {
  CommandKind,
  PLAYERS_PER_MATCH,
  StructureKind,
  TICKS_PER_SECOND,
  asPlayerId,
} from '@td/shared';
import type { Command, PlayerId } from '@td/shared';
import { cellAt, checksum, createWorld, playerStats, step } from '@td/sim';
import type { WorldState } from '@td/sim';
import { createOpponent, profileByName } from '@td/ai';
import type { DecisionRecord, Opponent } from '@td/ai';
import type { LogWriter } from './log.js';
import type { CommandRecord, MatchFooter, MatchHeader, SampleRecord } from './records.js';
import { codeVersion } from './version.js';

/**
 * Безголовый матч.
 *
 * Возможен ровно потому, что противник не часть ядра и общается с миром
 * только командами: берём мир, берём двух противников, крутим тики.
 * Ни браузера, ни рендера, ни таймеров — только чистая функция шага
 * и два детерминированных игрока.
 */

/**
 * Предел длительности матча.
 *
 * Обязателен. Матч двух одинаковых противников может не кончиться никогда:
 * обе стороны копят, строят и упираются друг в друга. Двадцать минут —
 * заметно больше расчётной длительности матча, так что упереться в предел
 * означает не «не хватило времени», а «добить некому».
 */
export const MATCH_TICK_CAP = 20 * 60 * TICKS_PER_SECOND;

/** Как часто снимается состояние сторон. Раз в игровую секунду. */
const SAMPLE_EVERY = TICKS_PER_SECOND;

/**
 * Как часто снимается контрольная сумма при записи матча.
 *
 * Раз в секунду. Чаще незачем: расхождение накапливается, и тик его
 * появления с точностью до секунды достаточен, чтобы понять причину.
 */
export const CHECKSUM_EVERY = TICKS_PER_SECOND;

export interface MatchOptions {
  readonly matchId: string;
  readonly worldSeed: number;
  readonly aiSeeds: readonly number[];
  readonly profiles: readonly string[];
  readonly log: LogWriter;
  readonly tickCap?: number;
  /**
   * Команды человека по тикам. Пусто для матча компьютеров.
   *
   * Ключ — номер тика, значение — команды, поданные на этом тике.
   */
  readonly scripted?: ReadonlyMap<number, readonly Command[]>;
  /** Кто из игроков управляется компьютером. По умолчанию оба. */
  readonly computerPlayers?: readonly number[];
}

export interface MatchResult {
  readonly ticks: number;
  readonly winner: number | null;
  readonly endReason: MatchFooter['endReason'];
  readonly wallMs: number;
  /** Контрольные суммы по тикам: для сверки при воспроизведении. */
  readonly checksums: ReadonlyMap<number, number>;
}

/** Аргументы команды в плоском виде. Смысл зависит от вида команды. */
const argsOf = (command: Command): readonly [number, number] => {
  switch (command.kind) {
    case CommandKind.MoveGeneral:
      return [command.direction, 0];
    case CommandKind.Build:
      return [command.cell, command.structure];
    case CommandKind.TrainUnit:
      return [command.unitType, 0];
    case CommandKind.SetTarget:
      return [command.cell, 0];
    case CommandKind.BuyUpgrade:
      return [command.branch, 0];
    case CommandKind.LaunchNuke:
      return [command.cell, 0];
    case CommandKind.Demolish:
      return [command.cell, 0];
  }
};

const sampleOf = (world: WorldState, player: PlayerId): SampleRecord => {
  const state = world.players[player];
  const general = world.generals[player];
  const stats = state === undefined ? undefined : playerStats(state);

  let unitsAlive = 0;
  for (const unit of world.units) {
    if (unit.owner === player) unitsAlive += 1;
  }

  let structures = 0;
  let towers = 0;
  let walls = 0;
  let baseHp = 0;

  for (const structure of world.structures) {
    if (structure.owner !== player) continue;

    if (structure.kind === StructureKind.Base) {
      baseHp = structure.health;
      continue;
    }

    structures += 1;
    if (structure.kind === StructureKind.Wall) walls += 1;
    else towers += 1;
  }

  return {
    t: 'sample',
    tick: world.tick,
    player,
    energy: state?.energy ?? 0,
    incomePerTick: stats?.incomePerTick ?? 0,
    unitsAlive,
    structures,
    towers,
    walls,
    baseHp,
    generalCell: general === undefined || !general.alive ? -1 : cellAt(general.position),
    generalHp: general?.health ?? 0,
    generalAlive: general?.alive ?? false,
    queueLen: state?.queue.length ?? 0,
    upgradeTotalLevel: state?.upgrades.reduce((sum, upgrade) => sum + upgrade.level, 0) ?? 0,
    targetStructure: state?.targetStructure ?? 0,
  };
};

export const runMatch = (options: MatchOptions): MatchResult => {
  const {
    matchId,
    worldSeed,
    aiSeeds,
    profiles,
    log,
    tickCap = MATCH_TICK_CAP,
    scripted,
    computerPlayers = Array.from({ length: PLAYERS_PER_MATCH }, (_unused, index) => index),
  } = options;

  const version = codeVersion();
  const header: MatchHeader = {
    t: 'match',
    matchId,
    kind: scripted === undefined ? 'arena' : 'replay',
    worldSeed,
    aiSeeds,
    profiles,
    gitSha: version.sha,
    gitDirty: version.dirty,
    // Время съёмки — метка для человека, а не входные данные. В самой
    // симуляции часов нет и быть не может.
    startedAt: new Date().toISOString(),
  };
  log.write(header);

  // Наблюдатели пишут в лог напрямую. Порядок записей внутри тика
  // при этом сохраняется: решение — команды — снимок.
  const opponents = new Map<number, Opponent>();
  for (const player of computerPlayers) {
    const seed = aiSeeds[player] ?? worldSeed;
    const profileId = profiles[player];
    const profile = profileId === undefined ? undefined : profileByName(profileId);

    opponents.set(
      player,
      createOpponent(asPlayerId(player), seed, profile, (record: DecisionRecord) => {
        log.write({ ...record, t: 'decision' });
      }),
    );
  }

  let world = createWorld(worldSeed);
  const checksums = new Map<number, number>();
  const started = Date.now();

  let tick = 0;
  for (; tick < tickCap && world.winner === null; tick += 1) {
    const issued: Command[] = [];
    for (const [, opponent] of opponents) issued.push(...opponent.decide(world));
    for (const command of scripted?.get(world.tick) ?? []) issued.push(command);

    const next = step(world, issued);

    if (issued.length > 0) {
      const refused = new Map(next.rejections.map((entry) => [entry.index, entry.reason]));

      issued.forEach((command, index) => {
        const reason = refused.get(index);
        const [arg0, arg1] = argsOf(command);
        const record: CommandRecord = {
          t: 'command',
          tick: next.tick,
          player: command.player,
          kind: command.kind,
          arg0,
          arg1,
          accepted: reason === undefined,
          rejectReason: reason ?? null,
        };
        log.write(record);
      });
    }

    world = next;

    if (world.tick % SAMPLE_EVERY === 0) {
      for (let player = 0; player < PLAYERS_PER_MATCH; player += 1) {
        log.write(sampleOf(world, asPlayerId(player)));
      }
    }

    if (world.tick % CHECKSUM_EVERY === 0) checksums.set(world.tick, checksum(world));
  }

  const footer: MatchFooter = {
    t: 'end',
    ticks: world.tick,
    winner: world.winner,
    endReason: world.winner === null ? 'timeout' : 'base-destroyed',
    wallMs: Date.now() - started,
  };
  log.write(footer);
  log.close();

  return {
    ticks: world.tick,
    winner: world.winner,
    endReason: footer.endReason,
    wallMs: footer.wallMs,
    checksums,
  };
};
