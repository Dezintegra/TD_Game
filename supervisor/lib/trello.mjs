import { setTimeout as wait } from 'node:timers/promises';

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
 * Сколько раз пробовать запрос, оборвавшийся на сети.
 *
 * Три, и число это взято не с потолка. Замер 28.08.2026 на этой станции:
 * из шести обращений подряд три оборвались по `UND_ERR_CONNECT_TIMEOUT` —
 * соединение не устанавливалось вовсе, — и каждый повтор проходил с первого
 * раза. Похоже на медленное первое соединение из свежего процесса.
 *
 * Без повтора цикл на таком обрыве печатал «доска недоступна» и заканчивался,
 * ничего не сделав. Смертельным это не было — через пять минут он приходил
 * снова, — но примерно половина циклов уходила впустую.
 */
const ATTEMPTS = 3;

/**
 * Пауза перед повтором, миллисекунды.
 *
 * Растёт, чтобы не долбиться в закрытую дверь: если Trello правда лежит,
 * три запроса подряд ему не помогут, а вот медленному соединению лишние
 * триста миллисекунд как раз хватает.
 */
const BACKOFF = [300, 900];

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
export function createTrello({
  key,
  token,
  fetch: doFetch = globalThis.fetch,
  sleep = (ms) => wait(ms),
}) {
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

    // Повторяется только то, что можно повторить без последствий.
    //
    // Обрыв на сети двусмыслен: запрос мог не уйти вовсе, а мог уйти
    // и потерять ответ. Для чтения и правки разницы нет — второе такое же
    // чтение вернёт то же, а повторная запись того же значения ничего
    // не меняет. А вот POST у Trello заводит: карточку, комментарий, метку.
    // Повтори мы его после потерянного ответа — и на доске окажутся два
    // одинаковых вопроса владельцу продукта, причём второй уже без причины.
    //
    // Наблюдаемая беда — обрыв на ПЕРВОМ обращении цикла, а первое
    // обращение всегда чтение доски. Так что запрет на повтор создающих
    // запросов ничего не стоит и снимает весь риск.
    const mayRetry = method !== 'POST';
    const attempts = mayRetry ? ATTEMPTS : 1;

    let response = null;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        response = await doFetch(url.toString(), {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await sleep(BACKOFF[attempt - 1] ?? BACKOFF.at(-1));
      }
    }

    if (lastError) {
      const tried = attempts > 1 ? `, попыток ${attempts}` : ', без повтора: запрос создающий';
      return {
        ok: false,
        kind: 'offline',
        why: `${lastError?.message ?? String(lastError)}${tried}`,
      };
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
    // `filter: all` — вместе с архивными. Без него Trello отдаёт только
    // открытые карточки, и номера закрытых задач перестают считаться
    // занятыми: следующая задача получит номер давно закрытой, а с ним
    // и её имя ветки. Обнаружено переносом — он счёл две закрытые задачи
    // неперенесёнными и завёл им двойники.
    trello.get(`boards/${board}/cards`, {
      fields: 'name,desc,idList,idLabels,pos,closed',
      filter: 'all',
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
