import {
  CHECKSUM_INTERVAL_TICKS,
  CommandKind,
  asPlayerId,
  asTickNumber,
  withPlayer,
} from '@td/shared';
import { checksum, createWorld, step } from '@td/sim';
import { MessageType, OutcomeReason } from '@td/protocol';
import type { Command, CommandIntent, UnownedCommand } from '@td/shared';
import type { ClientMessage, ServerMessage } from '@td/protocol';
import { describe, expect, it } from 'vitest';
import { createMatchGuest } from './guest.js';
import type { GuestStatus, MatchGuest } from './guest.js';

const SEED = 777;
const ME = asPlayerId(1);
const FOE = asPlayerId(0);
const DELAY = 3;

const goEast: CommandIntent = { kind: CommandKind.MoveGeneral, direction: 1 };
const goWest: CommandIntent = { kind: CommandKind.MoveGeneral, direction: 5 };

const welcome = (tick = 0): ServerMessage => ({
  type: MessageType.Welcome,
  side: ME,
  seed: SEED,
  tick,
  delayTicks: DELAY,
});

const frame = (tick: number, commands: readonly Command[] = []): ServerMessage => ({
  type: MessageType.TickFrame,
  tick,
  commands,
});

interface Bench {
  readonly guest: MatchGuest;
  readonly outgoing: ClientMessage[];
  readonly statuses: GuestStatus[];
  /** Подать кадры с текущего подтверждённого тика, count штук. */
  feed(count: number, commands?: Map<number, Command[]>): void;
}

const bench = (startTick = 0): Bench => {
  const outgoing: ClientMessage[] = [];
  const statuses: GuestStatus[] = [];

  const guest = createMatchGuest({
    send: (message) => outgoing.push(message),
    onStatus: (status) => statuses.push(status),
  });

  guest.receive(welcome(startTick));

  return {
    guest,
    outgoing,
    statuses,
    feed(count, commands) {
      for (let index = 0; index < count; index += 1) {
        const tick = guest.confirmed?.tick ?? 0;
        guest.receive(frame(tick, commands?.get(tick) ?? []));
      }
    },
  };
};

describe('сторона участника', () => {
  it('приветствие создаёт мир и назначает сторону', () => {
    const table = bench();

    expect(table.guest.side).toBe(ME);
    expect(table.guest.status).toBe('playing');
    expect(table.guest.confirmed?.tick).toBe(0);
    expect(checksum(table.guest.confirmed!)).toBe(checksum(createWorld(SEED)));
  });

  it('кадры продвигают подтверждённую копию', () => {
    const table = bench();
    table.feed(10);

    expect(table.guest.confirmed?.tick).toBe(10);
  });

  it('предсказание опережает подтверждённое на задержку плюс тик', () => {
    const table = bench();
    table.feed(5);

    expect(table.guest.predicted?.tick).toBe((table.guest.confirmed?.tick ?? 0) + DELAY + 1);
  });

  it('кадр из прошлого игнорируется', () => {
    const table = bench();
    table.feed(5);

    table.guest.receive(frame(2));

    expect(table.guest.confirmed?.tick).toBe(5);
  });

  it('кадры, пришедшие не по порядку, применяются по порядку', () => {
    const table = bench();

    table.guest.receive(frame(2));
    table.guest.receive(frame(1));
    expect(table.guest.confirmed?.tick).toBe(0);

    table.guest.receive(frame(0));

    expect(table.guest.confirmed?.tick).toBe(3);
  });

  it('дыра в кадрах заставляет просить историю', () => {
    const table = bench();
    table.feed(3);
    table.outgoing.length = 0;

    table.guest.receive(frame(10));

    const asked = table.outgoing.filter((message) => message.type === MessageType.HistoryFrom);
    expect(asked).toHaveLength(1);
    if (asked[0]?.type === MessageType.HistoryFrom) expect(asked[0].tick).toBe(3);
  });

  it('своё действие видно в предсказании немедленно', () => {
    const table = bench();
    table.feed(4);

    const before = checksum(table.guest.predicted!);
    table.guest.issue(goEast);

    expect(checksum(table.guest.predicted!)).not.toBe(before);
    expect(table.guest.predicted?.tick).toBe((table.guest.confirmed?.tick ?? 0) + DELAY + 1);
  });

  it('команда уходит на сервер с тиком, на который рассчитано предсказание', () => {
    const table = bench();
    table.feed(4);
    table.outgoing.length = 0;

    table.guest.issue(goEast);

    const sent = table.outgoing.find((message) => message.type === MessageType.Command);
    expect(sent?.type).toBe(MessageType.Command);
    if (sent?.type !== MessageType.Command) return;

    expect(sent.command.tick).toBe((table.guest.confirmed?.tick ?? 0) + DELAY);
  });

  it('предсказание совпадает с подтверждением, когда команда доехала вовремя', () => {
    const table = bench();
    table.feed(4);

    const issued = table.guest.issue(goEast);
    expect(issued).not.toBeNull();
    if (issued === null) return;

    const predictedTick = table.guest.predicted?.tick ?? 0;
    const predictedSum = checksum(table.guest.predicted!);

    // Сервер поставил команду ровно на запрошенный тик и вернул её кадром.
    const schedule = new Map<number, Command[]>([[issued.tick, [withPlayer(issued, ME)]]]);
    while ((table.guest.confirmed?.tick ?? 0) < predictedTick) {
      table.feed(1, schedule);
    }

    expect(table.guest.confirmed?.tick).toBe(predictedTick);
    expect(checksum(table.guest.confirmed!)).toBe(predictedSum);
  });

  it('чужая команда предсказание не переписывает задним числом', () => {
    const table = bench();
    table.feed(4);

    const seen = checksum(table.guest.confirmed!);
    const foe: Command = withPlayer(
      {
        kind: CommandKind.MoveGeneral,
        tick: asTickNumber(table.guest.confirmed?.tick ?? 0),
        direction: 3,
      },
      FOE,
    );

    table.guest.receive(frame(table.guest.confirmed?.tick ?? 0, [foe]));

    // Подтверждённая копия ушла вперёд, а не переписала уже показанное:
    // тик вырос, прошлые тики не пересчитывались.
    expect(table.guest.confirmed?.tick).toBe(5);
    expect(seen).not.toBe(checksum(table.guest.confirmed!));
  });

  it('отвечает на замер канала', () => {
    const table = bench();
    table.outgoing.length = 0;

    table.guest.receive({ type: MessageType.Ping, tick: 12, nonce: 99 });

    expect(table.outgoing).toEqual([{ type: MessageType.Pong, tick: 12, nonce: 99 }]);
  });

  it('новая задержка вступает в силу с объявленного тика', () => {
    const table = bench();
    table.feed(2);

    table.guest.receive({ type: MessageType.InputDelay, delayTicks: 7, fromTick: 6 });
    expect(table.guest.delayTicks).toBe(DELAY);

    table.feed(4);

    expect(table.guest.delayTicks).toBe(7);
  });

  it('матч, идущий с середины, догоняется историей команд', () => {
    // Подготовим «серверную» правду: мир, прокрученный на 40 тиков
    // с одной командой посередине.
    const foe: Command = withPlayer(
      { kind: CommandKind.MoveGeneral, tick: asTickNumber(10), direction: 7 },
      FOE,
    );

    let truth = createWorld(SEED);
    for (let tick = 0; tick < 40; tick += 1) {
      truth = step(truth, tick === 10 ? [foe] : []);
    }

    const table = bench(40);
    expect(table.guest.status).toBe('catching-up');

    const asked = table.outgoing.find((message) => message.type === MessageType.HistoryFrom);
    expect(asked?.type).toBe(MessageType.HistoryFrom);

    table.guest.receive({
      type: MessageType.History,
      fromTick: 0,
      throughTick: 39,
      commands: [foe],
    });

    expect(table.guest.status).toBe('playing');
    expect(table.guest.confirmed?.tick).toBe(40);
    expect(checksum(table.guest.confirmed!)).toBe(checksum(truth));
  });

  it('расхождение вызывает одну пересборку из истории', () => {
    const table = bench();
    table.feed(CHECKSUM_INTERVAL_TICKS);

    table.outgoing.length = 0;
    table.guest.receive({
      type: MessageType.Checksum,
      tick: CHECKSUM_INTERVAL_TICKS,
      value: 0xdeadbeef,
    });

    expect(table.guest.status).toBe('desynced');

    const asked = table.outgoing.filter((message) => message.type === MessageType.HistoryFrom);
    expect(asked).toHaveLength(1);
    if (asked[0]?.type === MessageType.HistoryFrom) expect(asked[0].tick).toBe(0);
    expect(table.guest.confirmed?.tick).toBe(0);
  });

  it('расхождение после пересборки останавливает матч', () => {
    const recovering: boolean[] = [];
    const outgoing: ClientMessage[] = [];

    const guest = createMatchGuest({
      send: (message) => outgoing.push(message),
      onDesync: (_tick, again) => recovering.push(again),
    });

    guest.receive(welcome());
    for (let tick = 0; tick < CHECKSUM_INTERVAL_TICKS; tick += 1) guest.receive(frame(tick));

    guest.receive({ type: MessageType.Checksum, tick: CHECKSUM_INTERVAL_TICKS, value: 1 });
    guest.receive({
      type: MessageType.History,
      fromTick: 0,
      throughTick: CHECKSUM_INTERVAL_TICKS - 1,
      commands: [],
    });
    guest.receive({ type: MessageType.Checksum, tick: CHECKSUM_INTERVAL_TICKS, value: 2 });

    expect(recovering).toEqual([true, false]);
    expect(guest.status).toBe('stopped');
  });

  it('сумма, пришедшая раньше своего тика, сверяется позже', () => {
    const table = bench();

    table.guest.receive({
      type: MessageType.Checksum,
      tick: CHECKSUM_INTERVAL_TICKS,
      value: 0xbadbad,
    });
    expect(table.guest.status).toBe('playing');

    table.feed(CHECKSUM_INTERVAL_TICKS);

    expect(table.guest.status).toBe('desynced');
  });

  it('исход матча приходит от сервера', () => {
    const table = bench();
    table.feed(3);

    table.guest.receive({
      type: MessageType.MatchOver,
      winner: ME,
      reason: OutcomeReason.BaseDestroyed,
    });

    expect(table.guest.status).toBe('finished');
    expect(table.guest.outcome).toEqual({ winner: ME, reason: OutcomeReason.BaseDestroyed });
  });

  it('после исхода команды не отправляются', () => {
    const table = bench();
    table.feed(3);
    table.guest.receive({ type: MessageType.MatchOver, winner: FOE, reason: OutcomeReason.Left });

    table.outgoing.length = 0;
    const issued: UnownedCommand | null = table.guest.issue(goWest);

    expect(issued).toBeNull();
    expect(table.outgoing).toHaveLength(0);
  });
});
