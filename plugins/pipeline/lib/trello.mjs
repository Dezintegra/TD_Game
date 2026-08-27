/**
 * Обращение к Trello.
 *
 * Единственное место, где конвейер ходит в сеть за бэклогом. Решений здесь
 * не принимается — как и в остальном переходнике к настоящему миру.
 *
 * Ошибка возвращается ответом, а не исключением. Причина та же, по которой
 * так устроен декодер сетевого протокола: данные приходят из недоверенного
 * источника, а вызывающему нужно записать причину в журнал и жить дальше,
 * а не ловить исключение через три уровня вверх.
 *
 * Виды отказа различаются, потому что лечатся они по-разному:
 *
 * - `offline` — до Trello не достучались вовсе. Цикл пропускается, счётчик
 *   неудач не растёт: обрыв связи на пять минут дело обычное, и глушить
 *   из-за него конвейер до вмешательства человека нельзя.
 * - `throttled` — превышен предел обращений. Тоже пропуск цикла, но причина
 *   своя и в журнале должна быть названа своим именем.
 * - `refused` — Trello ответил отказом: нет прав, нет карточки, негодное
 *   значение. Это уже настоящая беда, и заминать её нельзя.
 */

/** Предел длины текста у Trello. Измерен пробой: 16385 знаков уже отвергается. */
export const MAX_TEXT = 16384;

/**
 * Собрать клиента.
 *
 * `fetch` принимается доводом, а не берётся из окружения: тесты подставляют
 * свой и проверяют разбор ответов без всякой сети.
 *
 * @param {object} params
 * @param {string} params.key   ключ приложения
 * @param {string} params.token токен пользователя
 * @param {typeof globalThis.fetch} [params.fetch] исполнитель запросов
 */
export function createTrello({ key, token, fetch: doFetch = globalThis.fetch }) {
  /**
   * Один запрос.
   *
   * Тело уходит именно телом, а не строкой адреса. Первая проба посылала
   * длинное описание параметром и получала `414 URI Too Long` — предел
   * длины адреса, ничего общего с пределами Trello не имеющий. На теле
   * же проходит всё до 16384 знаков.
   */
  async function call(method, path, { query = {}, body = null } = {}) {
    const url = new URL(`https://api.trello.com/1/${path}`);
    url.searchParams.set('key', key);
    url.searchParams.set('token', token);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.append(name, String(value));
    }

    let response;
    try {
      response = await doFetch(url.toString(), {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      return { ok: false, kind: 'offline', why: error?.message ?? String(error) };
    }

    const text = await response.text().catch(() => '');

    if (response.status === 429) {
      return { ok: false, kind: 'throttled', status: 429, why: 'превышен предел обращений' };
    }
    if (!response.ok) {
      return { ok: false, kind: 'refused', status: response.status, why: shorten(text) };
    }

    if (text === '') return { ok: true, data: null };
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: false, kind: 'refused', status: response.status, why: 'ответ не разобрался' };
    }
  }

  return {
    get: (path, query) => call('GET', path, { query }),
    post: (path, body, query) => call('POST', path, { body, query }),
    put: (path, body, query) => call('PUT', path, { body, query }),
    delete: (path, query) => call('DELETE', path, { query }),
  };
}

/**
 * Обрезать ответ об отказе до пригодного для журнала.
 *
 * Trello на часть отказов отвечает целой страницей HTML, и класть её
 * в журнал цикла целиком незачем: разобрать причину по ней всё равно
 * нельзя, а прочие записи она утопит.
 */
function shorten(text) {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * Прочитать картину мира одним заходом.
 *
 * Четыре запроса — колонки, метки, карточки, комментарии — уходят разом,
 * а не по очереди: по очереди они стоили бы секунды, а разом отвечают
 * за треть секунды, и холостой цикл остаётся дешёвым.
 *
 * Пакетное чтение Trello (`/1/batch`) пробовалось и отвергнуто: адреса
 * перечисляются в нём через запятую, а запятые есть и внутри параметров —
 * `fields=name,closed`. Четыре запроса развалились на десять кусков,
 * половина из которых пустые. Выигрыша при этом никакого: пакет ответил
 * за 438 мс против 357 мс у четвёрки разом.
 *
 * Колонки читаются вместе с закрытыми: закрытая колонка — это не
 * отсутствующая, и её имя по-прежнему занято.
 */
export async function readBoard(trello, board) {
  const [lists, labels, cards, comments] = await Promise.all([
    trello.get(`boards/${board}/lists`, { filter: 'all', fields: 'name,closed' }),
    trello.get(`boards/${board}/labels`, { fields: 'name,color', limit: 50 }),
    trello.get(`boards/${board}/cards`, {
      fields: 'name,desc,idList,idLabels,pos,closed',
      limit: 1000,
    }),
    // Комментарии всей доски разом, а не по карточке: карточек десятки,
    // и запрос на каждую съел бы предел обращений за один цикл.
    trello.get(`boards/${board}/actions`, { filter: 'commentCard', limit: 1000 }),
  ]);

  for (const [what, result] of [
    ['колонки', lists],
    ['метки', labels],
    ['карточки', cards],
    ['комментарии', comments],
  ]) {
    if (!result.ok) return { ...result, what };
  }

  return {
    ok: true,
    lists: lists.data,
    labels: labels.data,
    cards: cards.data,
    comments: comments.data.map((action) => ({
      id: action.id,
      cardId: action.data?.card?.id ?? null,
      date: action.date,
      text: action.data?.text ?? '',
    })),
  };
}

/**
 * Чего не хватает, чтобы обратиться к доске.
 *
 * Проверяется до первого запроса и разом: сказать «нет токена» после
 * успешного чтения колонок значило бы потратить обращение впустую и сбить
 * с толку — беда-то была известна с самого начала.
 */
export function missingAccess({ key, token, board }) {
  const missing = [];
  if (!key) missing.push('TRELLO_KEY');
  if (!token) missing.push('TRELLO_TOKEN');
  if (!board) missing.push('идентификатор доски в настройке проекта (trello.board)');
  return missing;
}
