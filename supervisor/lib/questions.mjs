/**
 * Вопросы владельцу продукта: запись, чтение и ответ.
 *
 * До сих пор этого файла плагин только КАСАЛСЯ на чтение. Вопрос никто
 * не писал: сессия завершалась с исходом `question`, задача уходила
 * в `awaiting-po`, а раздел, в котором ждут ответа, не появлялся нигде.
 * Выхода из этого состояния при этом ровно один — ответ в том самом
 * разделе, — так что задача застревала навсегда, а владелец продукта
 * видел пустой файл и не знал, что его ждут.
 *
 * Найдено сплошным разбором конвейера 27.08.2026 тремя независимыми
 * взглядами сразу и подтверждено поиском по всему плагину.
 *
 * Формат раздела задан не здесь, а разбором в `read-state.readAnswers`:
 * разделы вида `### <идентификатор>`, ответом считается непустой текст
 * после пометки `**Ответ:**`. Сборка обязана попадать в этот разбор
 * ровно, поэтому проверки держат их вместе.
 */

/** Пометка, после которой начинается ответ владельца продукта. */
export const ANSWER_MARK = '**Ответ:**';

/** Заголовок, под который дописываются новые вопросы. */
const OPEN_SECTION = '## Открытые вопросы';

/**
 * Собрать раздел вопроса.
 *
 * Варианты берутся из `decisions` отчёта: сессиям велено класть туда
 * прочтения с последствиями и свою рекомендацию. Вопрос без вариантов
 * владельцу продукта не задают — выбирать из пустоты дороже, чем
 * из двух названных зол, — поэтому пустой перечень оговаривается вслух,
 * а не прячется.
 */
export function renderQuestion({ taskId, askedAt, returnTo, summary, decisions = [] }) {
  const lines = [
    `### ${taskId}`,
    '',
    `- **Спрошено:** ${askedAt}`,
    `- **Задача вернётся в:** ${returnTo ?? 'неизвестно'}`,
    '',
    summary?.trim() || 'Сессия не назвала сути вопроса — смотрите журнал задачи.',
    '',
  ];

  if (decisions.length > 0) {
    for (const item of decisions) lines.push(`- ${item}`, '');
  } else {
    lines.push(
      '**Вариантов сессия не назвала.** Это нарушение её же указаний: ' +
        'вопрос без вариантов задавать не велено. Смотрите журнал задачи ' +
        'и решайте по нему.',
      '',
    );
  }

  lines.push(ANSWER_MARK, '');
  return lines.join('\n');
}

/**
 * Дописать вопрос в файл.
 *
 * Дописывается в конец, а не в начало: отвеченные вопросы остаются
 * на месте, по ним восстанавливают ход рассуждения, и переставлять их
 * значило бы ломать эту летопись. Заголовка «Открытые вопросы» может
 * не оказаться вовсе — тогда вопрос всё равно не теряется, просто едет
 * в самый конец.
 */
export function appendQuestion(text, block) {
  const body = text ?? '';
  const separator = body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n';
  return `${body}${separator}${block}`;
}

/** Есть ли в файле заголовок открытых вопросов. Нужен только для внятной жалобы. */
export const hasOpenSection = (text) => (text ?? '').includes(OPEN_SECTION);

/**
 * Разделы файла по идентификатору задачи.
 *
 * Разбор тот же, что в `read-state.readAnswers`, и это не совпадение:
 * писать и читать один файл двумя разными разборами — верный способ
 * однажды разойтись.
 */
function sections(text) {
  return (text ?? '')
    .split(/^### /m)
    .slice(1)
    .map((section) => {
      const cut = section.indexOf('\n');
      return { id: section.slice(0, cut === -1 ? undefined : cut).trim(), body: section };
    });
}

/**
 * Вопросы, на которые ещё не ответили.
 *
 * Порядок сохраняется тот же, что в файле: спрошенный раньше и отвечается
 * раньше. Сессия-спрашивающая берёт первый и не выбирает.
 */
export function pendingQuestions(text) {
  return sections(text)
    .filter(({ body }) => {
      const marker = body.indexOf(ANSWER_MARK);
      if (marker === -1) return false;
      return body.slice(marker + ANSWER_MARK.length).trim().length === 0;
    })
    .map(({ id, body }) => ({ id, body: body.trim() }));
}

/**
 * Записать ответ в раздел задачи.
 *
 * Ответ дописывается после пометки, а не вместо неё: пометка — часть
 * летописи, по ней потом видно, что раздел вообще был вопросом.
 *
 * Возвращает `null`, если раздела нет или ответ в нём уже стоит. Тихо
 * перезаписать чужой ответ хуже, чем отказаться: ответы владельца
 * продукта — единственное, что конвейер в этот файл не пишет сам.
 */
export function recordAnswer(text, taskId, answer) {
  const clean = String(answer ?? '').trim();
  if (!clean) return null;

  const found = sections(text).find((section) => section.id === taskId);
  if (!found) return null;

  const marker = found.body.indexOf(ANSWER_MARK);
  if (marker === -1) return null;
  if (found.body.slice(marker + ANSWER_MARK.length).trim().length > 0) return null;

  const head = `### ${found.body.slice(0, marker + ANSWER_MARK.length)}`;
  const tail = found.body.slice(marker + ANSWER_MARK.length);
  const filled = `${head} ${clean}\n${tail.replace(/^\s*/, '')}`;

  return text.replace(`### ${found.body}`, filled);
}
