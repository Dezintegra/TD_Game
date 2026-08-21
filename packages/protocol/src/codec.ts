import {
  BUILDABLE_KINDS,
  CommandKind,
  MAP_CELL_COUNT,
  PLAYERS_PER_MATCH,
  UNIT_TYPES,
  UPGRADE_BRANCHES,
  asPlayerId,
  asTickNumber,
  isValidDirection,
  isValidStance,
  withPlayer,
} from '@td/shared';
import type { Command, StructureKind, UnitType, UnownedCommand } from '@td/shared';
import { DecodeError, MessageType, OutcomeReason, PROTOCOL_VERSION, TICKET_BYTES } from './messages.js';
import type { DecodeResult, Message } from './messages.js';

/**
 * Бинарный кодек поверх ArrayBuffer.
 *
 * Почему не JSON. В матче пакеты уходят каждый тик, то есть 30 раз
 * в секунду на игрока. JSON здесь платит дважды: сообщение вида
 * {"type":"tick","tick":1200,"commands":[]} занимает под сорок байт
 * против семи в бинарном виде, и каждый пакет требует разбора строки,
 * что порождает мусор для сборщика и микрофризы ровно там, где нужна
 * плавность.
 *
 * Общее начало у всех кадров (little-endian, как во всех современных
 * процессорах):
 *   байт 0 — версия протокола (uint8)
 *   байт 1 — тип сообщения (uint8)
 *
 * Дальше поля в порядке объявления соответствующего сообщения. Кадр
 * больше не фиксированной длины: список команд в кадре тика и кусок
 * истории по определению переменные.
 *
 * Команда занимает четыре байта тела: вид и три байта аргументов,
 * которых хватает любому виду. Клетка — два байта (карта 48 × 48, то есть
 * 2304 клетки), всё остальное — по одному. Разбирать аргументы по видам
 * пришлось бы всё равно, а единая ширина избавляет от вычисления длины
 * кадра по содержимому.
 */
const HEADER_SIZE = 2;

/** Тик, сторона, вид и аргументы — запись команды в истории. */
const HISTORY_ENTRY_SIZE = 4 + 1 + 1 + 2 + 1;

/** Сторона, вид и аргументы — запись команды в кадре тика. */
const FRAME_ENTRY_SIZE = 1 + 1 + 2 + 1;

/** Победителя нет. Ноль занят стороной, поэтому нужен код вне диапазона. */
const NO_WINNER = 0xff;

const REASONS: readonly OutcomeReason[] = [
  OutcomeReason.BaseDestroyed,
  OutcomeReason.Disconnected,
  OutcomeReason.NoShow,
  OutcomeReason.Left,
];

const HEX = '0123456789abcdef';

const toHex = (bytes: Uint8Array): string => {
  let out = '';
  for (const byte of bytes) {
    out += HEX[(byte >> 4) & 0xf];
    out += HEX[byte & 0xf];
  }
  return out;
};

const fromHex = (text: string, length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16) || 0;
  }
  return bytes;
};

/**
 * Аргументы команды, упакованные в три байта.
 *
 * Первое поле шире второго не по прихоти: клетка не помещается в байт,
 * а всё остальное помещается с запасом.
 */
interface CommandArgs {
  readonly a: number;
  readonly b: number;
}

const packArgs = (command: UnownedCommand | Command): CommandArgs => {
  switch (command.kind) {
    case CommandKind.MoveGeneral:
      return { a: command.direction, b: 0 };
    case CommandKind.Build:
      return { a: command.cell, b: command.structure };
    case CommandKind.TrainUnit:
      return { a: command.unitType, b: 0 };
    case CommandKind.SetTarget:
      return { a: command.cell, b: 0 };
    case CommandKind.BuyUpgrade:
      return { a: command.branch, b: 0 };
    case CommandKind.LaunchNuke:
      return { a: command.cell, b: 0 };
    case CommandKind.Demolish:
      return { a: command.cell, b: 0 };
    case CommandKind.SetStance:
      return { a: command.stance, b: 0 };
  }
};

const isCell = (value: number): boolean => value >= 0 && value < MAP_CELL_COUNT;

/**
 * Разбор команды из трёх байт аргументов.
 *
 * Возвращает `undefined` на всё, чего быть не может: неизвестный вид,
 * клетка за краем карты, ветка прокачки вне таблицы, тип юнита из будущей
 * версии. Данные приходят из недоверенного источника, и «этого не бывает»
 * здесь не аргумент.
 *
 * Заметьте, чего тут нет: проверок правил игры. Хватает ли энергии, стоит
 * ли в клетке чужой генерал, попадает ли клетка в радиус строительства —
 * решает ядро, одинаково для всех, и дублировать его решения в кодеке
 * было бы вторым набором правил.
 */
const unpackCommand = (kind: number, a: number, b: number, tick: number): UnownedCommand | undefined => {
  const at = asTickNumber(tick);

  switch (kind) {
    case CommandKind.MoveGeneral:
      return isValidDirection(a) ? { kind: CommandKind.MoveGeneral, tick: at, direction: a } : undefined;

    case CommandKind.Build: {
      if (!isCell(a)) return undefined;
      if (!BUILDABLE_KINDS.includes(b as StructureKind)) return undefined;
      return { kind: CommandKind.Build, tick: at, cell: a, structure: b as StructureKind };
    }

    case CommandKind.TrainUnit:
      return UNIT_TYPES.includes(a as UnitType)
        ? { kind: CommandKind.TrainUnit, tick: at, unitType: a as UnitType }
        : undefined;

    case CommandKind.SetTarget:
      return isCell(a) ? { kind: CommandKind.SetTarget, tick: at, cell: a } : undefined;

    case CommandKind.BuyUpgrade:
      return a >= 0 && a < UPGRADE_BRANCHES.length
        ? { kind: CommandKind.BuyUpgrade, tick: at, branch: a }
        : undefined;

    case CommandKind.LaunchNuke:
      return isCell(a) ? { kind: CommandKind.LaunchNuke, tick: at, cell: a } : undefined;

    case CommandKind.Demolish:
      return isCell(a) ? { kind: CommandKind.Demolish, tick: at, cell: a } : undefined;

    case CommandKind.SetStance:
      return isValidStance(a) ? { kind: CommandKind.SetStance, tick: at, stance: a } : undefined;

    default:
      return undefined;
  }
};

const sizeOf = (message: Message): number => {
  switch (message.type) {
    case MessageType.Ping:
    case MessageType.Pong:
      return HEADER_SIZE + 8;
    case MessageType.Join:
      return HEADER_SIZE + TICKET_BYTES;
    case MessageType.Command:
      return HEADER_SIZE + 4 + 4;
    case MessageType.HistoryFrom:
      return HEADER_SIZE + 4;
    case MessageType.Welcome:
      return HEADER_SIZE + 1 + 4 + 4 + 1;
    case MessageType.TickFrame:
      return HEADER_SIZE + 4 + 1 + message.commands.length * FRAME_ENTRY_SIZE;
    case MessageType.Checksum:
      return HEADER_SIZE + 4 + 4;
    case MessageType.InputDelay:
      return HEADER_SIZE + 1 + 4;
    case MessageType.History:
      return HEADER_SIZE + 4 + 4 + 2 + message.commands.length * HISTORY_ENTRY_SIZE;
    case MessageType.MatchOver:
      return HEADER_SIZE + 1 + 1;
  }
};

export const encode = (message: Message): ArrayBuffer => {
  const buffer = new ArrayBuffer(sizeOf(message));
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, message.type);

  switch (message.type) {
    case MessageType.Ping:
    case MessageType.Pong:
      view.setUint32(2, message.tick, true);
      view.setUint32(6, message.nonce, true);
      break;

    case MessageType.Join:
      bytes.set(fromHex(message.ticket, TICKET_BYTES), 2);
      break;

    case MessageType.Command: {
      const args = packArgs(message.command);
      view.setUint32(2, message.command.tick, true);
      view.setUint8(6, message.command.kind);
      view.setUint16(7, args.a, true);
      view.setUint8(9, args.b);
      break;
    }

    case MessageType.HistoryFrom:
      view.setUint32(2, message.tick, true);
      break;

    case MessageType.Welcome:
      view.setUint8(2, message.side);
      view.setUint32(3, message.seed, true);
      view.setUint32(7, message.tick, true);
      view.setUint8(11, message.delayTicks);
      break;

    case MessageType.TickFrame: {
      view.setUint32(2, message.tick, true);
      view.setUint8(6, message.commands.length);

      let offset = 7;
      for (const command of message.commands) {
        const args = packArgs(command);
        view.setUint8(offset, command.player);
        view.setUint8(offset + 1, command.kind);
        view.setUint16(offset + 2, args.a, true);
        view.setUint8(offset + 4, args.b);
        offset += FRAME_ENTRY_SIZE;
      }
      break;
    }

    case MessageType.Checksum:
      view.setUint32(2, message.tick, true);
      view.setUint32(6, message.value, true);
      break;

    case MessageType.InputDelay:
      view.setUint8(2, message.delayTicks);
      view.setUint32(3, message.fromTick, true);
      break;

    case MessageType.History: {
      view.setUint32(2, message.fromTick, true);
      view.setUint32(6, message.throughTick, true);
      view.setUint16(10, message.commands.length, true);

      let offset = 12;
      for (const command of message.commands) {
        const args = packArgs(command);
        view.setUint32(offset, command.tick, true);
        view.setUint8(offset + 4, command.player);
        view.setUint8(offset + 5, command.kind);
        view.setUint16(offset + 6, args.a, true);
        view.setUint8(offset + 8, args.b);
        offset += HISTORY_ENTRY_SIZE;
      }
      break;
    }

    case MessageType.MatchOver:
      view.setUint8(2, message.winner ?? NO_WINNER);
      view.setUint8(3, message.reason);
      break;
  }

  return buffer;
};

/** Кадр короче объявленного — обычное дело при обрыве, не авария. */
const tooShort = (): DecodeResult => ({ ok: false, error: DecodeError.TooShort });
const badField = (): DecodeResult => ({ ok: false, error: DecodeError.BadField });

export const decode = (buffer: ArrayBuffer): DecodeResult => {
  if (buffer.byteLength < HEADER_SIZE) return tooShort();

  const view = new DataView(buffer);

  if (view.getUint8(0) !== PROTOCOL_VERSION) {
    return { ok: false, error: DecodeError.VersionMismatch };
  }

  const type = view.getUint8(1);
  const size = buffer.byteLength;

  switch (type) {
    case MessageType.Ping:
    case MessageType.Pong: {
      if (size < HEADER_SIZE + 8) return tooShort();
      return {
        ok: true,
        message: { type, tick: view.getUint32(2, true), nonce: view.getUint32(6, true) },
      };
    }

    case MessageType.Join: {
      if (size < HEADER_SIZE + TICKET_BYTES) return tooShort();
      const ticket = toHex(new Uint8Array(buffer, 2, TICKET_BYTES));
      return { ok: true, message: { type: MessageType.Join, ticket } };
    }

    case MessageType.Command: {
      if (size < HEADER_SIZE + 8) return tooShort();
      const command = unpackCommand(
        view.getUint8(6),
        view.getUint16(7, true),
        view.getUint8(9),
        view.getUint32(2, true),
      );
      if (command === undefined) return badField();
      return { ok: true, message: { type: MessageType.Command, command } };
    }

    case MessageType.HistoryFrom: {
      if (size < HEADER_SIZE + 4) return tooShort();
      return { ok: true, message: { type: MessageType.HistoryFrom, tick: view.getUint32(2, true) } };
    }

    case MessageType.Welcome: {
      if (size < HEADER_SIZE + 10) return tooShort();
      const side = view.getUint8(2);
      if (side >= PLAYERS_PER_MATCH) return badField();
      return {
        ok: true,
        message: {
          type: MessageType.Welcome,
          side,
          seed: view.getUint32(3, true),
          tick: view.getUint32(7, true),
          delayTicks: view.getUint8(11),
        },
      };
    }

    case MessageType.TickFrame: {
      if (size < HEADER_SIZE + 5) return tooShort();

      const tick = view.getUint32(2, true);
      const count = view.getUint8(6);
      if (size !== HEADER_SIZE + 5 + count * FRAME_ENTRY_SIZE) {
        return { ok: false, error: DecodeError.LengthMismatch };
      }

      const commands: Command[] = [];
      let offset = 7;
      for (let index = 0; index < count; index += 1) {
        const player = view.getUint8(offset);
        if (player >= PLAYERS_PER_MATCH) return badField();

        const body = unpackCommand(
          view.getUint8(offset + 1),
          view.getUint16(offset + 2, true),
          view.getUint8(offset + 4),
          tick,
        );
        if (body === undefined) return badField();

        commands.push(withPlayer(body, asPlayerId(player)));
        offset += FRAME_ENTRY_SIZE;
      }

      return { ok: true, message: { type: MessageType.TickFrame, tick, commands } };
    }

    case MessageType.Checksum: {
      if (size < HEADER_SIZE + 8) return tooShort();
      return {
        ok: true,
        message: {
          type: MessageType.Checksum,
          tick: view.getUint32(2, true),
          value: view.getUint32(6, true),
        },
      };
    }

    case MessageType.InputDelay: {
      if (size < HEADER_SIZE + 5) return tooShort();
      return {
        ok: true,
        message: {
          type: MessageType.InputDelay,
          delayTicks: view.getUint8(2),
          fromTick: view.getUint32(3, true),
        },
      };
    }

    case MessageType.History: {
      if (size < HEADER_SIZE + 10) return tooShort();

      const fromTick = view.getUint32(2, true);
      const throughTick = view.getUint32(6, true);
      const count = view.getUint16(10, true);
      if (size !== HEADER_SIZE + 10 + count * HISTORY_ENTRY_SIZE) {
        return { ok: false, error: DecodeError.LengthMismatch };
      }

      const commands: Command[] = [];
      let offset = 12;
      for (let index = 0; index < count; index += 1) {
        const player = view.getUint8(offset + 4);
        if (player >= PLAYERS_PER_MATCH) return badField();

        const body = unpackCommand(
          view.getUint8(offset + 5),
          view.getUint16(offset + 6, true),
          view.getUint8(offset + 8),
          view.getUint32(offset, true),
        );
        if (body === undefined) return badField();

        commands.push(withPlayer(body, asPlayerId(player)));
        offset += HISTORY_ENTRY_SIZE;
      }

      return { ok: true, message: { type: MessageType.History, fromTick, throughTick, commands } };
    }

    case MessageType.MatchOver: {
      if (size < HEADER_SIZE + 2) return tooShort();

      const raw = view.getUint8(2);
      if (raw !== NO_WINNER && raw >= PLAYERS_PER_MATCH) return badField();

      const reason = view.getUint8(3);
      if (!REASONS.includes(reason as OutcomeReason)) return badField();

      return {
        ok: true,
        message: {
          type: MessageType.MatchOver,
          winner: raw === NO_WINNER ? null : raw,
          reason: reason as OutcomeReason,
        },
      };
    }

    default:
      return { ok: false, error: DecodeError.UnknownType };
  }
};
