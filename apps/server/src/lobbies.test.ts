import { beforeEach, describe, expect, it } from 'vitest';
import { LobbyError } from '@td/protocol';
import { computerMindOf } from '@td/shared';
import { DISCONNECT_GRACE_MS, createLobbyStore } from './lobbies.js';
import type { LobbyStore, MatchStart } from './lobbies.js';

/**
 * Часы и seed внедрены, поэтому ни одна проверка здесь не ждёт по-настоящему
 * и не зависит от случайности. Отсрочка в пятнадцать секунд проверяется
 * переводом стрелок, а не пятнадцатью секундами ожидания.
 */
let clock = 1_000_000;
let store: LobbyStore;

const seeds = [111, 222, 333];
let seedIndex = 0;
let ticketIndex = 0;

beforeEach(() => {
  clock = 1_000_000;
  seedIndex = 0;
  ticketIndex = 0;
  store = createLobbyStore({
    now: () => clock,
    randomSeed: () => seeds[seedIndex++ % seeds.length] ?? 0,
    // Билеты предсказуемые: настоящая случайность в тесте только мешала бы
    // сверять, кому какой достался.
    randomTicket: () => `ticket-${String(ticketIndex++)}`,
  });
});

/** Игрок с открытым потоком состояния — обычное положение дел. */
const arrive = (id: string): void => {
  store.connect(id);
};

const openLobbyId = (playerId: string): string => {
  const first = store.view(playerId).lobbies[0];
  if (first === undefined) throw new Error('Ожидалась хотя бы одна открытая комната');
  return first.id;
};

describe('создание комнаты', () => {
  it('помещает создателя в комнату первым', () => {
    arrive('a');
    const created = store.create('a', 'Аня', 'Комната Ани');

    expect(created.ok).toBe(true);
    const view = store.view('a');
    expect(view.lobby?.slots).toHaveLength(1);
    expect(view.lobby?.slots[0]).toMatchObject({ name: 'Аня', you: true, connected: true });
  });

  it('не принимает негодное имя и негодное название', () => {
    arrive('a');
    expect(store.create('a', ' ', 'Комната')).toEqual({ ok: false, error: LobbyError.BadName });
    expect(store.create('a', 'Аня', '')).toEqual({ ok: false, error: LobbyError.BadTitle });
    expect(store.view('a').lobbies).toHaveLength(0);
  });

  it('выводит создателя из прежней комнаты', () => {
    // Состоять в двух комнатах разом игрок не может: он не смог бы
    // ответить на готовность в обеих.
    arrive('a');
    store.create('a', 'Аня', 'Первая');
    store.create('a', 'Аня', 'Вторая');

    const view = store.view('a');
    expect(view.lobby?.title).toBe('Вторая');
    // Первая опустела и исчезла, а не осталась висеть без хозяина.
    expect(view.lobbies.map((lobby) => lobby.title)).toEqual(['Вторая']);
  });
});

describe('вход в комнату', () => {
  it('занимает свободное место', () => {
    arrive('a');
    arrive('b');
    store.create('a', 'Аня', 'Комната Ани');

    const joined = store.join('b', 'Боря', openLobbyId('b'));

    expect(joined.ok).toBe(true);
    expect(store.view('a').lobby?.slots.map((slot) => slot.name)).toEqual(['Аня', 'Боря']);
  });

  it('отклоняется, когда оба места заняты', () => {
    // Двое могут нажать «войти» в одну комнату одновременно — случай
    // не выдуманный, а обычный при живом списке.
    arrive('a');
    arrive('b');
    arrive('c');
    store.create('a', 'Аня', 'Комната Ани');
    const id = openLobbyId('b');
    store.join('b', 'Боря', id);

    expect(store.join('c', 'Вова', id)).toEqual({ ok: false, error: LobbyError.Full });
  });

  it('отклоняется, когда матч уже начался', () => {
    arrive('a');
    arrive('b');
    arrive('c');
    store.create('a', 'Аня', 'Комната Ани');
    const id = openLobbyId('b');
    store.join('b', 'Боря', id);
    store.setReady('a', true);
    store.setReady('b', true);

    expect(store.join('c', 'Вова', id)).toEqual({ ok: false, error: LobbyError.AlreadyStarted });
  });

  it('отклоняется, когда комнаты нет', () => {
    arrive('a');
    expect(store.join('a', 'Аня', 'нет-такой')).toEqual({ ok: false, error: LobbyError.NotFound });
  });

  it('повторный вход в свою комнату не ошибка', () => {
    arrive('a');
    store.create('a', 'Аня', 'Комната Ани');
    const id = store.view('a').lobby?.id ?? '';

    expect(store.join('a', 'Аня', id).ok).toBe(true);
    expect(store.view('a').lobby?.slots).toHaveLength(1);
  });
});

describe('выход из комнаты', () => {
  it('последний вышедший закрывает комнату', () => {
    arrive('a');
    store.create('a', 'Аня', 'Комната Ани');

    expect(store.leave('a')).toBe(true);
    expect(store.view('a').lobbies).toHaveLength(0);
    expect(store.view('a').lobby).toBeNull();
  });

  it('выход того, кто нигде не состоит, ничего не меняет', () => {
    expect(store.leave('никто')).toBe(false);
  });

  it('оставшийся становится хозяином', () => {
    arrive('a');
    arrive('b');
    store.create('a', 'Аня', 'Комната Ани');
    store.join('b', 'Боря', openLobbyId('b'));

    store.leave('a');

    expect(store.view('b').lobbies[0]?.hostName).toBe('Боря');
  });
});

describe('готовность', () => {
  it('в одиночестве недоступна', () => {
    arrive('a');
    store.create('a', 'Аня', 'Комната Ани');

    expect(store.setReady('a', true)).toEqual({ ok: false, error: LobbyError.NeedOpponent });
  });

  it('видна сопернику', () => {
    arrive('a');
    arrive('b');
    store.create('a', 'Аня', 'Комната Ани');
    store.join('b', 'Боря', openLobbyId('b'));

    store.setReady('a', true);

    const seenByB = store.view('b').lobby?.slots ?? [];
    expect(seenByB.find((slot) => slot.name === 'Аня')?.ready).toBe(true);
    expect(seenByB.find((slot) => slot.name === 'Боря')?.ready).toBe(false);
  });

  it('отзывается', () => {
    arrive('a');
    arrive('b');
    store.create('a', 'Аня', 'Комната Ани');
    store.join('b', 'Боря', openLobbyId('b'));

    store.setReady('a', true);
    store.setReady('a', false);
    store.setReady('b', true);

    expect(store.view('a').match).toBeNull();
  });

  it('сбрасывается уходом соперника', () => {
    arrive('a');
    arrive('b');
    store.create('a', 'Аня', 'Комната Ани');
    store.join('b', 'Боря', openLobbyId('b'));
    store.setReady('a', true);
    store.setReady('b', false);

    store.leave('b');

    expect(store.view('a').lobby?.slots[0]?.ready).toBe(false);
  });

  it('новый вошедший не застаёт чужой готовности', () => {
    // Ради этого случая правило и существует: иначе третий запустил бы
    // матч первым нажатием, не увидев, с кем играет.
    arrive('a');
    arrive('b');
    arrive('c');
    store.create('a', 'Аня', 'Комната Ани');
    const id = openLobbyId('b');
    store.join('b', 'Боря', id);
    store.setReady('a', true);
    store.leave('b');

    store.join('c', 'Вова', id);

    expect(store.view('c').lobby?.slots.every((slot) => !slot.ready)).toBe(true);
    expect(store.view('c').match).toBeNull();
  });
});

describe('старт матча по обоюдной готовности', () => {
  const bothReady = (): void => {
    arrive('a');
    arrive('b');
    store.create('a', 'Аня', 'Комната Ани');
    store.join('b', 'Боря', openLobbyId('b'));
    store.setReady('a', true);
    store.setReady('b', true);
  };

  it('выдаёт обоим один матч, один seed и разные стороны', () => {
    bothReady();

    const first = store.view('a').match;
    const second = store.view('b').match;

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.matchId).toBe(second?.matchId);
    expect(first?.seed).toBe(second?.seed);
    expect(first?.side).toBe(0);
    expect(second?.side).toBe(1);
  });

  it('называет каждому имя соперника, а не своё', () => {
    bothReady();

    expect(store.view('a').match?.opponentName).toBe('Боря');
    expect(store.view('b').match?.opponentName).toBe('Аня');
  });

  it('выдаёт каждому свой билет на вход в матч', () => {
    bothReady();

    const first = store.view('a').match?.ticket;
    const second = store.view('b').match?.ticket;

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    // Билеты разные: билет — это и есть «кто именно подключился».
    // Один на двоих означал бы, что за любую сторону играет предъявитель.
    expect(first).not.toBe(second);
  });

  it('сообщает начавшийся матч тому, кто его ведёт', () => {
    const started: MatchStart[] = [];
    const watched = createLobbyStore({
      now: () => clock,
      randomSeed: () => 555,
      randomTicket: () => `ticket-${String(ticketIndex++)}`,
      onMatchStart: (start) => started.push(start),
    });

    watched.connect('a');
    watched.connect('b');
    watched.create('a', 'Аня', 'Комната Ани');
    const lobbyId = watched.view('a').lobby?.id ?? '';
    watched.join('b', 'Боря', lobbyId);
    watched.setReady('a', true);
    watched.setReady('b', true);

    expect(started).toHaveLength(1);
    expect(started[0]?.seed).toBe(555);
    expect([...(started[0]?.tickets.values() ?? [])].sort()).toEqual([0, 1]);
    // Партия двух людей: обе стороны человеческие, выдумывать профили
    // и seed решений не для кого.
    expect(started[0]?.sides).toEqual([{ who: 'human' }, { who: 'human' }]);
  });

  it('сообщает профиль и seed решений компьютерной стороны', () => {
    const started: MatchStart[] = [];
    const watched = createLobbyStore({
      now: () => clock,
      randomSeed: () => 555,
      randomTicket: () => `ticket-${String(ticketIndex++)}`,
      computerProfileOf: (playerId) => (playerId === 'bot' ? 'swarm-2026-08' : undefined),
      onMatchStart: (start) => started.push(start),
    });

    watched.connect('человек');
    watched.connect('bot');
    watched.create('человек', 'Аня', 'Комната Ани');
    const lobbyId = watched.view('человек').lobby?.id ?? '';
    watched.join('bot', 'Компьютер', lobbyId);
    watched.setReady('человек', true);
    watched.setReady('bot', true);

    const sides = started[0]?.sides ?? [];
    expect(sides[0]).toEqual({ who: 'human' });
    // Seed решений спрошен у самого компьютера и выведен из seed мира:
    // ни нулей, ни пустых профилей, которые писал прежний клиент.
    expect(sides[1]).toEqual(computerMindOf(555, 1, 'swarm-2026-08'));
    // Профиль — тот, которым играет эта служба, а не умолчание. Иначе
    // запись матча назвала бы манеру, которой никто не играл.
    expect(sides[1]).toMatchObject({ who: 'computer', profile: 'swarm-2026-08' });
    expect((sides[1] as { seed: number }).seed).not.toBe(0);
  });

  it('помечает комнату компьютера в списке', () => {
    const withBot = createLobbyStore({
      now: () => clock,
      randomSeed: () => 1,
      randomTicket: () => 'ticket',
      computerProfileOf: (playerId) => (playerId === 'bot' ? 'swarm-2026-08' : undefined),
    });

    withBot.connect('bot');
    withBot.create('bot', 'Компьютер', 'Матч с компьютером');
    withBot.connect('человек');
    withBot.create('человек', 'Аня', 'Комната Ани');

    const list = withBot.view('гость').lobbies;
    const botLobby = list.find((lobby) => lobby.hostName === 'Компьютер');
    const humanLobby = list.find((lobby) => lobby.hostName === 'Аня');

    expect(botLobby?.computer).toBe(true);
    expect(humanLobby?.computer).toBe(false);
  });

  it('убирает комнату из списка открытых', () => {
    arrive('c');
    bothReady();

    expect(store.view('c').lobbies).toHaveLength(0);
  });

  it('не пересоздаёт матч повторным нажатием', () => {
    bothReady();
    const before = store.view('a').match?.matchId;

    // Готовность после старта отклоняется: договариваться уже не о чем.
    expect(store.setReady('a', false)).toEqual({ ok: false, error: LobbyError.AlreadyStarted });
    expect(store.view('a').match?.matchId).toBe(before);
  });

  it('не начинается, пока кто-то потерял связь', () => {
    arrive('a');
    arrive('b');
    store.create('a', 'Аня', 'Комната Ани');
    store.join('b', 'Боря', openLobbyId('b'));
    store.setReady('a', true);

    store.disconnect('b');
    store.setReady('a', true);

    expect(store.view('a').match).toBeNull();
  });

  it('не меняет сторону оставшемуся, когда соперник ушёл из матча', () => {
    // Стороны заморожены при старте. Считай мы их позицией в списке
    // слотов, уход соперника молча пересадил бы оставшегося
    // со второй стороны на нулевую посреди партии.
    bothReady();
    expect(store.view('b').match?.side).toBe(1);

    store.leave('a');

    expect(store.view('b').match?.side).toBe(1);
  });
});

describe('потеря связи', () => {
  const pair = (): void => {
    arrive('a');
    arrive('b');
    store.create('a', 'Аня', 'Комната Ани');
    store.join('b', 'Боря', openLobbyId('b'));
  };

  it('видна сопернику и снимает готовность', () => {
    pair();
    store.setReady('a', true);

    expect(store.disconnect('b')).toBe(true);

    const slots = store.view('a').lobby?.slots ?? [];
    expect(slots.find((slot) => slot.name === 'Боря')?.connected).toBe(false);
    expect(slots.every((slot) => !slot.ready)).toBe(true);
  });

  it('сохраняет место при возврате до истечения отсрочки', () => {
    pair();
    store.disconnect('b');

    clock += DISCONNECT_GRACE_MS - 1;
    store.sweep();
    store.connect('b');

    expect(store.view('b').lobby?.slots).toHaveLength(2);
    expect(store.view('b').lobby?.slots[1]?.connected).toBe(true);
  });

  it('освобождает место по истечении отсрочки', () => {
    pair();
    store.disconnect('b');

    clock += DISCONNECT_GRACE_MS;

    expect(store.sweep()).toBe(true);
    expect(store.view('a').lobby?.slots).toHaveLength(1);
  });

  it('закрывает комнату, покинутую всеми по отсрочке', () => {
    pair();
    store.disconnect('a');
    store.disconnect('b');

    clock += DISCONNECT_GRACE_MS;
    store.sweep();

    expect(store.view('a').lobbies).toHaveLength(0);
  });

  it('не выгоняет по второй вкладке', () => {
    // Игрок мог открыть игру дважды. Закрытие одной вкладки не означает,
    // что он ушёл, поэтому потоки считаются, а не переключают флаг.
    pair();
    store.connect('b');
    store.disconnect('b');

    expect(store.view('a').lobby?.slots[1]?.connected).toBe(true);
  });

  it('не теряет уже начавшийся матч', () => {
    pair();
    store.setReady('a', true);
    store.setReady('b', true);
    const started = store.view('b').match;

    store.disconnect('b');
    clock += DISCONNECT_GRACE_MS - 1;
    store.sweep();
    store.connect('b');

    expect(store.view('b').match).toEqual(started);
  });
});
