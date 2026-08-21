import {
  CommandKind,
  MAP_CELL_COUNT,
  StructureKind,
  UPGRADE_BRANCHES,
  UnitType,
  asPlayerId,
  asTickNumber,
} from '@td/shared';
import type { Command } from '@td/shared';
import { describe, expect, it } from 'vitest';
import { decode, encode } from './codec.js';
import {
  DecodeError,
  MessageType,
  OutcomeReason,
  PROTOCOL_VERSION,
  TICKET_CHARS,
} from './messages.js';
import type { Message } from './messages.js';

const TICKET = 'a'.repeat(TICKET_CHARS);

const move = (player: number, tick = 0, direction = 1): Command => ({
  kind: CommandKind.MoveGeneral,
  player: asPlayerId(player),
  tick: asTickNumber(tick),
  direction,
});

const build = (player: number, tick: number, cell: number, structure: StructureKind): Command => ({
  kind: CommandKind.Build,
  player: asPlayerId(player),
  tick: asTickNumber(tick),
  cell,
  structure,
});

describe('бинарный кодек', () => {
  it('round-trip: раскодированное сообщение равно исходному', () => {
    const messages: Message[] = [
      { type: MessageType.Ping, tick: 0, nonce: 0 },
      { type: MessageType.Pong, tick: 1200, nonce: 7 },
      { type: MessageType.Ping, tick: 4294967295, nonce: 4294967295 },
      { type: MessageType.Join, ticket: TICKET },
      {
        type: MessageType.Command,
        command: { kind: CommandKind.MoveGeneral, tick: asTickNumber(42), direction: 8 },
      },
      {
        type: MessageType.Command,
        command: {
          kind: CommandKind.Build,
          tick: asTickNumber(99),
          cell: MAP_CELL_COUNT - 1,
          structure: StructureKind.TowerSniper,
        },
      },
      {
        type: MessageType.Command,
        command: { kind: CommandKind.TrainUnit, tick: asTickNumber(7), unitType: UnitType.Grenadier },
      },
      { type: MessageType.Command, command: { kind: CommandKind.SetTarget, tick: asTickNumber(7), cell: 0 } },
      {
        type: MessageType.Command,
        command: {
          kind: CommandKind.BuyUpgrade,
          tick: asTickNumber(7),
          branch: UPGRADE_BRANCHES.length - 1,
        },
      },
      { type: MessageType.Command, command: { kind: CommandKind.LaunchNuke, tick: asTickNumber(7), cell: 5 } },
      {
        type: MessageType.Command,
        command: { kind: CommandKind.Demolish, tick: asTickNumber(7), cell: MAP_CELL_COUNT - 1 },
      },
      { type: MessageType.HistoryFrom, tick: 900 },
      { type: MessageType.Welcome, side: 1, seed: 123456789, tick: 0, delayTicks: 3 },
      { type: MessageType.TickFrame, tick: 5, commands: [] },
      {
        type: MessageType.TickFrame,
        tick: 5,
        commands: [move(0, 5), build(1, 5, 100, StructureKind.Wall)],
      },
      { type: MessageType.Checksum, tick: 30, value: 4294967295 },
      { type: MessageType.InputDelay, delayTicks: 9, fromTick: 300 },
      { type: MessageType.History, fromTick: 0, throughTick: 10, commands: [] },
      {
        type: MessageType.History,
        fromTick: 0,
        throughTick: 10,
        commands: [move(0, 2), move(1, 9)],
      },
      { type: MessageType.MatchOver, winner: 1, reason: OutcomeReason.BaseDestroyed },
      { type: MessageType.MatchOver, winner: null, reason: OutcomeReason.Disconnected },
    ];

    for (const message of messages) {
      const result = decode(encode(message));
      expect(result.ok, `не разобралось: тип ${message.type}`).toBe(true);
      if (result.ok) expect(result.message).toEqual(message);
    }
  });

  it('покрывает все объявленные типы сообщений', () => {
    // Тест-сторож: новый тип, забытый в round-trip выше, обрушит эту
    // проверку, а не тихо поедет в бой неопробованным.
    const covered = new Set([
      MessageType.Ping,
      MessageType.Pong,
      MessageType.Join,
      MessageType.Command,
      MessageType.HistoryFrom,
      MessageType.Welcome,
      MessageType.TickFrame,
      MessageType.Checksum,
      MessageType.InputDelay,
      MessageType.History,
      MessageType.MatchOver,
    ]);

    expect(covered.size).toBe(Object.keys(MessageType).length);
  });

  it('пустой кадр тика занимает семь байт', () => {
    expect(encode({ type: MessageType.TickFrame, tick: 1, commands: [] }).byteLength).toBe(7);
  });

  it('команда в кадре тика добавляет пять байт', () => {
    const empty = encode({ type: MessageType.TickFrame, tick: 1, commands: [] }).byteLength;
    const one = encode({ type: MessageType.TickFrame, tick: 1, commands: [move(0)] }).byteLength;

    expect(one - empty).toBe(5);
  });

  it('вмещает кадр с максимальным числом команд', () => {
    const many = Array.from({ length: 255 }, (_, index) => move(index % 2, 3));
    const result = decode(encode({ type: MessageType.TickFrame, tick: 3, commands: many }));

    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === MessageType.TickFrame) {
      expect(result.message.commands).toHaveLength(255);
    }
  });

  it('отклоняет слишком короткий кадр', () => {
    const buffer = encode({ type: MessageType.Ping, tick: 1, nonce: 1 });
    expect(decode(buffer.slice(0, 6))).toEqual({ ok: false, error: DecodeError.TooShort });
  });

  it('отклоняет пустой кадр', () => {
    expect(decode(new ArrayBuffer(1))).toEqual({ ok: false, error: DecodeError.TooShort });
  });

  it('отклоняет кадр с чужой версией протокола', () => {
    const buffer = encode({ type: MessageType.Ping, tick: 1, nonce: 1 });
    new DataView(buffer).setUint8(0, PROTOCOL_VERSION + 1);

    expect(decode(buffer)).toEqual({ ok: false, error: DecodeError.VersionMismatch });
  });

  it('отклоняет неизвестный тип сообщения', () => {
    const buffer = encode({ type: MessageType.Ping, tick: 1, nonce: 1 });
    new DataView(buffer).setUint8(1, 99);

    expect(decode(buffer)).toEqual({ ok: false, error: DecodeError.UnknownType });
  });

  it('ловит несоответствие длины числу записей', () => {
    const buffer = encode({ type: MessageType.TickFrame, tick: 3, commands: [move(0, 3)] });
    new DataView(buffer).setUint8(6, 5);

    expect(decode(buffer)).toEqual({ ok: false, error: DecodeError.LengthMismatch });
  });

  it('ловит лишние байты в хвосте кадра тика', () => {
    const short = encode({ type: MessageType.TickFrame, tick: 3, commands: [] });
    const padded = new Uint8Array(short.byteLength + 4);
    padded.set(new Uint8Array(short));

    expect(decode(padded.buffer)).toEqual({ ok: false, error: DecodeError.LengthMismatch });
  });

  it('отклоняет неизвестный вид команды', () => {
    const buffer = encode({
      type: MessageType.Command,
      command: { kind: CommandKind.SetTarget, tick: asTickNumber(1), cell: 1 },
    });
    new DataView(buffer).setUint8(6, 255);

    expect(decode(buffer)).toEqual({ ok: false, error: DecodeError.BadField });
  });

  it('отклоняет клетку за краем карты', () => {
    const buffer = encode({
      type: MessageType.Command,
      command: { kind: CommandKind.SetTarget, tick: asTickNumber(1), cell: 1 },
    });
    new DataView(buffer).setUint16(7, MAP_CELL_COUNT, true);

    expect(decode(buffer)).toEqual({ ok: false, error: DecodeError.BadField });
  });

  it('отклоняет постройку, которую строить нельзя', () => {
    const buffer = encode({
      type: MessageType.Command,
      command: { kind: CommandKind.Build, tick: asTickNumber(1), cell: 1, structure: StructureKind.Wall },
    });
    new DataView(buffer).setUint8(9, StructureKind.Base);

    expect(decode(buffer)).toEqual({ ok: false, error: DecodeError.BadField });
  });

  it('отклоняет ветку прокачки вне таблицы', () => {
    const buffer = encode({
      type: MessageType.Command,
      command: { kind: CommandKind.BuyUpgrade, tick: asTickNumber(1), branch: 0 },
    });
    new DataView(buffer).setUint16(7, UPGRADE_BRANCHES.length, true);

    expect(decode(buffer)).toEqual({ ok: false, error: DecodeError.BadField });
  });

  it('отклоняет направление вне диапазона', () => {
    const buffer = encode({
      type: MessageType.Command,
      command: { kind: CommandKind.MoveGeneral, tick: asTickNumber(1), direction: 1 },
    });
    new DataView(buffer).setUint16(7, 9, true);

    expect(decode(buffer)).toEqual({ ok: false, error: DecodeError.BadField });
  });

  it('отклоняет несуществующую сторону в кадре', () => {
    const buffer = encode({ type: MessageType.TickFrame, tick: 3, commands: [move(0, 3)] });
    new DataView(buffer).setUint8(7, 4);

    expect(decode(buffer)).toEqual({ ok: false, error: DecodeError.BadField });
  });

  it('отклоняет неизвестную причину исхода', () => {
    const buffer = encode({ type: MessageType.MatchOver, winner: 0, reason: OutcomeReason.Left });
    new DataView(buffer).setUint8(3, 77);

    expect(decode(buffer)).toEqual({ ok: false, error: DecodeError.BadField });
  });

  it('не бросает исключение на мусорных данных', () => {
    for (let type = 0; type < 32; type += 1) {
      for (const length of [2, 3, 7, 10, 18, 64]) {
        const bytes = new Uint8Array(length).fill(0xff);
        bytes[0] = PROTOCOL_VERSION;
        bytes[1] = type;

        expect(() => decode(bytes.buffer)).not.toThrow();
      }
    }
  });
});
