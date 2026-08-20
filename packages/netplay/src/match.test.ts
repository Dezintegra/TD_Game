import { CommandKind, TICKS_PER_SECOND, asPlayerId } from '@td/shared';
import { checksum } from '@td/sim';
import { MessageType } from '@td/protocol';
import type { CommandIntent } from '@td/shared';
import { describe, expect, it } from 'vitest';
import { createTable } from './harness.test-utils.js';

/**
 * Сквозная проверка: ведущий и два участника, матч целиком, без сокетов.
 *
 * Здесь проверяется главное свойство всей затеи — что три независимо
 * считающих мира сходятся тик в тик. Если это перестанет быть правдой,
 * рассыплется всё остальное, поэтому проверка идёт по контрольной сумме,
 * а не по отдельным полям.
 */

const SEED = 20260820;
const P0 = asPlayerId(0);
const P1 = asPlayerId(1);

const move = (direction: number): CommandIntent => ({
  kind: CommandKind.MoveGeneral,
  direction,
});

describe('матч целиком', () => {
  it('три копии мира сходятся по контрольной сумме', () => {
    const table = createTable({ seed: SEED, latencyMs: 20 });

    for (let round = 0; round < 12; round += 1) {
      table.guests[round % 2]?.issue(move(1 + (round % 8)));
      table.run(500);
    }

    table.run(1000);

    const confirmed0 = table.guests[0]?.confirmed;
    const confirmed1 = table.guests[1]?.confirmed;
    expect(confirmed0).toBeDefined();
    expect(confirmed1).toBeDefined();
    if (confirmed0 === undefined || confirmed1 === undefined) return;

    // Участники отстают от ведущего на время полёта кадра, поэтому сверяем
    // не «сейчас», а одинаковые тики: у обоих подтверждено одно и то же.
    expect(confirmed0.tick).toBe(confirmed1.tick);
    expect(checksum(confirmed0)).toBe(checksum(confirmed1));
    expect(confirmed0.tick).toBeLessThanOrEqual(table.host.world.tick);
    expect(table.host.world.tick - confirmed0.tick).toBeLessThanOrEqual(3);
  });

  it('никто не сообщил о расхождении', () => {
    const desyncs: number[] = [];
    const table = createTable({
      seed: SEED,
      latencyMs: 30,
      guestOptions: () => ({ onDesync: (tick) => desyncs.push(tick) }),
    });

    for (let round = 0; round < 10; round += 1) {
      table.guests[0]?.issue(move(2));
      table.guests[1]?.issue(move(6));
      table.run(700);
    }

    expect(desyncs).toEqual([]);
    expect(table.guests[0]?.status).toBe('playing');
    expect(table.guests[1]?.status).toBe('playing');
  });

  it('медленный канал поднимает задержку обоим, но не теряет команд', () => {
    const fast = createTable({ seed: SEED, latencyMs: 5 });
    const slow = createTable({ seed: SEED, latencyMs: 5 });
    slow.setLatency(P1, 90);

    const script = [1, 3, 5, 7, 2, 4];

    for (const table of [fast, slow]) {
      // Приветствие летит по той же сети, что и всё остальное, поэтому
      // до первого прогона участник ещё не знает ни стороны, ни seed
      // и команд не принимает.
      table.run(300);

      for (const direction of script) {
        table.guests[0]?.issue(move(direction));
        table.run(600);
      }
      table.run(1200);
    }

    // Задержку задаёт худший из каналов — и она общая. Плохой канал
    // второго участника замедляет ввод первому, и это осознанная плата
    // за равные условия.
    expect(slow.host.delayTicks).toBeGreaterThan(fast.host.delayTicks);

    // Мир при этом отличается: команды исполнены на других тиках. Что
    // обязано совпадать — так это их количество: задержка сдвигает
    // действие во времени, но не отменяет его.
    expect(slow.host.history).toHaveLength(script.length);
    expect(fast.host.history).toHaveLength(script.length);

    const left = fast.guests[0]?.confirmed;
    const right = slow.guests[0]?.confirmed;
    if (left === undefined || right === undefined) throw new Error('нет подтверждённого мира');

    expect(checksum(left)).not.toBe(checksum(right));
  });

  it('вернувшийся после разрыва догоняет матч и сходится с соперником', () => {
    const table = createTable({ seed: SEED, latencyMs: 15 });

    table.run(2000);
    table.guests[0]?.issue(move(1));
    table.run(1000);

    // Провод выдернут: сообщения не ходят ни туда, ни обратно.
    table.setLinkUp(P1, false);
    table.host.drop(P1);

    table.run(4000);
    table.guests[0]?.issue(move(5));
    table.run(2000);

    // Связь вернулась, участник заново вошёл в матч.
    table.setLinkUp(P1, true);
    table.host.join(P1);
    table.run(2000);

    const stayed = table.guests[0]?.confirmed;
    const returned = table.guests[1]?.confirmed;
    if (stayed === undefined || returned === undefined) throw new Error('нет мира');

    expect(table.guests[1]?.status).toBe('playing');
    expect(returned.tick).toBe(stayed.tick);
    expect(checksum(returned)).toBe(checksum(stayed));
    expect(table.host.outcome).toBeNull();
  });

  it('мир соперника идёт, пока один отключён', () => {
    const table = createTable({ seed: SEED, latencyMs: 10 });
    table.run(1000);

    table.setLinkUp(P1, false);
    table.host.drop(P1);

    const before = table.guests[0]?.confirmed?.tick ?? 0;
    table.run(3000);
    const after = table.guests[0]?.confirmed?.tick ?? 0;

    expect(after - before).toBeGreaterThan(TICKS_PER_SECOND * 2);
  });

  it('участники получают одинаковые кадры', () => {
    const table = createTable({ seed: SEED, latencyMs: 25 });

    table.guests[1]?.issue(move(4));
    table.run(2000);

    const only = (player: typeof P0) =>
      table
        .received(player)
        .filter((message) => message.type === MessageType.TickFrame)
        .map((message) =>
          message.type === MessageType.TickFrame
            ? `${message.tick}:${message.commands.map((command) => `${command.player}/${command.kind}`).join(',')}`
            : '',
        );

    expect(only(P0)).toEqual(only(P1));
  });
});
