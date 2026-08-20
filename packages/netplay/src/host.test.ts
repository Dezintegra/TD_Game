import {
  CommandKind,
  INPUT_DELAY_MAX_TICKS,
  INPUT_DELAY_MIN_TICKS,
  MATCH_JOIN_TIMEOUT_SECONDS,
  MS_PER_TICK,
  RECONNECT_GRACE_SECONDS,
  TICKS_PER_SECOND,
  asPlayerId,
  asTickNumber,
} from '@td/shared';
import { checksum, createWorld } from '@td/sim';
import { MessageType, OutcomeReason } from '@td/protocol';
import type { PlayerId, UnownedCommand } from '@td/shared';
import type { ServerMessage } from '@td/protocol';
import { describe, expect, it } from 'vitest';
import { createMatchHost } from './host.js';
import { byTick, replayThrough } from './replay.js';
import { createClock } from './harness.test-utils.js';

const P0 = asPlayerId(0);
const P1 = asPlayerId(1);
const SEED = 4242;

const move = (tick: number, direction = 1): UnownedCommand => ({
  kind: CommandKind.MoveGeneral,
  tick: asTickNumber(tick),
  direction,
});

interface Bench {
  readonly host: ReturnType<typeof createMatchHost>;
  readonly clock: ReturnType<typeof createClock>;
  readonly sent: { readonly player: PlayerId; readonly message: ServerMessage }[];
  runMs(ms: number): void;
}

const bench = (join = true): Bench => {
  const clock = createClock();
  const sent: { player: PlayerId; message: ServerMessage }[] = [];

  const host = createMatchHost({
    seed: SEED,
    now: () => clock.now(),
    send: (player, message) => sent.push({ player, message }),
  });

  if (join) {
    host.join(P0);
    host.join(P1);
  }

  return {
    host,
    clock,
    sent,
    runMs(ms) {
      let left = ms;
      while (left > 0) {
        const slice = Math.min(MS_PER_TICK / 2, left);
        clock.advance(slice);
        left -= slice;
        host.advance();
      }
    },
  };
};

type TickFrameMessage = Extract<ServerMessage, { type: typeof MessageType.TickFrame }>;

const isFrame = (message: ServerMessage): message is TickFrameMessage =>
  message.type === MessageType.TickFrame;

const frames = (sent: Bench['sent'], player: PlayerId): TickFrameMessage[] =>
  sent
    .filter((entry) => entry.player === player)
    .map((entry) => entry.message)
    .filter(isFrame);

describe('ведущая сторона матча', () => {
  it('не считает тики, пока не подключились оба', () => {
    const table = bench(false);
    table.host.join(P0);

    table.runMs(1000);

    expect(table.host.phase).toBe('awaiting-players');
    expect(table.host.world.tick).toBe(0);
  });

  it('начинает считать, когда подключились оба', () => {
    const table = bench();
    table.runMs(1000);

    expect(table.host.phase).toBe('running');
    expect(table.host.world.tick).toBeGreaterThanOrEqual(TICKS_PER_SECOND - 1);
    expect(table.host.world.tick).toBeLessThanOrEqual(TICKS_PER_SECOND + 1);
  });

  it('шлёт кадр на каждый тик, включая пустые', () => {
    const table = bench();
    table.runMs(500);

    const ticks = frames(table.sent, P0).map((frame) => frame.tick);

    expect(ticks.length).toBe(table.host.world.tick);
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it('исполняет команду на запрошенном тике', () => {
    const table = bench();
    table.runMs(200);

    const at = table.host.world.tick + 3;
    table.host.submit(P0, move(at));
    table.runMs(400);

    const carrying = frames(table.sent, P1).filter((frame) => frame.commands.length > 0);

    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.tick).toBe(at);
    expect(carrying[0]?.commands[0]?.player).toBe(P0);
  });

  it('опоздавшую команду сдвигает вперёд, а не теряет', () => {
    const table = bench();
    table.runMs(400);

    const stale = table.host.world.tick - 5;
    table.host.submit(P0, move(stale));
    table.runMs(200);

    const carrying = frames(table.sent, P0).filter((frame) => frame.commands.length > 0);

    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.tick).toBeGreaterThan(stale);
  });

  it('не даёт запланировать команду далеко в будущее', () => {
    const table = bench();
    table.runMs(200);

    const far = table.host.world.tick + 10_000;
    table.host.submit(P0, move(far));
    table.runMs(2000);

    const carrying = frames(table.sent, P0).filter((frame) => frame.commands.length > 0);

    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.tick).toBeLessThanOrEqual(
      table.host.world.tick + INPUT_DELAY_MAX_TICKS * 2,
    );
  });

  it('проставляет сторону сам, по соединению', () => {
    const table = bench();
    table.runMs(200);

    table.host.submit(P1, move(table.host.world.tick + 2));
    table.runMs(300);

    const carrying = frames(table.sent, P0).filter((frame) => frame.commands.length > 0);

    expect(carrying[0]?.commands[0]?.player).toBe(P1);
  });

  it('начинает с наименьшей задержки и поднимает её по худшему каналу', () => {
    const table = bench();
    expect(table.host.delayTicks).toBe(INPUT_DELAY_MIN_TICKS);

    table.runMs(1100);

    const ping = table.sent.find(
      (entry) => entry.player === P1 && entry.message.type === MessageType.Ping,
    );
    expect(ping).toBeDefined();
    if (ping === undefined || ping.message.type !== MessageType.Ping) return;

    // Ответ пришёл через 200 мс: канал плохой у одного, задержка растёт
    // у обоих.
    table.clock.advance(200);
    table.host.observePong(P1, ping.message.nonce);

    expect(table.host.delayTicks).toBeGreaterThan(INPUT_DELAY_MIN_TICKS);

    const announced = table.sent.filter((entry) => entry.message.type === MessageType.InputDelay);
    expect(announced).toHaveLength(2);
    expect(announced.map((entry) => entry.player).sort()).toEqual([P0, P1]);
  });

  it('не опускает задержку, когда канал стал лучше', () => {
    const table = bench();
    table.runMs(1100);

    const first = table.sent.find(
      (entry) => entry.player === P1 && entry.message.type === MessageType.Ping,
    );
    if (first === undefined || first.message.type !== MessageType.Ping) throw new Error('нет ping');

    table.clock.advance(250);
    table.host.observePong(P1, first.message.nonce);
    const raised = table.host.delayTicks;

    table.runMs(1100);
    const second = table.sent
      .filter((entry) => entry.player === P1 && entry.message.type === MessageType.Ping)
      .at(-1);
    if (second === undefined || second.message.type !== MessageType.Ping) throw new Error('нет ping');

    table.host.observePong(P1, second.message.nonce);

    expect(table.host.delayTicks).toBe(raised);
  });

  it('задержка не выходит за границы', () => {
    const table = bench();
    table.runMs(1100);

    const ping = table.sent.find(
      (entry) => entry.player === P0 && entry.message.type === MessageType.Ping,
    );
    if (ping === undefined || ping.message.type !== MessageType.Ping) throw new Error('нет ping');

    table.clock.advance(10_000);
    table.host.observePong(P0, ping.message.nonce);

    expect(table.host.delayTicks).toBe(INPUT_DELAY_MAX_TICKS);
  });

  it('история воспроизводит то же состояние', () => {
    const table = bench();
    table.runMs(300);

    for (let index = 0; index < 6; index += 1) {
      table.host.submit(index % 2 === 0 ? P0 : P1, move(table.host.world.tick + 2, 1 + index));
      table.runMs(120);
    }
    table.runMs(500);

    const replayed = replayThrough(
      createWorld(SEED),
      byTick(table.host.history),
      table.host.world.tick - 1,
    );

    expect(replayed.tick).toBe(table.host.world.tick);
    expect(checksum(replayed)).toBe(checksum(table.host.world));
  });

  it('выдаёт историю с запрошенного тика', () => {
    const table = bench();
    table.runMs(300);
    table.host.submit(P0, move(table.host.world.tick + 1));
    table.runMs(300);

    table.host.serveHistory(P1, 0);

    const history = table.sent
      .filter((entry) => entry.player === P1 && entry.message.type === MessageType.History)
      .at(-1)?.message;

    expect(history?.type).toBe(MessageType.History);
    if (history?.type !== MessageType.History) return;

    expect(history.commands).toHaveLength(1);
    expect(history.throughTick).toBe(table.host.world.tick - 1);
  });

  it('шлёт контрольную сумму раз в секунду', () => {
    const table = bench();
    table.runMs(2100);

    const sums = table.sent
      .filter((entry) => entry.player === P0 && entry.message.type === MessageType.Checksum)
      .map((entry) => entry.message);

    expect(sums.length).toBeGreaterThanOrEqual(2);
    for (const sum of sums) {
      if (sum.type !== MessageType.Checksum) continue;
      expect(sum.tick % TICKS_PER_SECOND).toBe(0);
    }
  });

  it('не пришедшему на матч засчитывает поражение', () => {
    const table = bench(false);
    table.host.join(P0);

    table.runMs(MATCH_JOIN_TIMEOUT_SECONDS * 1000 + 100);

    expect(table.host.phase).toBe('finished');
    expect(table.host.outcome).toEqual({ winner: P0, reason: OutcomeReason.NoShow });
  });

  it('мир идёт дальше, пока участник отключён', () => {
    const table = bench();
    table.runMs(300);

    const before = table.host.world.tick;
    table.host.drop(P1);
    table.runMs(1000);

    expect(table.host.world.tick).toBeGreaterThan(before + TICKS_PER_SECOND - 2);
    expect(table.host.phase).toBe('running');
  });

  it('не вернувшемуся засчитывает поражение', () => {
    const table = bench();
    table.runMs(300);
    table.host.drop(P1);

    table.runMs(RECONNECT_GRACE_SECONDS * 1000 + 100);

    expect(table.host.outcome).toEqual({ winner: P0, reason: OutcomeReason.Disconnected });
  });

  it('вернувшийся вовремя сохраняет матч', () => {
    const table = bench();
    table.runMs(300);
    table.host.drop(P1);

    table.runMs(RECONNECT_GRACE_SECONDS * 1000 - 500);
    table.host.join(P1);
    table.runMs(2000);

    expect(table.host.phase).toBe('running');
    expect(table.host.outcome).toBeNull();
  });

  it('выход из матча — поражение вышедшего', () => {
    const table = bench();
    table.runMs(300);

    table.host.forfeit(P0);

    expect(table.host.outcome).toEqual({ winner: P1, reason: OutcomeReason.Left });
    const over = table.sent.filter((entry) => entry.message.type === MessageType.MatchOver);
    expect(over).toHaveLength(2);
  });

  it('после конца матча команды не принимаются', () => {
    const table = bench();
    table.runMs(300);
    table.host.forfeit(P0);

    const before = table.host.world.tick;
    table.host.submit(P1, move(before + 2));
    table.runMs(500);

    expect(table.host.world.tick).toBe(before);
    expect(table.host.history).toHaveLength(0);
  });

  it('не наверстывает долг разом после долгой заминки', () => {
    const table = bench();
    table.runMs(200);

    const before = table.host.world.tick;
    table.clock.advance(60_000);
    table.host.advance();

    expect(table.host.world.tick - before).toBeLessThanOrEqual(60);
  });
});
