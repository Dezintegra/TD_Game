import { describe, expect, it } from 'vitest';
import { createTrello, missingAccess, readBoard } from './trello.mjs';

/**
 * Проверки обращения к Trello.
 *
 * Сети здесь нет вовсе: `fetch` подставной. Проверяется разбор ответов —
 * то есть ровно то, из-за чего конвейер однажды примет обрыв связи
 * за отказ в правах и остановится там, где надо было подождать пять минут.
 */

/** Подставной `fetch`, отвечающий заранее заданным. Помнит, о чём спрашивали. */
function stub(reply) {
  const calls = [];
  const doFetch = async (url, init) => {
    calls.push({ url, init });
    if (typeof reply === 'function') return reply(url, init);
    return reply;
  };
  return { doFetch, calls };
}

const answer = (status, text) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => text,
});

/** Сон подставной: настоящие паузы в проверках стоили бы секунд на пустом месте. */
const client = (doFetch) =>
  createTrello({ key: 'k', token: 't', fetch: doFetch, sleep: async () => {} });

describe('виды отказа', () => {
  it('обрыв связи — это offline, а не отказ сервиса', async () => {
    const { doFetch } = stub(() => {
      throw new Error('getaddrinfo ENOTFOUND api.trello.com');
    });
    const result = await client(doFetch).get('boards/x');
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('offline');
    expect(result.why).toContain('ENOTFOUND');
  });

  it('обрыв повторяется трижды, и после третьего сдаёмся', async () => {
    // Замер 28.08.2026: из шести обращений подряд три оборвались
    // по `UND_ERR_CONNECT_TIMEOUT`, и каждый повтор проходил с первого раза.
    // Без повтора цикл на таком обрыве заканчивался, ничего не сделав.
    const { doFetch, calls } = stub(() => {
      throw new Error('fetch failed');
    });
    const result = await client(doFetch).get('boards/x');
    expect(calls).toHaveLength(3);
    expect(result.kind).toBe('offline');
    expect(result.why).toContain('попыток 3');
  });

  it('удавшийся повтор возвращает ответ, а не отказ', async () => {
    let seen = 0;
    const { doFetch, calls } = stub(() => {
      seen += 1;
      if (seen === 1) throw new Error('fetch failed');
      return answer(200, '{"ok":1}');
    });
    const result = await client(doFetch).get('boards/x');
    expect(calls).toHaveLength(2);
    expect(result).toEqual({ ok: true, data: { ok: 1 } });
  });

  it('создающий запрос не повторяется вовсе', async () => {
    // POST у Trello заводит карточку, комментарий, метку. Повтори мы его
    // после потерянного ответа — на доске оказались бы два одинаковых
    // вопроса владельцу продукта, причём второй уже без причины.
    const { doFetch, calls } = stub(() => {
      throw new Error('fetch failed');
    });
    const result = await client(doFetch).post('cards', { name: 'проба' });
    expect(calls).toHaveLength(1);
    expect(result.why).toContain('запрос создающий');
  });

  it('правка и удаление повторяются: они ничего не заводят', async () => {
    const { doFetch, calls } = stub(() => {
      throw new Error('fetch failed');
    });
    await client(doFetch).put('cards/x', { name: 'проба' });
    expect(calls).toHaveLength(3);

    const { doFetch: second, calls: deletions } = stub(() => {
      throw new Error('fetch failed');
    });
    await client(second).delete('cards/x');
    expect(deletions).toHaveLength(3);
  });

  it('отказ сервиса не повторяется: он от повтора не пройдёт', async () => {
    const { doFetch, calls } = stub(answer(401, 'invalid token'));
    await client(doFetch).get('boards/x');
    expect(calls).toHaveLength(1);
  });

  it('предел обращений назван своим именем', async () => {
    const { doFetch } = stub(answer(429, 'API_KEY_LIMIT_EXCEEDED'));
    const result = await client(doFetch).get('boards/x');
    expect(result.kind).toBe('throttled');
  });

  it('отказ сервиса не заминается', async () => {
    const { doFetch } = stub(answer(401, 'invalid token'));
    const result = await client(doFetch).get('boards/x');
    expect(result.kind).toBe('refused');
    expect(result.status).toBe(401);
    expect(result.why).toBe('invalid token');
  });

  it('страница HTML в ответе обрезается до пригодного для журнала', async () => {
    const page = `<!DOCTYPE html><html><body><h1>Bad Request</h1>${'ы'.repeat(500)}</body></html>`;
    const { doFetch } = stub(answer(400, page));
    const result = await client(doFetch).get('boards/x');
    expect(result.why.length).toBeLessThanOrEqual(160);
    expect(result.why).not.toContain('<');
  });

  it('успех с неразборчивым телом — тоже отказ, а не молчаливый undefined', async () => {
    const { doFetch } = stub(answer(200, '{это не json'));
    const result = await client(doFetch).get('boards/x');
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('refused');
  });
});

describe('составление запроса', () => {
  it('ключ и токен подставляются в одном месте', async () => {
    const { doFetch, calls } = stub(answer(200, '{}'));
    await client(doFetch).get('boards/x', { fields: 'name' });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('key')).toBe('k');
    expect(url.searchParams.get('token')).toBe('t');
    expect(url.searchParams.get('fields')).toBe('name');
  });

  it('длинный текст уходит телом, а не строкой адреса', async () => {
    const { doFetch, calls } = stub(answer(200, '{}'));
    const desc = 'я'.repeat(16000);
    await client(doFetch).put('cards/x', { desc });

    expect(calls[0].url.length).toBeLessThan(500);
    expect(JSON.parse(calls[0].init.body).desc).toBe(desc);
  });

  it('пустое тело ответа не считается поломкой', async () => {
    const { doFetch } = stub(answer(200, ''));
    const result = await client(doFetch).delete('cards/x');
    expect(result).toEqual({ ok: true, data: null });
  });
});

describe('чтение картины мира', () => {
  /** Подставной `fetch`, отвечающий по пути запроса. Считает обращения. */
  function board(bodies = {}) {
    const calls = [];
    const doFetch = async (url) => {
      calls.push(url);
      const path = new URL(url).pathname;
      const key = ['lists', 'labels', 'cards', 'actions'].find((name) => path.endsWith(name));
      return answer(200, JSON.stringify(bodies[key] ?? []));
    };
    return { doFetch, calls };
  }

  it('обходится четырьмя запросами, а не запросом на карточку', async () => {
    const { doFetch, calls } = board();
    const result = await readBoard(client(doFetch), 'b');
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('читает колонки вместе с закрытыми: их имена по-прежнему заняты', async () => {
    const { doFetch, calls } = board();
    await readBoard(client(doFetch), 'b');
    const lists = calls.find((url) => url.includes('/lists'));
    expect(new URL(lists).searchParams.get('filter')).toBe('all');
  });

  it('читает карточки вместе с архивными: их номера по-прежнему заняты', async () => {
    // Без этого Trello отдаёт только открытые карточки, и номер закрытой
    // задачи достаётся следующей — вместе с её именем ветки. Поймано
    // переносом: он счёл две закрытые задачи неперенесёнными и завёл
    // им двойники.
    const { doFetch, calls } = board();
    await readBoard(client(doFetch), 'b');
    const cards = calls.find((url) => url.includes('/cards'));
    expect(new URL(cards).searchParams.get('filter')).toBe('all');
  });

  it('приводит комментарии к виду, пригодному для разбора', async () => {
    const { doFetch } = board({
      actions: [
        {
          id: 'a1',
          date: '2026-08-21T10:00:00.000Z',
          data: { text: 'ответ владельца', card: { id: 'c1' } },
        },
      ],
    });
    const result = await readBoard(client(doFetch), 'b');
    expect(result.comments).toEqual([
      { id: 'a1', cardId: 'c1', date: '2026-08-21T10:00:00.000Z', text: 'ответ владельца' },
    ]);
  });

  it('отказ на любом из четырёх называет, что именно не прочиталось', async () => {
    const doFetch = async (url) =>
      url.includes('/labels') ? answer(401, 'invalid token') : answer(200, '[]');
    const result = await readBoard(client(doFetch), 'b');
    expect(result.ok).toBe(false);
    expect(result.what).toBe('метки');
    expect(result.kind).toBe('refused');
  });

  it('обрыв связи остаётся обрывом, а не превращается в отказ', async () => {
    const doFetch = async (url) => {
      if (url.includes('/cards')) throw new Error('ECONNRESET');
      return answer(200, '[]');
    };
    const result = await readBoard(client(doFetch), 'b');
    expect(result.kind).toBe('offline');
    expect(result.what).toBe('карточки');
  });
});

describe('нехватка доступа', () => {
  it('перечисляется вся разом, а не по одной за обращение', () => {
    expect(missingAccess({ key: '', token: '', board: '' })).toHaveLength(3);
  });

  it('при полном доступе пуста', () => {
    expect(missingAccess({ key: 'k', token: 't', board: 'b' })).toEqual([]);
  });

  it('называет недостающее поимённо', () => {
    expect(missingAccess({ key: 'k', token: '', board: 'b' })).toEqual(['TRELLO_TOKEN']);
  });
});
