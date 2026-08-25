import {
  COMMAND_CARRY_LIMIT_TICKS,
  CommandKind,
  FRAME_WORK_BUDGET_MS,
  asPlayerId,
  withPlayer,
} from '@td/shared';
import { checksum, createWorld, step } from '@td/sim';
import { MessageType } from '@td/protocol';
import type { Command, CommandIntent } from '@td/shared';
import type { ClientMessage, ServerMessage } from '@td/protocol';
import { describe, expect, it } from 'vitest';
import { createMatchGuest } from './guest.js';
import type { MatchGuest } from './guest.js';

/**
 * Догон по истории идёт порциями, а не одним куском.
 *
 * Часы здесь дорожают на каждый вопрос: один вопрос — одна миллисекунда.
 * Благодаря этому «бюджет в миллисекундах» превращается в «столько-то
 * тиков за порцию», и проверять можно счётом, а не секундомером.
 * Настоящее время в проверке было бы худшим из миров: на занятой машине
 * порция вышла бы короче, на быстрой длиннее, и падало бы это через раз.
 */

const SEED = 4242;
const ME = asPlayerId(1);
const DELAY = 3;

const goEast: CommandIntent = { kind: CommandKind.MoveGeneral, direction: 1 };

/** Часы, дорожающие на каждый вопрос ровно на миллисекунду. */
const tickingClock = (): (() => number) => {
  let ms = 1_000;
  return () => {
    const value = ms;
    ms += 1;
    return value;
  };
};

const welcome = (tick: number): ServerMessage => ({
  type: MessageType.Welcome,
  side: ME,
  seed: SEED,
  tick,
  delayTicks: DELAY,
});

const history = (throughTick: number, commands: readonly Command[] = []): ServerMessage => ({
  type: MessageType.History,
  fromTick: 0,
  throughTick,
  commands,
});

const frame = (tick: number): ServerMessage => ({
  type: MessageType.TickFrame,
  tick,
  commands: [],
});

interface Bench {
  readonly guest: MatchGuest;
  readonly outgoing: ClientMessage[];
  /** Сколько тиков проиграно с прошлого замера. */
  portion(): number;
}

const bench = (options: { readonly clock: boolean }): Bench => {
  const outgoing: ClientMessage[] = [];
  let played = 0;

  const guest = createMatchGuest({
    send: (message) => outgoing.push(message),
    onFrame: () => {
      played += 1;
    },
    ...(options.clock ? { now: tickingClock() } : {}),
  });

  return {
    guest,
    outgoing,
    portion() {
      const value = played;
      played = 0;
      return value;
    },
  };
};

describe('догон по истории', () => {
  it('идёт порциями, и ни одна не длиннее бюджета', () => {
    const TICKS = 600;
    const BUDGET = 5;

    const table = bench({ clock: true });
    table.guest.receive(welcome(TICKS));
    table.guest.receive(history(TICKS - 1));

    // Порция, сыгранная в обработчике сообщения, тоже ограничена:
    // проигрывать историю целиком в колбэке сокета — то самое, что
    // здесь и чинится.
    const portions = [table.portion()];
    expect(portions[0]).toBeLessThanOrEqual(FRAME_WORK_BUDGET_MS);

    // Кадры отрисовки, каждый со своим бюджетом. Предел числа кадров
    // страхует от вечного цикла: при бюджете в пять тиков шестьсот
    // укладываются в полтораста порций с запасом.
    for (let frame = 0; frame < 1_000 && table.guest.status !== 'playing'; frame += 1) {
      table.guest.advance(BUDGET);
      const played = table.portion();
      if (played > 0) portions.push(played);
    }

    expect(table.guest.status).toBe('playing');
    expect(table.guest.confirmed?.tick).toBe(TICKS);

    // Порций много, и каждая короче бюджета: между ними главный поток
    // свободен, и ровно за этим всё затевалось.
    expect(portions.length).toBeGreaterThan(10);
    expect(Math.max(...portions)).toBeLessThanOrEqual(FRAME_WORK_BUDGET_MS);
    expect(portions.reduce((sum, value) => sum + value, 0)).toBe(TICKS);
  });

  it('показываемое состояние обновляется на каждой порции', () => {
    // Требование спецификации — «догон сопровождается показом хода
    // восстановления» — держится ровно на этом. Доля восстановления
    // считается клиентом в обработчике показа (`onPredicted`), и пока
    // догон шёл одним куском, обработчик звался один раз: полоса,
    // посчитанная верно, появлялась готовой уже после догона.
    //
    // Проверяется здесь, а не сквозным тестом, и намеренно. В браузере
    // догон может уложиться в один кадр — тогда показывать нечего,
    // и сквозная проверка молча проходила бы, ничего не проверив.
    // Здесь же порции заданы бюджетом, и утверждение точное.
    const TICKS = 600;
    const shown: number[] = [];

    const guest = createMatchGuest({
      send: () => {},
      now: tickingClock(),
      onPredicted: (world) => shown.push(world.tick),
    });

    guest.receive(welcome(TICKS));
    guest.receive(history(TICKS - 1));

    for (let frames = 0; frames < 1_000 && guest.status !== 'playing'; frames += 1) {
      guest.advance(5);
    }

    expect(guest.status).toBe('playing');

    // Показ обновился много раз, и каждый раз мир был дальше прежнего:
    // именно это игрок и видит растущей полосой.
    expect(shown.length).toBeGreaterThan(10);
    const duringCatchUp = shown.filter((tick) => tick > 0 && tick < TICKS);
    expect(duringCatchUp.length).toBeGreaterThan(10);
    for (let index = 1; index < duringCatchUp.length; index += 1) {
      expect(duringCatchUp[index]).toBeGreaterThan(duringCatchUp[index - 1] ?? -1);
    }
  });

  it('при нулевом остатке бюджета проигрывает по тику, но доигрывает', () => {
    const TICKS = 90;

    const table = bench({ clock: true });
    table.guest.receive(welcome(TICKS));
    table.guest.receive(history(TICKS - 1));
    table.portion();

    // Ноль — это «времени не осталось вовсе», а не «стой». Иначе
    // на медленной машине догон не сдвинулся бы ни на тик.
    const portions: number[] = [];
    for (let frame = 0; frame < 1_000 && table.guest.status !== 'playing'; frame += 1) {
      table.guest.advance(0);
      const played = table.portion();
      if (played > 0) portions.push(played);
    }

    expect(table.guest.status).toBe('playing');
    expect(table.guest.confirmed?.tick).toBe(TICKS);
    expect(new Set(portions)).toEqual(new Set([1]));
  });

  it('пока отложенное не доиграно, продолжения не просит', () => {
    // Сервер ушёл дальше, чем принесла история: продолжение понадобится,
    // но не сейчас. Прежде запрос уходил по факту разбора сообщения —
    // при нарезке это означало бы «каждый кадр», и сервер отвечал бы
    // историей на каждый.
    const AHEAD = 900;
    const BROUGHT = 599;
    const BUDGET = 5;

    const table = bench({ clock: true });
    table.guest.receive(welcome(AHEAD));
    // Первая просьба, отправленная приветствием, к делу не относится.
    table.outgoing.length = 0;
    table.guest.receive(history(BROUGHT));

    const asks = (): number =>
      table.outgoing.filter((message) => message.type === MessageType.HistoryFrom).length;

    let frames = 0;
    while (frames < 1_000 && (table.guest.confirmed?.tick ?? 0) <= BROUGHT) {
      frames += 1;
      table.guest.advance(BUDGET);

      // Проверка стоит внутри цикла, а не после него: смысл требования
      // в том, что за ВСЁ время проигрывания не ушло ни одного запроса,
      // а не в том, сколько их набралось к концу.
      if ((table.guest.confirmed?.tick ?? 0) <= BROUGHT) expect(asks()).toBe(0);
    }

    expect(table.guest.confirmed?.tick).toBe(BROUGHT + 1);

    // Отложенное кончилось, сервер впереди — вот теперь ровно одна
    // просьба, и с того тика, до которого доиграли.
    expect(asks()).toBe(1);
    const asked = table.outgoing.find((message) => message.type === MessageType.HistoryFrom);
    if (asked?.type === MessageType.HistoryFrom) expect(asked.tick).toBe(BROUGHT + 1);
  });

  it('живые кадры во время догона доигрываются, и продолжения не просят', () => {
    const BROUGHT = 299;
    const BUDGET = 5;

    const table = bench({ clock: true });
    table.guest.receive(welcome(302));
    table.outgoing.length = 0;
    table.guest.receive(history(BROUGHT));

    // Кадры, пришедшие посреди догона, ложатся в тот же буфер и ждут
    // своей очереди. Выбрасывать их нельзя: чаще всего именно ими
    // отставание и закрывается, и второй запрос истории оказывается
    // не нужен вовсе.
    for (const tick of [300, 301, 302]) table.guest.receive(frame(tick));

    for (let frames = 0; frames < 1_000 && table.guest.status !== 'playing'; frames += 1) {
      table.guest.advance(BUDGET);
    }

    expect(table.guest.status).toBe('playing');
    expect(table.guest.confirmed?.tick).toBe(303);
    expect(table.outgoing.filter((message) => message.type === MessageType.HistoryFrom)).toEqual(
      [],
    );
  });

  it('отставание от сервера сокращается от порции к порции', () => {
    const BROUGHT = 599;
    const BUDGET = 5;

    const table = bench({ clock: true });
    table.guest.receive(welcome(600));
    table.guest.receive(history(BROUGHT));

    const gaps: number[] = [];
    // Тик, который сервер сыграет следующим.
    let ahead = 600;

    for (let frames = 0; frames < 2_000 && table.guest.status !== 'playing'; frames += 1) {
      // Сервер не ждёт, пока его догонят: каждый кадр он досчитывает
      // ещё один тик и присылает его. Это вдвое быстрее настоящего —
      // тридцать тиков в секунду против шестидесяти кадров, — то есть
      // проверка строже жизни.
      table.guest.receive(frame(ahead));
      ahead += 1;

      table.guest.advance(BUDGET);
      gaps.push(ahead - (table.guest.confirmed?.tick ?? 0));
    }

    // Догон кончается, а не длится вечно: ряд сходится, потому что
    // порция длиннее того, что сервер успевает досчитать.
    expect(table.guest.status).toBe('playing');
    expect(gaps.at(-1)).toBe(0);
    expect(gaps.length).toBeGreaterThan(10);

    for (let index = 1; index < gaps.length; index += 1) {
      expect(gaps[index]).toBeLessThan(gaps[index - 1] ?? 0);
    }
  });

  it('своя команда, вернувшаяся нарезанной историей, снимается ровно раз', () => {
    const table = bench({ clock: true });
    table.guest.receive(welcome(0));
    for (let tick = 0; tick < 10; tick += 1) table.guest.receive(frame(tick));

    const issued = table.guest.issue(goEast);
    expect(issued).not.toBeNull();
    if (issued === null) return;
    expect(table.guest.pendingCount).toBe(1);

    // Кадр из будущего проделывает дыру, и участник просит историю.
    // Отрезок принесёт нашу команду обратно — ту самую, на её такте.
    table.guest.receive(frame(120));
    const mine = withPlayer(issued, ME);
    table.guest.receive(history(119, [mine]));

    // Ждать здесь надо тика, а не состояния: дыра посреди обычной игры
    // состояния не меняет — участник всё это время «играет».
    for (let frames = 0; frames < 1_000 && (table.guest.confirmed?.tick ?? 0) < 121; frames += 1) {
      table.guest.advance(3);
    }

    expect(table.guest.confirmed?.tick).toBe(121);

    // `settle` теперь зовётся на каждой порции, а не один раз на весь
    // догон, — и снимает ровно подтверждённое: очередь пуста, а не
    // ушла в минус и не осталась с фантомом.
    expect(table.guest.pendingCount).toBe(0);

    // Команда исполнена ровно один раз и ровно на своём такте: мир
    // сошёлся с эталоном, посчитанным без всякой нарезки.
    let truth = createWorld(SEED);
    for (let tick = 0; tick < 121; tick += 1) {
      truth = step(truth, tick === issued.tick ? [mine] : []);
    }
    expect(checksum(table.guest.confirmed!)).toBe(checksum(truth));
  });

  it('срок переноса своей команды считается в тиках, а не в порциях', () => {
    const table = bench({ clock: true });
    table.guest.receive(welcome(0));
    for (let tick = 0; tick < 10; tick += 1) table.guest.receive(frame(tick));

    const issued = table.guest.issue(goEast);
    if (issued === null) return;

    // Догон в полсотни тиков, нарезанный по одному тику на порцию:
    // полсотни вызовов `settle` вместо одного. Команды в истории нет —
    // она ещё летит.
    const short = issued.tick + COMMAND_CARRY_LIMIT_TICKS - 15;
    table.guest.receive(frame(short));
    table.guest.receive(history(short - 1));

    for (
      let frames = 0;
      frames < 1_000 && (table.guest.confirmed?.tick ?? 0) <= short;
      frames += 1
    ) {
      table.guest.advance(0);
    }

    // Срок жизни отсчитывается от такта назначения по тикам мира,
    // поэтому полсотни вызовов его не расходуют: команда всё ещё
    // в пути, и предсказание её показывает.
    expect((table.guest.confirmed?.tick ?? 0) - issued.tick).toBeLessThanOrEqual(
      COMMAND_CARRY_LIMIT_TICKS,
    );
    expect(table.guest.pendingCount).toBe(1);

    // А вот когда мир уходит за срок — команда снимается, и это уже
    // не нарезка, а честное «не долетела».
    let tick = table.guest.confirmed?.tick ?? 0;
    const beyond = issued.tick + COMMAND_CARRY_LIMIT_TICKS + 2;
    for (; tick <= beyond; tick += 1) table.guest.receive(frame(tick));

    expect(table.guest.pendingCount).toBe(0);
  });

  it('участник без часов догоняет целиком в момент получения', () => {
    const TICKS = 200;

    const table = bench({ clock: false });
    table.guest.receive(welcome(TICKS));
    table.guest.receive(history(TICKS - 1));

    // Компьютерный соперник и стенды проверок заводят участника без
    // часов и без цикла отрисовки. Качать нарезку там некому, а решение
    // принимать надо по подтверждённому миру, которого без догона нет.
    expect(table.portion()).toBe(TICKS);
    expect(table.guest.confirmed?.tick).toBe(TICKS);
    expect(table.guest.status).toBe('playing');
  });
});
