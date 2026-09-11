import { LOBBY_CAPACITY } from '@td/protocol';
import type { LobbySummary, PlayerView } from '@td/protocol';
import { DEFAULT_PROFILE_ID } from '@td/ai';
import { describe, expect, it } from 'vitest';
import { parseEvents } from './lobby-api.js';
import type { FetchLike } from './lobby-api.js';
import { createComputerService } from './service.js';
import type { BotSocket, OpenSocket } from './participant.js';

/**
 * Служба компьютерных соперников проверяется без сети: подставлены
 * и HTTP, и поток состояния. Разбор при этом настоящий — тот самый,
 * что работает в бою, вплоть до склейки кусков потока событий.
 *
 * Главное свойство, ради которого здесь всё и переписано: служба
 * НИЧЕГО не делает, пока её не позвали. Ни комнат, ни дежурных,
 * ни запросов — один поток наблюдения, и всё.
 */

interface Fake {
  readonly fetch: FetchLike;
  readonly openSocket: OpenSocket;
  readonly posts: { readonly path: string; readonly body: Record<string, unknown> }[];
  /** Отдать слушателю очередное состояние. */
  push(playerId: string, view: PlayerView): Promise<void>;
  readonly listeners: readonly string[];
}

const emptyView: PlayerView = { lobbies: [], lobby: null, match: null, computerProfiles: [] };

const createFake = (): Fake => {
  const pushers = new Map<string, (view: PlayerView) => void>();
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const encoder = new TextEncoder();

  const fetchLike: FetchLike = (url, init) => {
    if (url.includes('/api/lobbies/stream')) {
      const playerId = url.slice(url.indexOf('playerId=') + 'playerId='.length);

      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });

      pushers.set(decodeURIComponent(playerId), (view) => {
        controller?.enqueue(encoder.encode(`data: ${JSON.stringify(view)}\n\n`));
      });

      return Promise.resolve({ ok: true, status: 200, body, text: () => Promise.resolve('') });
    }

    posts.push({
      path: url,
      body: JSON.parse(init?.body ?? '{}') as Record<string, unknown>,
    });

    return Promise.resolve({ ok: true, status: 200, body: null, text: () => Promise.resolve('') });
  };

  const openSocket: OpenSocket = (): BotSocket => ({
    send: () => undefined,
    close: () => undefined,
  });

  return {
    fetch: fetchLike,
    openSocket,
    posts,
    get listeners() {
      return [...pushers.keys()];
    },
    async push(playerId, view) {
      pushers.get(playerId)?.(view);
      // Даём потоку дочитать: разбор идёт через микрозадачи.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
};

/** Секрет, которым служба заверяет свои личности перед сервером. */
const SECRET = 'проба-секрета';

/** Манера этой службы. Ею же её и зовут. */
const PROFILE = 'swarm-2026-08';

/**
 * Служба с назначенной манерой.
 *
 * Секрет передаётся всегда, потому что без него служба не слушает
 * приглашений вовсе — и это не поблажка тестам, а настоящее правило:
 * дежурный, чьё объявление не принято, встал бы в комнате непомеченным,
 * и игрок сел бы играть с компьютером, думая, что играет с человеком.
 */
const service = (fake: Fake, maxMatches = 2, profile = PROFILE) =>
  createComputerService({
    apiUrl: 'http://bench',
    wsUrl: 'ws://bench/game',
    fetch: fake.fetch,
    openSocket: fake.openSocket,
    maxMatches,
    profile,
    title: 'Матч с компьютером',
    secret: SECRET,
    makeId: (index) => `computer-${String(index)}`,
  });

/** Личность наблюдателя: он открывается первым и номер берёт первый. */
const WATCHER = 'computer-0-watch';

/** Комната в общем списке — с приглашением или без. */
const room = (wanted: string | null, players = 1, id = 'l1'): LobbySummary => ({
  id,
  title: 'Комната Ани',
  hostName: 'Аня',
  players,
  capacity: LOBBY_CAPACITY,
  computer: false,
  locked: false,
  wanted,
});

const listView = (...rooms: LobbySummary[]): PlayerView => ({
  lobbies: rooms,
  lobby: null,
  match: null,
  computerProfiles: [],
});

/** Комната глазами вошедшего дежурного. */
const roomView = (players: number, ready: boolean): PlayerView => ({
  lobbies: [],
  lobby: {
    id: 'l1',
    title: 'Комната Ани',
    capacity: LOBBY_CAPACITY,
    slots: Array.from({ length: players }, (_, index) => ({
      name: index === 0 ? 'Аня' : 'Компьютер',
      ready: index === 0 ? true : ready,
      connected: true,
      you: index !== 0,
    })),
    wanted: null,
  },
  match: null,
  computerProfiles: [],
});

/**
 * Дать микрозадачам доехать.
 *
 * Нужно сразу после создания службы: она начинается с рукопожатия —
 * пустого объявления «а меня примут?» — и поток наблюдения открывается
 * только после ответа.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('разбор потока состояния', () => {
  it('берёт полезную часть и пропускает комментарии', () => {
    expect(parseEvents(': ping\n\ndata: {"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  it('склеивает многострочное событие', () => {
    expect(parseEvents('data: {"a":\ndata: 1}\n\n')).toEqual(['{"a":1}']);
  });

  it('на пустом куске молчит', () => {
    expect(parseEvents('\n\n')).toEqual([]);
  });
});

describe('служба компьютерных соперников', () => {
  it('пока не позвали, не делает ничего', async () => {
    // Главное свойство. Прежде служба держала три дежурных с тремя
    // комнатами и тремя потоками круглые сутки, даже когда в игру
    // не заходил никто; владелец продукта потребовал, чтобы «ничего
    // не крутилось, пока никто не играет».
    const fake = createFake();
    const running = service(fake);
    await settle();

    expect(fake.listeners).toEqual([WATCHER]);
    expect(running.idleCount).toBe(0);
    expect(running.matchCount).toBe(0);
    expect(fake.posts.filter((post) => post.path.endsWith('/api/lobbies'))).toHaveLength(0);

    // Список комнат без приглашения тоже ничего не поднимает.
    await fake.push(WATCHER, listView(room(null), room('другая-манера')));
    expect(fake.listeners).toEqual([WATCHER]);

    running.close();
  });

  it('на приглашение своей манерой поднимает дежурного и входит', async () => {
    const fake = createFake();
    const running = service(fake);
    await settle();

    await fake.push(WATCHER, listView(room(PROFILE)));
    await settle();

    // Дежурный поднят и слушает своё состояние.
    expect(fake.listeners).toContain('computer-1');
    expect(running.idleCount).toBe(1);

    const joined = fake.posts.filter((post) => post.path.includes('/join'));
    expect(joined).toHaveLength(1);
    expect(joined[0]?.path).toContain('/api/lobbies/l1/join');
    expect(joined[0]?.body['playerId']).toBe('computer-1');

    // Комнат он при этом не заводит: входит в чужую, как человек.
    expect(fake.posts.filter((post) => post.path.endsWith('/api/lobbies'))).toHaveLength(0);

    running.close();
  });

  it('на чужую манеру и на полную комнату не идёт', async () => {
    const fake = createFake();
    const running = service(fake);
    await settle();

    await fake.push(WATCHER, listView(room('оплот'), room(PROFILE, LOBBY_CAPACITY, 'l2')));
    await settle();

    expect(fake.posts.filter((post) => post.path.includes('/join'))).toHaveLength(0);
    expect(running.idleCount).toBe(0);

    running.close();
  });

  it('на повторное состояние с тем же приглашением второго не поднимает', async () => {
    // Состояние приходит целиком и не мгновенно: между входом дежурного
    // и обновлением списка успевает прийти прежний кадр, где комната
    // всё ещё зовёт. Без защиты на каждый такой кадр поднимался бы
    // новый дежурный.
    const fake = createFake();
    const running = service(fake);
    await settle();

    await fake.push(WATCHER, listView(room(PROFILE)));
    await settle();
    await fake.push(WATCHER, listView(room(PROFILE)));
    await settle();

    expect(fake.posts.filter((post) => post.path.includes('/join'))).toHaveLength(1);

    running.close();
  });

  it('не заводит дежурных сверх предела', async () => {
    const fake = createFake();
    const running = service(fake, 2);
    await settle();

    await fake.push(
      WATCHER,
      listView(room(PROFILE, 1, 'l1'), room(PROFILE, 1, 'l2'), room(PROFILE, 1, 'l3')),
    );
    await settle();

    expect(fake.posts.filter((post) => post.path.includes('/join'))).toHaveLength(2);

    running.close();
  });

  it('в одиночестве готовность не подтверждает', async () => {
    const fake = createFake();
    const running = service(fake);
    await settle();

    await fake.push(WATCHER, listView(room(PROFILE)));
    await settle();
    await fake.push('computer-1', roomView(1, false));

    expect(fake.posts.filter((post) => post.path.endsWith('/ready'))).toHaveLength(0);

    running.close();
  });

  it('подтверждает готовность, когда в комнате двое', async () => {
    const fake = createFake();
    const running = service(fake);
    await settle();

    await fake.push(WATCHER, listView(room(PROFILE)));
    await settle();
    await fake.push('computer-1', roomView(2, false));

    const ready = fake.posts.filter((post) => post.path.endsWith('/ready'));
    expect(ready).toHaveLength(1);
    expect(ready[0]?.body['ready']).toBe(true);

    running.close();
  });

  it('после сброса готовности подтверждает её заново', async () => {
    const fake = createFake();
    const running = service(fake);
    await settle();

    await fake.push(WATCHER, listView(room(PROFILE)));
    await settle();

    await fake.push('computer-1', roomView(2, false));
    await fake.push('computer-1', roomView(2, true));
    // Смена состава сбросила готовность у всех, кто остался.
    await fake.push('computer-1', roomView(2, false));

    expect(fake.posts.filter((post) => post.path.endsWith('/ready'))).toHaveLength(2);

    running.close();
  });

  it('распавшаяся комната уводит дежурного', async () => {
    // Комната распалась, пока дежурный шёл: хозяин передумал и вышел.
    // Держать дежурного дальше не за чем — звать его будут заново.
    const fake = createFake();
    const running = service(fake);
    await settle();

    await fake.push(WATCHER, listView(room(PROFILE)));
    await settle();
    expect(running.idleCount).toBe(1);

    await fake.push('computer-1', emptyView);

    expect(running.idleCount).toBe(0);
    expect(fake.posts.some((post) => post.path.endsWith('/leave'))).toBe(true);

    running.close();
  });

  it('признаёт своими только выданные идентификаторы', async () => {
    const fake = createFake();
    const running = service(fake);
    await settle();

    await fake.push(WATCHER, listView(room(PROFILE)));
    await settle();

    expect(running.owns('computer-1')).toBe(true);
    expect(running.owns('человек')).toBe(false);
    // Назваться компьютером со стороны нельзя: идентификаторы выдаёт
    // служба, а не тот, кто представляется.
    expect(running.owns('computer-999')).toBe(false);

    running.close();
  });

  it('отвечает своей манерой на свой идентификатор и молчит на чужой', async () => {
    // Один источник правды: тот же набор идентификаторов, по которому
    // служба отвечает `owns`. Два обработчика однажды разошлись бы,
    // и сторона записалась бы человеческой при живом компьютере.
    const fake = createFake();
    const running = service(fake);
    await settle();

    await fake.push(WATCHER, listView(room(PROFILE)));
    await settle();

    expect(running.profileOf('computer-1')).toBe(PROFILE);
    expect(running.profileOf('человек')).toBeUndefined();

    running.close();
  });

  it('без назначенной манеры отвечает умолчанием библиотеки', async () => {
    const fake = createFake();
    const running = createComputerService({
      apiUrl: 'http://bench',
      wsUrl: 'ws://bench/game',
      fetch: fake.fetch,
      openSocket: fake.openSocket,
      maxMatches: 2,
      secret: SECRET,
      makeId: (index) => `computer-${String(index)}`,
    });
    await settle();

    await fake.push(WATCHER, listView(room(DEFAULT_PROFILE_ID)));
    await settle();

    expect(running.profileOf('computer-1')).toBe(DEFAULT_PROFILE_ID);

    running.close();
  });

  it('без секрета не слушает приглашений', async () => {
    // Не поблажка настройке, а защита игрока. Дежурный, чьё объявление
    // сервер не принял, всё равно вошёл бы в комнату — и встал бы в ней
    // НЕПОМЕЧЕННЫМ, то есть человеком на вид. Игрок сел бы играть
    // с компьютером, думая, что играет с человеком.
    //
    // Недоступная игра с компьютером — неприятность. Игра, которая врёт
    // о сопернике, — поломка обещания, на котором стоит весь замысел.
    const fake = createFake();
    const running = createComputerService({
      apiUrl: 'http://bench',
      wsUrl: 'ws://bench/game',
      fetch: fake.fetch,
      openSocket: fake.openSocket,
      maxMatches: 2,
      makeId: (index) => `computer-${String(index)}`,
    });
    await settle();

    expect(fake.listeners).toHaveLength(0);
    expect(running.idleCount).toBe(0);
    expect(fake.posts).toHaveLength(0);

    running.close();
  });

  it('отвергнутое объявление тоже никого не поднимает', async () => {
    // Секрет задан, но сервер его не принял: регистрация закрыта или
    // секрет не тот. Итог обязан быть тем же, что и без секрета вовсе.
    const fake = createFake();
    const refusing: Fake = {
      ...fake,
      fetch: (url, init) =>
        url.endsWith('/api/computer/declare')
          ? Promise.resolve({
              ok: false,
              status: 403,
              body: null,
              text: () => Promise.resolve(''),
            })
          : fake.fetch(url, init),
    };

    const running = service(refusing);
    await settle();

    expect(fake.listeners).toHaveLength(0);
    expect(running.idleCount).toBe(0);

    running.close();
  });

  it('объявляет манеру сразу, а личности — по мере найма', async () => {
    const fake = createFake();
    const running = service(fake);
    await settle();

    const first = fake.posts.filter((post) => post.path.endsWith('/api/computer/declare'));
    expect(first).toHaveLength(1);
    expect(first[0]?.body['secret']).toBe(SECRET);
    // Манера объявлена ДО того, как поднят хоть один дежурный: их и не
    // бывает, пока никто не позвал, а выбрать соперника игрок должен
    // именно в этот момент.
    expect(first[0]?.body['offers']).toEqual([{ id: PROFILE, title: 'Матч с компьютером' }]);
    expect(first[0]?.body['identities']).toEqual([]);

    await fake.push(WATCHER, listView(room(PROFILE)));
    await settle();

    const declared = fake.posts.filter((post) => post.path.endsWith('/api/computer/declare'));
    expect(declared.at(-1)?.body['identities']).toEqual([{ id: 'computer-1', profile: PROFILE }]);

    running.close();

    const withdrawn = fake.posts.filter((post) => post.path.endsWith('/api/computer/withdraw'));
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]?.body['ids']).toEqual(['computer-1']);
    // Манера снимается вместе с уходом службы, иначе игроку предлагали
    // бы соперника, которого некому прислать.
    expect(withdrawn[0]?.body['offers']).toEqual([PROFILE]);
  });

  it('закрытие уводит дежурных из комнат', async () => {
    const fake = createFake();
    const running = service(fake);
    await settle();

    await fake.push(WATCHER, listView(room(PROFILE)));
    await settle();

    running.close();
    await settle();

    expect(fake.posts.some((post) => post.path.endsWith('/leave'))).toBe(true);
  });
});
