import {
  DISPLAY_LEAD_TICKS,
  MS_PER_TICK,
  PREDICTION_REPLAY_LIMIT_TICKS,
  asPlayerId,
} from '@td/shared';
import { MessageType } from '@td/protocol';
import type { Command, ServerMessage } from '@td/protocol';
import { describe, expect, it } from 'vitest';
import { createMatchGuest } from './guest.js';
import type { MatchGuest } from './guest.js';

/**
 * Часы показа: мир на экране двигается местным временем, а не приходом
 * кадров.
 *
 * Ради чего это делается, видно из боевых показаний: промежуток между
 * приходами кадров при ожидаемых 33,3 мс имел p95 в 111 мс и p99 в 257,
 * а четверть кадров приходила пачкой встык. Пока показываемый мир
 * двигался приходом кадров, всё это попадало в глаза игрока один
 * к одному: картинка стояла четверть секунды и потом прыгала.
 *
 * Часы здесь поддельные — иначе проверка мерила бы не правило,
 * а расторопность машины, на которой её запустили.
 */

const SEED = 4242;
const ME = asPlayerId(1);
const DELAY = 3;

/** Тик, который показывается сразу после кадра, без всяких часов. */
const floorOf = (confirmedTick: number): number => confirmedTick + DELAY + 1;

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
  /** Показываемый тик. Именно он и есть предмет всех проверок. */
  shown(): number;
  /** Провести местное время, вызывая `advance` как цикл отрисовки. */
  render(ms: number): void;
  /** Прислать очередной кадр команд. */
  deliver(): void;
}

const bench = (options: { readonly clock?: boolean } = {}): Bench => {
  let nowMs = 10_000;

  const guest = createMatchGuest({
    send: () => undefined,
    ...(options.clock === false ? {} : { now: () => nowMs }),
  });

  guest.receive(welcome());

  return {
    guest,
    shown: () => guest.predicted?.tick ?? -1,
    render(ms) {
      // Шажки по одной миллисекунде: настоящий цикл отрисовки спрашивает
      // часы чаще, чем меняется тик, и правило обязано это переживать.
      for (let step = 0; step < Math.round(ms); step += 1) {
        nowMs += 1;
        guest.advance();
      }
    },
    deliver() {
      guest.receive(frame(guest.confirmed?.tick ?? 0));
    },
  };
};

describe('часы показа', () => {
  it('опоздавший кадр не останавливает картинку', () => {
    // Главная проверка изменения. Кадры не приходят вовсе, а мир
    // на экране обязан двигаться.
    const table = bench();
    table.deliver();

    const before = table.shown();
    table.render(MS_PER_TICK * 3);

    expect(table.shown()).toBe(before + 3);
  });

  it('без часов картинка стоит до следующего кадра', () => {
    // Тот же опыт с тем же ожиданием, но участнику часов не дали.
    // Прежнее поведение обязано сохраниться до последнего шага:
    // на нём стоят компьютер и все существующие проверки.
    const table = bench({ clock: false });
    table.deliver();

    const before = table.shown();
    table.render(MS_PER_TICK * 3);

    expect(table.shown()).toBe(before);
  });

  it('пачка кадров после заминки не прокручивает мир рывком', () => {
    // Вторая половина беды. Пачка встык не берётся из ниоткуда: это
    // кадры, опоздавшие на предыдущую заминку, поэтому и проверять их
    // надо вместе с ней. Показ, висящий на приходе кадров, проскакивал
    // здесь четыре тика за один кадр отрисовки.
    const table = bench();
    table.deliver();

    // Заминка: пять тиков местного времени без единого кадра. Картинка
    // идёт вперёд догадкой — это проверено выше.
    table.render(MS_PER_TICK * 5);
    const before = table.shown();

    // И вот всё опоздавшее приезжает разом.
    for (let index = 0; index < 5; index += 1) table.deliver();

    // Часы за это время не сдвинулись, значит и показ не вправе:
    // подтверждённая копия всего лишь догнала то, что уже показано.
    expect(table.shown()).toBe(before);
  });

  it('показ не опускается ниже тика собственных команд', () => {
    // Пол. Ниже него собственная команда не попала бы в картинку,
    // и нажатие перестало бы давать отклик в том же кадре.
    const table = bench();

    for (let index = 0; index < 10; index += 1) {
      table.deliver();
      expect(table.shown()).toBeGreaterThanOrEqual(floorOf(table.guest.confirmed?.tick ?? 0));
    }
  });

  it('пробив пол, часы встают на тик выше него', () => {
    // Запас существует затем, чтобы пол не пробивался на каждом втором
    // кадре: пол — лестница, которую строят приходы кадров, часы —
    // прямая, и без запаса прямая оказывалась бы под ступенькой
    // примерно в половине случаев. Каждое такое пробитие — рывок
    // на два тика за один кадр отрисовки.
    const table = bench();

    // Два кадра подряд без хода часов: первый пол только догоняет
    // часы, второй пробивает.
    table.deliver();
    const settled = table.shown();
    table.deliver();

    expect(settled).toBe(floorOf(1));
    expect(table.shown()).toBe(floorOf(2) + DISPLAY_LEAD_TICKS);
  });

  it('показ не поднимается выше предохранителя', () => {
    // Потолок. На длинной заминке картинка обязана честно остановиться,
    // а не уехать в выдуманное будущее: за потолком начинается
    // многосекундный пересчёт внутри одного кадра.
    const table = bench();
    table.deliver();

    const confirmedTick = table.guest.confirmed?.tick ?? 0;
    table.render(MS_PER_TICK * 100);

    expect(table.shown()).toBe(confirmedTick + PREDICTION_REPLAY_LIMIT_TICKS);
  });

  it('показ не идёт назад', () => {
    // Остановку глаз принимает за задержку, а скачок назад — за поломку.
    // Поэтому назад — никогда, ни при каком сочетании кадров и часов.
    const table = bench();
    const seen: number[] = [];

    for (let round = 0; round < 20; round += 1) {
      // Нарочно рваная жизнь: то кадр без времени, то время без кадра.
      table.render(round % 3 === 0 ? MS_PER_TICK * 2 : 1);
      if (round % 2 === 0) table.deliver();
      seen.push(table.shown());
    }

    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index]).toBeGreaterThanOrEqual(seen[index - 1] ?? 0);
    }
  });

  it('во время догона часы стоят', () => {
    // Подтверждённая копия в догоне перестраивается, и бежать впереди
    // неё некуда: показ обязан дождаться.
    const table = bench();
    table.guest.receive(welcome(50));
    expect(table.guest.status).toBe('catching-up');

    const before = table.shown();
    table.render(MS_PER_TICK * 5);

    expect(table.shown()).toBe(before);
  });
});
