import { CommandKind, asPlayerId } from '@td/shared';
import { checksum } from '@td/sim';
import { MessageType } from '@td/protocol';
import type { Command, CommandIntent } from '@td/shared';
import type { ClientMessage, ServerMessage } from '@td/protocol';
import { describe, expect, it } from 'vitest';
import { createMatchGuest } from './guest.js';
import type { MatchGuest } from './guest.js';

/**
 * Участник, который мир не показывает, предсказание не считает.
 *
 * Проверяется здесь ровно две вещи, и вторая важнее первой. Первая —
 * что шагов симуляции сверх подтверждённого тика правда не делается.
 * Вторая — что от этого НИЧЕГО не меняется: те же команды, те же
 * контрольные суммы. Без второй первая была бы оптимизацией вслепую.
 *
 * Отсутствие шагов доказывается тождеством ссылок, а не сравнением
 * номеров тиков. `step` — чистая функция, она возвращает новый объект
 * состояния; значит, если предсказанное состояние — тот же объект,
 * что подтверждённое, ни одного шага не было. Сравнение номеров такой
 * силы не имеет: совпасть они могут и случайно.
 */

const SEED = 4242;
const ME = asPlayerId(1);
const DELAY = 3;

const goEast: CommandIntent = { kind: CommandKind.MoveGeneral, direction: 1 };
const train: CommandIntent = { kind: CommandKind.TrainUnit, unitType: 0 };

const welcome = (): ServerMessage => ({
  type: MessageType.Welcome,
  side: ME,
  seed: SEED,
  tick: 0,
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
  feed(count: number): void;
}

const bench = (predict?: boolean): Bench => {
  const outgoing: ClientMessage[] = [];

  const guest = createMatchGuest({
    send: (message) => outgoing.push(message),
    ...(predict === undefined ? {} : { predict }),
  });

  guest.receive(welcome());

  return {
    guest,
    outgoing,
    feed(count) {
      for (let index = 0; index < count; index += 1) {
        guest.receive(frame(guest.confirmed?.tick ?? 0));
      }
    },
  };
};

describe('предсказание считает только тот, кто его показывает', () => {
  it('без предсказания шагов сверх подтверждённого тика нет', () => {
    const table = bench(false);
    table.feed(10);

    // Тождество ссылок, а не равенство номеров: `step` вернул бы
    // новый объект, значит его не звали ни разу.
    expect(table.guest.predicted).toBe(table.guest.confirmed);
    expect(table.guest.predicted?.tick).toBe(10);
  });

  it('с предсказанием горизонт по-прежнему опережает подтверждённое', () => {
    const table = bench(true);
    table.feed(10);

    expect(table.guest.predicted?.tick).toBe(10 + DELAY + 1);
  });

  it('умолчание — предсказывать', () => {
    // Не украшательство: перевёрнутое однажды умолчание отняло бы
    // отзывчивость у клиента человека, и заметили бы это не сразу.
    const table = bench();
    table.feed(10);

    expect(table.guest.predicted?.tick).toBe(10 + DELAY + 1);
  });

  it('своя команда не пересобирает предсказание, но уходит и ждёт', () => {
    const table = bench(false);
    table.feed(5);

    const before = table.guest.confirmed;
    const command = table.guest.issue(goEast);

    expect(command).not.toBeNull();
    // Предсказание не тронуто: тот же объект, что и до команды.
    expect(table.guest.predicted).toBe(before);
    // А отправка и учёт неподтверждённых работают как прежде.
    expect(table.guest.pendingCount).toBe(1);
    expect(table.outgoing.at(-1)).toMatchObject({ type: MessageType.Command });
  });

  it('выключенное предсказание не меняет ни команд, ни мира', () => {
    const predicting = bench(true);
    const blind = bench(false);

    // Одинаковая жизнь у обоих: те же кадры, те же действия
    // на тех же тиках.
    for (let round = 0; round < 12; round += 1) {
      predicting.feed(3);
      blind.feed(3);

      const intent = round % 2 === 0 ? goEast : train;
      predicting.guest.issue(intent);
      blind.guest.issue(intent);
    }

    expect(blind.guest.confirmed?.tick).toBe(predicting.guest.confirmed?.tick);
    expect(checksum(blind.guest.confirmed!)).toBe(checksum(predicting.guest.confirmed!));
    expect(blind.outgoing).toStrictEqual(predicting.outgoing);
  });
});
