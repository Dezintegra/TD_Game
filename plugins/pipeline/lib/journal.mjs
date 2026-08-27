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
 */
export function journalEntry({ at, from, to, what, decisions = [], links = {}, problem }) {
  const lines = [`## ${at} · ${from} → ${to}`, ''];

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
