import { MAX_TEXT } from './trello.mjs';

/**
 * Журнал задачи комментариями карточки.
 *
 * Журнал обязан дозаписываться и никогда не переписываться — это его
 * главное свойство. Комментарий Trello ровно таков: его нельзя изменить
 * задним числом незаметно, и дату Trello проставляет сам.
 *
 * Отсюда же и разбиение длинных записей. Предел Trello — 16384 знака,
 * измерено пробой; запись о падении вместе с куском лога переваливает его
 * легко. Усечение запрещено: обрезанный лог бесполезен ровно в том случае,
 * ради которого его и писали.
 */

/**
 * Кто написал запись.
 *
 * Автор комментария в Trello этого не расскажет: конвейер пишет под одним
 * пользователем, и запись сессии-исполнителя выглядит там ровно так же,
 * как запись самого супервизора. Разница же существенная. Сессия говорит
 * о работе — что сделано и почему так решено; супервизор говорит о ходе
 * конвейера — взял, выдал сессию, остановил, прибрал. Читающий доску
 * должен различать их с одного взгляда, поэтому источник и стоит
 * в начале строки, сразу за пометкой.
 */
export const SOURCE_TAGS = {
  agent: '[agent]',
  supervisor: '[supervisor]',
};

/**
 * Источник по умолчанию — супервизор.
 *
 * Не из вежливости к нему, а потому, что записи в Trello делает именно он:
 * сессия к доске не прикасается вовсе, она возвращает отчёт. Значит
 * неразмеченная запись — почти наверняка его собственная, и такой дефолт
 * ошибается реже любого другого.
 */
const DEFAULT_SOURCE = 'supervisor';

/** Приставка комментария: пометка конвейера, следом источник записи. */
export function prefixOf(marker, source = DEFAULT_SOURCE) {
  return `${marker} ${SOURCE_TAGS[source] ?? SOURCE_TAGS[DEFAULT_SOURCE]}`;
}

/**
 * Сколько знаков резервируется под заголовок части.
 *
 * ` (часть 10 из 12)` плюс два перевода строки — с запасом; длина самой
 * приставки прибавляется к этому отдельно, потому что теги источника
 * разной длины. Резерв считается один на все части, чтобы разбиение
 * не зависело от того, сколько частей получится: иначе счёт зациклится
 * сам на себе.
 */
const HEADER_RESERVE = 26;

/**
 * Разбить запись журнала на комментарии.
 *
 * Разрыв идёт по строкам: разрезанная посередине строка лога нечитаема,
 * а склеивать её обратно глазами придётся человеку. Строка, сама по себе
 * не помещающаяся в предел, режется по знакам — иначе её было бы вовсе
 * не опубликовать.
 *
 * @param {string} text  запись журнала
 * @param {object} params
 * @param {string} params.marker пометка конвейера
 * @param {string} [params.source] кто написал: `agent` либо `supervisor`
 * @param {number} [params.limit] предел длины комментария
 * @returns {string[]} комментарии в порядке публикации
 */
export function splitJournalEntry(text, { marker, source, limit = MAX_TEXT }) {
  const prefix = prefixOf(marker, source);
  const whole = `${prefix} ${text}`;
  if (whole.length <= limit) return [whole];

  const room = limit - prefix.length - HEADER_RESERVE;
  const chunks = [];
  let current = '';

  const flush = () => {
    if (current !== '') chunks.push(current);
    current = '';
  };

  for (const line of text.split('\n')) {
    // Строка, не помещающаяся целиком, режется по знакам: иначе её
    // не опубликовать вовсе.
    if (line.length > room) {
      flush();
      for (let at = 0; at < line.length; at += room) chunks.push(line.slice(at, at + room));
      continue;
    }

    const candidate = current === '' ? line : `${current}\n${line}`;
    if (candidate.length > room) {
      flush();
      current = line;
    } else {
      current = candidate;
    }
  }
  flush();

  const total = chunks.length;
  return chunks.map((chunk, index) => `${prefix} (часть ${index + 1} из ${total})\n\n${chunk}`);
}

/**
 * Склеить части обратно — тем же способом, каким их разбивали.
 *
 * Нужно затем, что журнал читают не только глазами: сессия-исполнитель
 * получает историю задачи и должна видеть её целой, а не в кусках.
 */
export function joinJournalParts(comments, { marker }) {
  return comments
    .map((text) => stripMarker(text, marker))
    .join('\n')
    .trim();
}

/**
 * Снять служебную приставку, оставив саму запись.
 *
 * Приставка — это пометка конвейера, необязательный тег источника
 * и необязательный заголовок части. Необязательны оба намеренно:
 * на доске лежат комментарии, написанные до появления тегов, и читать
 * их конвейер обязан по-прежнему — иначе журнал старых задач пришёл бы
 * в следующую сессию с мусором в первой строке каждой записи.
 */
export function stripMarker(text, marker) {
  const head = new RegExp(
    `^${escapeForRegExp(marker)}\\s*(?:\\[[^\\]\\n]*\\]\\s*)?(?:\\(часть \\d+ из \\d+\\)\\s*\\n+)?`,
  );
  const found = head.exec(text);
  return found ? text.slice(found[0].length) : text;
}

/** Экранировать пометку: в ней может оказаться что угодно, включая скобки. */
function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Написан ли комментарий конвейером.
 *
 * Различить по автору нельзя: конвейер и человек пишут под одним и тем же
 * пользователем Trello — токен-то один. Отсюда и пометка. Без неё конвейер
 * принял бы собственный вопрос за ответ на него же и вернул бы задачу
 * в работу, ничего не спросив.
 */
export const isOurs = (text, marker) => String(text ?? '').startsWith(marker);

/**
 * Найти ответ владельца продукта.
 *
 * Ответом считается первый комментарий без пометки, появившийся после
 * того, как задача ушла в ожидание. Первый, а не последний: владелец
 * продукта мог ответить и дописать пояснение, и терять первую, главную
 * часть ответа нельзя.
 *
 * Отметка `since` — это время перехода в ожидание. Комментарии, лежавшие
 * на карточке раньше, ответом не считаются: обсуждение задачи могло идти
 * и до вопроса.
 *
 * @param {Array} comments комментарии карточки: `{ date, text }`
 * @param {object} params `{ marker, since }`
 * @returns {{ text: string, at: string }|null}
 */
export function findAnswer(comments, { marker, since }) {
  const after = Date.parse(since);
  const answers = comments
    .filter((comment) => !isOurs(comment.text, marker))
    .filter((comment) => String(comment.text ?? '').trim() !== '')
    .filter((comment) => !Number.isFinite(after) || Date.parse(comment.date) > after)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

  const first = answers[0];
  return first ? { text: first.text.trim(), at: first.date } : null;
}
