import { LOBBY_CAPACITY } from '@td/protocol';
import type { PlayerView } from '@td/protocol';
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
 */

interface Fake {
  readonly fetch: FetchLike;
  readonly openSocket: OpenSocket;
  readonly posts: { readonly path: string; readonly body: Record<string, unknown> }[];
  /** Отдать дежурному очередное состояние. */
  push(playerId: string, view: PlayerView): Promise<void>;
  readonly listeners: readonly string[];
}

const emptyView: PlayerView = { lobbies: [], lobby: null, match: null };

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

/**
 * По умолчанию дежурный один: так проще проверять правила по одному.
 * Запас наготове — отдельная история, и у неё свой тест.
 *
 * Секрет передаётся всегда, потому что без него служба не поднимает
 * никого вовсе — и это не поблажка тестам, а настоящее правило:
 * дежурный, чьё объявление не принято, создал бы непомеченную комнату,
 * и игрок сел бы играть с компьютером, думая, что играет с человеком.
 */
const service = (fake: Fake, maxMatches = 2, idleTarget = 1) =>
  createComputerService({
    apiUrl: 'http://bench',
    wsUrl: 'ws://bench/game',
    fetch: fake.fetch,
    openSocket: fake.openSocket,
    maxMatches,
    idleTarget,
    secret: SECRET,
    makeId: (index) => `computer-${String(index)}`,
  });

const roomView = (players: number, ready: boolean): PlayerView => ({
  lobbies: [],
  lobby: {
    id: 'l1',
    title: 'Матч с компьютером',
    capacity: LOBBY_CAPACITY,
    slots: Array.from({ length: players }, (_, index) => ({
      name: index === 0 ? 'Компьютер' : 'Аня',
      ready: index === 0 ? ready : true,
      connected: true,
      you: index === 0,
    })),
  },
  match: null,
});

/**
 * Дать микрозадачам доехать.
 *
 * Нужно теперь и сразу после создания службы: она начинается
 * с рукопожатия — пустого объявления «а меня примут?» — и найм идёт
 * только после ответа. Между созданием и первым дежурным появился
 * зазор, которого раньше не было.
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
  it('заводит дежурного и создаёт ему комнату', async () => {
    const fake = createFake();
    const running = service(fake);
    await settle();

    expect(fake.listeners).toEqual(['computer-0']);

    await fake.push('computer-0', emptyView);

    const created = fake.posts.filter((post) => post.path.endsWith('/api/lobbies'));
    expect(created).toHaveLength(1);
    expect(created[0]?.body['playerId']).toBe('computer-0');

    running.close();
  });

  it('в одиночестве готовность не подтверждает', async () => {
    const fake = createFake();
    const running = service(fake);
    await settle();

    await fake.push('computer-0', roomView(1, false));

    expect(fake.posts.filter((post) => post.path.endsWith('/ready'))).toHaveLength(0);

    running.close();
  });

  it('подтверждает готовность, когда появился соперник', async () => {
    const fake = createFake();
    const running = service(fake);
    await settle();

    await fake.push('computer-0', roomView(2, false));

    const ready = fake.posts.filter((post) => post.path.endsWith('/ready'));
    expect(ready).toHaveLength(1);
    expect(ready[0]?.body['ready']).toBe(true);

    running.close();
  });

  it('после сброса готовности подтверждает её заново', async () => {
    const fake = createFake();
    const running = service(fake);
    await settle();

    await fake.push('computer-0', roomView(2, false));
    await fake.push('computer-0', roomView(2, true));
    // Смена состава сбросила готовность у всех, кто остался.
    await fake.push('computer-0', roomView(2, false));

    expect(fake.posts.filter((post) => post.path.endsWith('/ready'))).toHaveLength(2);

    running.close();
  });

  it('поднимает следующего дежурного, как только в комнату вошёл гость', async () => {
    const fake = createFake();
    const running = service(fake);
    await settle();

    expect(running.idleCount).toBe(1);

    await fake.push('computer-0', roomView(2, false));

    expect(fake.listeners).toEqual(['computer-0', 'computer-1']);
    expect(running.idleCount).toBe(1);

    running.close();
  });

  it('держит наготове столько дежурных, сколько заказано', async () => {
    const fake = createFake();
    const running = service(fake, 8, 3);
    await settle();

    // Трое ждут в трёх разных комнатах: двое, нажавшие «играть
    // с компьютером» одновременно, расходятся по разным, а не дерутся
    // за единственную.
    expect(fake.listeners).toHaveLength(3);
    expect(running.idleCount).toBe(3);

    running.close();
  });

  it('не заводит дежурных сверх предела', async () => {
    const fake = createFake();
    const running = service(fake, 2);
    await settle();

    await fake.push('computer-0', roomView(2, false));
    await fake.push('computer-1', roomView(2, false));

    // Предел в два: третьего дежурного не появляется, даже когда
    // свободных комнат не осталось.
    expect(fake.listeners).toHaveLength(2);

    running.close();
  });

  it('признаёт своими только выданные идентификаторы', async () => {
    const fake = createFake();
    const running = service(fake);
    await settle();

    expect(running.owns('computer-0')).toBe(true);
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
    const running = createComputerService({
      apiUrl: 'http://bench',
      wsUrl: 'ws://bench/game',
      fetch: fake.fetch,
      openSocket: fake.openSocket,
      maxMatches: 2,
      idleTarget: 1,
      profile: 'swarm-2026-08',
      secret: SECRET,
      makeId: (index) => `computer-${String(index)}`,
    });
    await settle();

    expect(running.profileOf('computer-0')).toBe('swarm-2026-08');
    expect(running.profileOf('человек')).toBeUndefined();

    running.close();
  });

  it('без назначенной манеры отвечает умолчанием библиотеки', async () => {
    const fake = createFake();
    const running = service(fake);
    await settle();

    expect(running.profileOf('computer-0')).toBe(DEFAULT_PROFILE_ID);

    running.close();
  });

  it('без секрета не поднимает никого', async () => {
    // Не поблажка настройке, а защита игрока. Дежурный, чьё объявление
    // сервер не принял, всё равно создал бы комнату — и она встала бы
    // в списке НЕПОМЕЧЕННОЙ, то есть человеческой на вид. Игрок сел бы
    // играть с компьютером, думая, что играет с человеком.
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
      idleTarget: 1,
      makeId: (index) => `computer-${String(index)}`,
    });
    await settle();

    expect(fake.listeners).toHaveLength(0);
    expect(running.idleCount).toBe(0);
    expect(fake.posts.filter((post) => post.path.endsWith('/api/lobbies'))).toHaveLength(0);

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

  it('объявляет свои личности и снимает объявление на выходе', async () => {
    const fake = createFake();
    const running = service(fake);
    await settle();

    await fake.push('computer-0', emptyView);

    const declared = fake.posts.filter((post) => post.path.endsWith('/api/computer/declare'));
    // Первое объявление — пустое рукопожатие, дальше идут личности.
    expect(declared.length).toBeGreaterThanOrEqual(2);
    expect(declared[0]?.body['secret']).toBe(SECRET);
    expect(declared.at(-1)?.body['identities']).toEqual([
      { id: 'computer-0', profile: DEFAULT_PROFILE_ID },
    ]);

    running.close();

    const withdrawn = fake.posts.filter((post) => post.path.endsWith('/api/computer/withdraw'));
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]?.body['ids']).toEqual(['computer-0']);
  });

  it('закрытие уводит дежурных из комнат', async () => {
    const fake = createFake();
    const running = service(fake);
    await settle();

    running.close();
    await settle();

    expect(fake.posts.some((post) => post.path.endsWith('/leave'))).toBe(true);
  });
});
