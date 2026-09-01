/**
 * Отчёт этапа из его же ответа.
 *
 * Прежде отчёт был файлом в `.pipeline/reports/`, и это тянуло за собой
 * обход всех рабочих деревьев: сессия с деревом физически не могла положить
 * файл в основное. Теперь ответ приходит туда же, откуда пришёл вопрос,
 * и искать его негде — он один.
 *
 * Разбор нарочно терпимый. Требовать, чтобы весь ответ был одним объектом,
 * значило бы объявлять неудавшимся этап, добавивший к отчёту строку
 * пояснения, — а он её добавит, и не всегда одну. Поэтому ищем объект
 * в тексте, а не сверяем текст с объектом.
 */

/** Обязательное у отчёта. Без этого его нельзя применить, только отвергнуть. */
const REQUIRED = ['taskId', 'stage', 'outcome'];

/**
 * Достать отчёт из ответа этапа.
 *
 * @param {string} text последний ответ сессии
 * @returns {{ report: object|null, why: string|null }}
 */
export function parseReport(text) {
  const candidates = jsonObjects(String(text ?? ''));
  if (candidates.length === 0) {
    return { report: null, why: 'в ответе нет ни одного объекта JSON' };
  }

  // Берём ПОСЛЕДНИЙ годный, а не первый. Этап вполне может показать по пути
  // образец, кусок карточки или разобранный ответ чужой команды; отчётом
  // он заканчивает, потому что так ему велено.
  const complete = candidates.filter((value) => REQUIRED.every((key) => value?.[key] != null));
  if (complete.length > 0) return { report: complete.at(-1), why: null };

  return {
    report: null,
    why: `в ответе есть JSON, но в нём нет обязательных полей: ${REQUIRED.join(', ')}`,
  };
}

/**
 * Все объекты JSON верхнего уровня, какие удалось разобрать.
 *
 * Скобки считаются с оглядкой на строки и экранирование: без этого первая же
 * фигурная скобка внутри строки — а в отчёте это, например, шаблон имени
 * ветки — обрывала бы объект на середине.
 */
function jsonObjects(text) {
  const found = [];

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    const end = matchingBrace(text, i);
    if (end === -1) continue;

    try {
      found.push(JSON.parse(text.slice(i, end + 1)));
      // Разобравшийся объект пропускаем целиком: вложенные в него скобки
      // отдельными объектами не считаются, иначе `links` внутри отчёта
      // оказался бы кандидатом наравне с самим отчётом.
      i = end;
    } catch {
      // Не разобралось — это не объект, а похожий на него текст. Идём дальше:
      // настоящий отчёт может лежать ниже.
    }
  }

  return found;
}

/** Где закрывается скобка, открытая в позиции `start`. */
function matchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}
