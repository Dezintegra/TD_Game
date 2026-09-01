import { describeDenial } from './denials.mjs';

/**
 * Журнал задачи: дозаписываемая история, а не переписываемый документ.
 *
 * По журналу восстанавливают ход рассуждения — как по телу коммита. Поэтому
 * запись отвечает не на вопрос «что стало», который и так виден в файле
 * задачи, а на вопрос «что сделано и почему так решено».
 *
 * Дозапись, а не перезапись, выбрана из двух соображений. Во-первых, историю
 * не подчищают задним числом: неудачный этап остаётся в журнале и объясняет,
 * почему следующая сессия сделала иначе. Во-вторых, перезапись файла целиком
 * приносила бы правки в чужих строках при каждом коммите конвейера.
 */

/** Заголовок журнала заводится один раз при первой записи. */
export const journalHeader = (task) =>
  [
    `# ${task.id} — ${task.title}`,
    '',
    `Тип: ${task.type}. Заведена: ${task.createdAt}.`,
    '',
    'Дозаписываемая история задачи. Не переписывается: по ней восстанавливают',
    'ход рассуждения, а не текущее состояние — текущее лежит в файле задачи.',
    '',
    '',
  ].join('\n');

/**
 * Одна запись журнала.
 *
 * @param {object} entry
 * @param {string} entry.at        когда сменилось состояние
 * @param {string} entry.from      прежнее состояние
 * @param {string} entry.to        новое состояние
 * @param {string} [entry.what]    что сделано на этапе
 * @param {string[]} [entry.decisions] принятые решения с обоснованием
 * @param {object} [entry.links]   ссылки на артефакты
 * @param {string} [entry.problem] причина, если этап не удался
 * @param {object[]} [entry.denials] действия, отвергнутые проверкой разрешений
 * @param {string} [entry.denialsNote] отметка, когда сверить отказ с делом нечем
 */
export function journalEntry(entry) {
  return [`## ${entry.at} · ${entry.from} → ${entry.to}`, '', journalBody(entry)].join('\n');
}

/**
 * Тело записи без заголовка со временем.
 *
 * Нужно доске: комментарий Trello датируется сам, и вторая отметка времени
 * в его первой строке только мешала бы читать.
 */
export function journalBody({
  what,
  decisions = [],
  links = {},
  problem,
  denials = [],
  denialsNote,
}) {
  const lines = [];

  if (what) lines.push(what, '');

  if (problem) {
    lines.push(`**Не удалось:** ${problem}`, '');
  }

  if (decisions.length > 0) {
    lines.push('**Решения:**', '');
    for (const decision of decisions) lines.push(`- ${decision}`);
    lines.push('');
  }

  const named = Object.entries(links).filter(([, value]) => value != null && value !== '');
  if (named.length > 0) {
    lines.push('**Артефакты:**', '');
    for (const [key, value] of named) lines.push(`- ${key}: ${value}`);
    lines.push('');
  }

  // Отказы едут ИМЕННО СЮДА, а не только в журнал цикла и лог этапа.
  // Журнал задачи уезжает в промпт следующей сессии, а журнал цикла
  // не уезжает никуда — и потому единственная заметность отказа, которую
  // видит работа, живёт здесь.
  //
  // Доводы вызова печатаются целиком: именно они показывают, какое правило
  // разрешений не дописано. Длину сторожит разбиение записи на комментарии.
  if (denials.length > 0) {
    lines.push('**Отказано в действиях:**', '');
    for (const denial of denials) lines.push(`- ${describeDenial(denial)}`);
    if (denialsNote) lines.push(`- ${denialsNote}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Что дописать в журнал: заголовок, если журнала ещё нет, и саму запись.
 *
 * Возвращает текст для дозаписи, а не пишет сам: работа с диском живёт
 * в одном месте, и это не здесь.
 */
export function journalAppendix(task, existing, entry) {
  const head = existing && existing.trim().length > 0 ? '' : journalHeader(task);
  return head + journalEntry(entry);
}
