import { CommandKind, MS_PER_TICK, asPlayerId, asTickNumber } from '@td/shared';
import { MessageType } from '@td/protocol';
import { checksum } from '@td/sim';
import type { UnownedCommand } from '@td/shared';
import { describe, expect, it } from 'vitest';
import { createMatchHost } from './host.js';
import type { HostMeasure } from './host.js';
import { createClock } from './harness.test-utils.js';

/**
 * Приборы наблюдают и не участвуют.
 *
 * Требование записано в `match-telemetry` и распространяется на всё,
 * что меряется: матч со сбором сведений и без него обязан давать
 * одинаковые контрольные суммы. Иначе измерялся бы уже другой матч,
 * и любой вывод из показаний относился бы не к той игре, в которую
 * играет человек.
 *
 * Проверяется это здесь не рассуждением о том, что обёртка «просто
 * зовёт функцию», а сличением двух матчей — с приборами и без.
 */

const P0 = asPlayerId(0);
const P1 = asPlayerId(1);
const SEED = 4242;

const move = (tick: number, direction: number): UnownedCommand => ({
  kind: CommandKind.MoveGeneral,
  tick: asTickNumber(tick),
  direction,
});

const play = (measure?: HostMeasure): { sum: number; tick: number } => {
  const clock = createClock();
  const host = createMatchHost({
    seed: SEED,
    now: () => clock.now(),
    send: () => undefined,
    ...(measure === undefined ? {} : { measure }),
  });

  host.join(P0);
  host.join(P1);

  // Одинаковая жизнь у обоих матчей: те же команды на тех же тиках.
  for (let round = 0; round < 40; round += 1) {
    host.submit(P0, move(round * 3, round % 8));
    host.submit(P1, move(round * 3 + 1, (round + 4) % 8));

    let left = 100;
    while (left > 0) {
      const slice = Math.min(MS_PER_TICK / 2, left);
      clock.advance(slice);
      left -= slice;
      host.advance();
    }
  }

  return { sum: checksum(host.world), tick: host.world.tick };
};

describe('приборы ведущего', () => {
  it('матч с приборами и без даёт одну и ту же контрольную сумму', () => {
    const counted: number[] = [];
    const withMeasure = play({
      step: (run) => run(),
      advanced: (ticks) => counted.push(ticks),
      debt: () => undefined,
      sent: () => undefined,
      rtt: () => undefined,
    });
    const without = play();

    expect(withMeasure.tick).toBe(without.tick);
    expect(withMeasure.sum).toBe(without.sum);
    // И приборы при этом правда работали, а не молчали: иначе
    // совпадение сумм не доказывало бы ничего.
    expect(counted.length).toBeGreaterThan(0);
    expect(counted.reduce((a, b) => a + b, 0)).toBe(without.tick);
  });

  it('обёртка шага обязана вернуть результат нетронутым', () => {
    // Прибор, потерявший или подменивший возвращённый мир, сломал бы
    // матч молча: тик прошёл бы, а состояние осталось прежним.
    // Проверка на то, что обёртка — именно обёртка.
    const passthrough = play({
      step: (run) => run(),
      advanced: () => undefined,
      debt: () => undefined,
      sent: () => undefined,
      rtt: () => undefined,
    });

    expect(passthrough.tick).toBeGreaterThan(0);
    expect(passthrough.sum).toBe(play().sum);
  });
  it('промежуток между отправками равен тому, что показали часы', () => {
    // Прибор канала, а не счёта: ровный ряд здесь при рваном приходе
    // у игрока означает, что рвано доставляет сеть. Поэтому проверяется
    // не «величина правдоподобна», а «величина равна ходу часов»:
    // прибор, живущий своей жизнью, доказывал бы что угодно.
    //
    // Часы двигаются миллисекундными шажками, а не сразу на тик:
    // при шаге ровно в тик ведущий считает по нескольку тиков за проход
    // и мерить становится нечего.
    const clock = createClock();
    const gaps: number[] = [];
    const host = createMatchHost({
      seed: SEED,
      now: () => clock.now(),
      send: () => undefined,
      measure: {
        step: (run) => run(),
        advanced: () => undefined,
        debt: () => undefined,
        sent: (gapMs) => gaps.push(gapMs),
        rtt: () => undefined,
      },
    });

    host.join(P0);
    host.join(P1);

    for (let ms = 0; ms < MS_PER_TICK * 5; ms += 1) {
      clock.advance(1);
      host.advance();
    }

    // Пять тиков — четыре промежутка: первая отправка промежутка
    // не даёт, сравнивать не с чем.
    expect(gaps.length).toBe(host.world.tick - 1);
    // Каждый промежуток — длительность тика с точностью до шага часов.
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(MS_PER_TICK - 1);
      expect(gap).toBeLessThanOrEqual(MS_PER_TICK + 1);
    }
  });

  it('догон виден нулевыми промежутками', () => {
    // Если сервер простоял и потом посчитал несколько тиков за один
    // проход, кадры уйдут один за другим в ту же миллисекунду. Ряд
    // обязан это показать: пачка на выходе сервера и пачка, собравшаяся
    // в канале, — разные беды с разным лечением, и различать их нужно
    // именно здесь.
    const clock = createClock();
    const gaps: number[] = [];
    const host = createMatchHost({
      seed: SEED,
      now: () => clock.now(),
      send: () => undefined,
      measure: {
        step: (run) => run(),
        advanced: () => undefined,
        debt: () => undefined,
        sent: (gapMs) => gaps.push(gapMs),
        rtt: () => undefined,
      },
    });

    host.join(P0);
    host.join(P1);

    // Одна заминка на четыре тика с хвостиком — и все четыре
    // считаются разом. Хвостик не украшение: длительность тика
    // не выражается двоичной дробью, и ровно четыре тика по часам
    // оказались бы на волосок меньше четырёх тиков по счёту.
    clock.advance(MS_PER_TICK * 4 + 1);
    host.advance();

    expect(host.world.tick).toBe(4);
    expect(gaps).toEqual([0, 0, 0]);
  });
  it('ответ на замер канала попадает в прибор', () => {
    // Время обхода сервер считает и без приборов — по нему назначается
    // задержка ввода, — но живёт оно внутри места и наружу не выходит.
    // Проверяется, что наружу уходит именно измеренное, а не округлённое
    // до тиков: округляет задержка ввода, а прибор обязан отдавать то,
    // что показали часы.
    const clock = createClock();
    const rtts: number[] = [];
    let nonce = 0;
    const host = createMatchHost({
      seed: SEED,
      now: () => clock.now(),
      send: (player, message) => {
        if (player === P0 && message.type === MessageType.Ping) nonce = message.nonce;
      },
      measure: {
        step: (run) => run(),
        advanced: () => undefined,
        debt: () => undefined,
        sent: () => undefined,
        rtt: (ms) => rtts.push(ms),
      },
    });

    host.join(P0);
    host.join(P1);

    // Замер канала сервер затевает раз в секунду, поэтому до него надо
    // дожить: секунда игры — это тридцать тиков. Дальше первого замера
    // не идём — иначе к обходу примешалось бы время, прошедшее после
    // отправки, и проверка мерила бы не то.
    for (let ms = 0; ms < MS_PER_TICK * 40 && nonce === 0; ms += 1) {
      clock.advance(1);
      host.advance();
    }
    expect(nonce).toBeGreaterThan(0);

    clock.advance(40);
    host.observePong(P0, nonce);

    expect(rtts).toEqual([40]);
  });

  it('чужой ответ на замер прибора не трогает', () => {
    // Номер замера сверяется, и это не формальность: ответ с чужим
    // номером означает либо давно устаревший замер, либо подделку.
    // И то и другое, попав в прибор, испортило бы выборку молча.
    const clock = createClock();
    const rtts: number[] = [];
    const host = createMatchHost({
      seed: SEED,
      now: () => clock.now(),
      send: () => undefined,
      measure: {
        step: (run) => run(),
        advanced: () => undefined,
        debt: () => undefined,
        sent: () => undefined,
        rtt: (ms) => rtts.push(ms),
      },
    });

    host.join(P0);
    host.join(P1);
    host.observePong(P0, 999);

    expect(rtts).toEqual([]);
  });
});
