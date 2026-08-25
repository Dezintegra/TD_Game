import {
  COMMAND_CARRY_LIMIT_TICKS,
  CommandKind,
  MS_PER_TICK,
  UnitType,
  asPlayerId,
} from '@td/shared';
import { MessageType } from '@td/protocol';
import type { Command, CommandIntent } from '@td/shared';
import type { ClientMessage, ServerMessage } from '@td/protocol';
import { describe, expect, it } from 'vitest';
import { createMatchGuest } from './guest.js';
import { createTable } from './harness.test-utils.js';

/**
 * Перенос собственной команды вместо её забвения.
 *
 * Клиент назначает команду на такт «подтверждённый плюс задержка ввода»
 * и сразу показывает её действие. Сервер, получив команду после того,
 * как этот такт сыгран, двигает её вперёд — команда не теряется. Но
 * кадр назначенного такта приходит без неё, и прежний код выбрасывал
 * из предсказания всё, что на этом такте лежало. Действие пропадало
 * с экрана, чтобы через долю секунды вернуться.
 *
 * Здесь проверяется, что не пропадает.
 */

const SEED = 4242;
const ME = asPlayerId(0);

const train = (unitType: UnitType = UnitType.Assault): CommandIntent => ({
  kind: CommandKind.TrainUnit,
  unitType,
});

/** Сколько юнитов нашей стороны в мире. */
const mine = (world: { readonly units: readonly { readonly owner: number }[] }): number =>
  world.units.filter((unit) => unit.owner === ME).length;

/**
 * Прокрутить матч, снимая число своих юнитов в предсказании на каждом
 * такте. Ряд и есть то, что видит игрок: провал в нём — мигание.
 */
const trailOf = (table: ReturnType<typeof createTable>, ticks: number): number[] => {
  const trail: number[] = [];

  for (let index = 0; index < ticks; index += 1) {
    table.run(MS_PER_TICK);
    const predicted = table.guests[ME]?.predicted;
    if (predicted != null) trail.push(mine(predicted));
  }

  return trail;
};

describe('перенос своей команды', () => {
  it('опоздавшая команда не проседает в предсказании', () => {
    // Канал сначала быстрый — на нём сервер назначает маленькую задержку
    // ввода, — а потом резко проседает. Задержка подстроится не сразу,
    // и команда, отданная в эту яму, опоздает к своему такту.
    const table = createTable({ seed: SEED, latencyMs: 5 });
    table.run(1000);

    table.setLatency(ME, 400);
    table.guests[ME]?.issue(train());

    const trail = trailOf(table, 90);

    // Ни одного нуля: заказанный юнит виден непрерывно с самого нажатия.
    expect(trail).not.toHaveLength(0);
    expect(trail.every((count) => count === 1)).toBe(true);
  });

  it('перенесённая команда не исполняется дважды', () => {
    // Самая опасная ошибка переноса — учесть команду и в предсказании,
    // и ещё раз кадром. Проверяется исходом, а не рассуждением: юнит
    // должен остаться один, а очередь ожидающих опустеть.
    const table = createTable({ seed: SEED, latencyMs: 5 });
    table.run(1000);

    table.setLatency(ME, 400);
    table.guests[ME]?.issue(train());
    table.run(3000);

    const predicted = table.guests[ME]?.predicted;

    expect(predicted == null ? -1 : mine(predicted)).toBe(1);
    expect(mine(table.host.world)).toBe(1);
    expect(table.guests[ME]?.pendingCount).toBe(0);
  });

  it('пачка не худеет на половину', () => {
    // Пачка — это десять отдельных команд на одном такте. Половина
    // доезжает вовремя, половина опаздывает: ровно так она и разъезжается
    // в бою, когда цикл сервера успевает провернуть такт между приходом
    // пятого и шестого сообщения. Задержка меняется между заказами,
    // а часы при этом не идут — значит такт у всех десяти один.
    const table = createTable({ seed: SEED, latencyMs: 5 });
    table.run(1000);

    for (let order = 0; order < 5; order += 1) table.guests[ME]?.issue(train());
    table.setLatency(ME, 400);
    for (let order = 0; order < 5; order += 1) table.guests[ME]?.issue(train());

    const trail = trailOf(table, 90);

    expect(trail.every((count) => count === 10)).toBe(true);
    expect(mine(table.host.world)).toBe(10);
    expect(table.guests[ME]?.pendingCount).toBe(0);
  });

  it('отвергнутая ядром команда снимается с очереди, а не переносится', () => {
    // Кадр перечисляет команды, исполнявшиеся на такте, независимо
    // от того, приняло их ядро или нет. Значит отказ виден, и нести
    // такую команду дальше нельзя — иначе она висела бы в очереди
    // до истечения срока.
    //
    // Чем именно вызван отказ, неважно: проверяется учёт, а не правило
    // ядра. Направление вне восьми румбов отвергается заведомо.
    const table = createTable({ seed: SEED, latencyMs: 5 });
    table.run(1000);

    table.setLatency(ME, 400);
    table.guests[ME]?.issue({ kind: CommandKind.MoveGeneral, direction: 99 });

    // Ждём меньше срока переноса намеренно: иначе ноль в очереди
    // означал бы «погашена сроком», и проверка ничего бы не доказала.
    // Обхода канала (800 мс) на возврат кадром хватает с запасом.
    table.run(MS_PER_TICK * (COMMAND_CARRY_LIMIT_TICKS - 20));

    expect(table.guests[ME]?.pendingCount).toBe(0);
  });
});

describe('срок переноса', () => {
  /**
   * Участник, чьи команды не доходят никуда: `send` складывает их
   * в список и больше ничего не делает. Такого пути на сервере
   * не осталось ни одного — оттого и стенд подставной, а не матч.
   */
  const bench = (delayTicks = 3) => {
    const outgoing: ClientMessage[] = [];
    const guest = createMatchGuest({ send: (message) => outgoing.push(message) });

    guest.receive({
      type: MessageType.Welcome,
      side: ME,
      seed: SEED,
      tick: 0,
      delayTicks,
    } satisfies ServerMessage);

    return {
      guest,
      outgoing,
      /** Подать пустые кадры с текущего подтверждённого такта. */
      feed(count: number): void {
        for (let index = 0; index < count; index += 1) {
          const tick = guest.confirmed?.tick ?? 0;
          guest.receive({
            type: MessageType.TickFrame,
            tick,
            commands: [] as readonly Command[],
          } satisfies ServerMessage);
        }
      },
    };
  };

  it('команда, не вернувшаяся кадром, несётся, пока не истечёт срок', () => {
    const table = bench();
    table.feed(10);

    table.guest.issue(train());
    expect(table.guest.pendingCount).toBe(1);

    // Пока срок не вышел, команда живёт в предсказании: клиент считает
    // её летящей, а не пропавшей.
    table.feed(COMMAND_CARRY_LIMIT_TICKS - 5);
    expect(table.guest.pendingCount).toBe(1);

    // Срок вышел. Дальше нести — врать дольше, чем стоит любая просадка.
    table.feed(20);
    expect(table.guest.pendingCount).toBe(0);
  });
});
