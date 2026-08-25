import { CommandKind, asPlayerId } from '@td/shared';
import { checksum } from '@td/sim';
import type { CommandIntent } from '@td/shared';
import { describe, expect, it } from 'vitest';
import { createTable } from './harness.test-utils.js';

/**
 * Сдвиг собственной команды — прямая причина скачка картинки.
 *
 * Клиент назначает команду на такт «подтверждённый плюс задержка ввода»
 * и сразу показывает её действие: иначе нажатие не давало бы отклика
 * в том же кадре. Сервер, получив команду после того, как этот такт уже
 * сыгран, двигает её вперёд — команда не теряется, и это правильно.
 * Но показанное к этому моменту уже разошлось с тем, что случится,
 * и вернувшийся кадр отбрасывает генерала назад.
 *
 * Здесь проверяется, что эта разница видна числом.
 */

const SEED = 4242;
const ME = asPlayerId(0);

const move = (direction: number): CommandIntent => ({
  kind: CommandKind.MoveGeneral,
  direction,
});

/** Стол, где сдвиги своих команд у первого участника записываются. */
const tableWithShifts = (latencyMs: number) => {
  const shifts: number[] = [];
  const table = createTable({
    seed: SEED,
    latencyMs,
    guestOptions: (player) =>
      player === ME ? { onCommandShift: (ticks) => shifts.push(ticks) } : {},
  });

  return { table, shifts };
};

describe('сдвиг своей команды', () => {
  it('вовремя дошедшая команда сдвига не даёт', () => {
    // Пять миллисекунд в одну сторону — это заведомо меньше такта,
    // и сервер получает команду задолго до назначенного ей такта.
    const { table, shifts } = tableWithShifts(5);
    table.run(500);

    table.guests[ME]?.issue(move(1));
    table.run(600);

    expect(shifts).toEqual([0]);
  });

  it('опоздавшая команда даёт сдвиг в тактах', () => {
    // Канал сначала быстрый — на нём сервер назначает маленькую задержку
    // ввода, — а потом резко проседает. Задержка подстроится не сразу,
    // и команда, отданная в эту яму, опоздает к своему такту.
    const { table, shifts } = tableWithShifts(5);
    table.run(500);

    table.setLatency(ME, 400);
    table.guests[ME]?.issue(move(3));
    table.run(2000);

    expect(shifts.length).toBe(1);
    expect(shifts[0]).toBeGreaterThan(0);
  });

  it('две одинаковые команды подряд не путаются местами', () => {
    // Сопоставление идёт по порядку, а не по содержимому: две одинаковые
    // команды по полям неразличимы. Проверяется, что обе учтены,
    // а не одна дважды и не одна из двух.
    const { table, shifts } = tableWithShifts(5);
    table.run(500);

    table.guests[ME]?.issue(move(4));
    table.guests[ME]?.issue(move(4));
    table.run(800);

    expect(shifts.length).toBe(2);
  });

  it('команда, вернувшаяся историей, не сбивает счёт следующим', () => {
    // Подтверждённый мир двигают два пути: обычный кадр и прокрутка
    // по истории после догона. Очередь отданных тактов снимается по одной
    // записи на вернувшуюся команду, поэтому путь, забывший её снять,
    // не теряет одно наблюдение — он сдвигает соответствие навсегда:
    // запись достаётся следующей своей команде, и прибор меряет разницу
    // между двумя нажатиями игрока вместо сдвига сервера.
    const { table, shifts } = tableWithShifts(15);
    table.run(500);

    const guest = table.guests[ME];
    if (guest === undefined) throw new Error('нет участника');

    // Обратный путь обрывается сразу после отправки: команда до сервера
    // доезжает и исполняется, а кадр с нею участник получит уже историей.
    const issued = [guest.issue(move(1))];
    table.setLinkUp(ME, false);
    table.run(1500);

    table.setLinkUp(ME, true);
    table.run(1500);
    expect(guest.status).toBe('playing');

    // Следующие две команды идут по целому каналу и возвращаются кадрами.
    issued.push(guest.issue(move(5)));
    table.run(600);
    issued.push(guest.issue(move(7)));
    table.run(600);

    // Истина — журнал ведущего: там у команды стоит тот такт, на котором
    // её исполнили. Сверяемся с ним, а не с ожидаемыми числами: так тест
    // не придётся переписывать, если стенд начнёт двигать команды иначе.
    const executed = table.host.history.filter((command) => command.player === ME);
    const expectedShifts = executed.map((command, index) => {
      const assigned = issued[index];
      if (assigned === undefined || assigned === null) throw new Error('команда не отдана');
      return command.tick - assigned.tick;
    });

    expect(executed).toHaveLength(issued.length);
    expect(shifts).toEqual(expectedShifts);
  });

  it('участник со счётом сдвигов играет тот же матч', () => {
    // Приборы наблюдают и не участвуют. Проверяется сличением двух
    // одинаковых матчей, а не рассуждением о том, что обработчик
    // «просто складывает числа».
    const play = (counting: boolean): number => {
      const table = createTable({
        seed: SEED,
        latencyMs: 20,
        guestOptions: () => (counting ? { onCommandShift: () => undefined } : {}),
      });

      for (let round = 0; round < 12; round += 1) {
        table.guests[round % 2]?.issue(move(1 + (round % 8)));
        table.run(400);
      }
      table.run(800);

      return checksum(table.host.world);
    };

    expect(play(true)).toBe(play(false));
  });
});
