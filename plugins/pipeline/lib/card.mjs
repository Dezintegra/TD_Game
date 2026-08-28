/**
 * Превращение карточки Trello в задачу и обратно.
 *
 * Чистый счёт: ни сети, ни времени «сейчас» изнутри. Причина та же, по
 * которой чист сканер, — разбор карточки выполняется на каждую задачу
 * каждый цикл, и он обязан давать одинаковый ответ при одинаковой карточке.
 *
 * Разделение труда между человеком и конвейером проходит по описанию
 * карточки. Всё, что выше машинного блока, принадлежит человеку целиком:
 * конвейер этот текст читает, но не переписывает. Всё, что внутри блока, —
 * его собственные отметки, и человеку их видеть незачем.
 */

/** Границы машинного блока. HTML-комментарий: markdown его не показывает. */
const BLOCK_OPEN = '<!-- pipeline';
const BLOCK_CLOSE = '-->';

/**
 * Заголовок раздела, в котором владелец продукта пишет ожидание от прогона.
 *
 * Буквы перечислены явно: `\w` в JavaScript кириллицы не знает вовсе,
 * и `ожидаем\w*` не совпадает даже с «ожидаемый». Заголовок при этом
 * пишет человек, и требовать от него точного слова нельзя.
 */
const EXPECTATION_HEADING = /^#{1,6}\s*ожида[а-яё]*\s+результат\w*\s*$/i;

/**
 * Разделить описание карточки на человеческий текст и машинные отметки.
 *
 * Блока нет или он испорчен — это не беда, а обычное состояние карточки,
 * только что заведённой человеком. Тогда отметок просто нет, а весь текст
 * принадлежит человеку.
 */
export function splitDescription(desc = '') {
  const open = desc.indexOf(BLOCK_OPEN);
  if (open === -1) return { human: desc.trim(), meta: null };

  const close = desc.indexOf(BLOCK_CLOSE, open);
  if (close === -1) return { human: desc.slice(0, open).trim(), meta: null };

  const inner = desc.slice(open + BLOCK_OPEN.length, close).trim();
  const human = (desc.slice(0, open) + desc.slice(close + BLOCK_CLOSE.length)).trim();

  try {
    return { human, meta: JSON.parse(inner) };
  } catch {
    // Испорченный блок не притворяется пустым: потерять здесь владельца
    // задачи значило бы отдать её второй машине.
    return { human, meta: null, broken: true };
  }
}

/** Собрать описание обратно: человеческий текст, ниже — машинный блок. */
export function joinDescription(human, meta) {
  const block = `${BLOCK_OPEN}\n${JSON.stringify(meta)}\n${BLOCK_CLOSE}`;
  return human ? `${human.trim()}\n\n${block}` : block;
}

/**
 * Когда карточка заведена.
 *
 * Первые восемь знаков идентификатора Trello — это время создания
 * в секундах. Хранить отметку заведения отдельно поэтому незачем: она
 * уже есть, и подделать её правкой описания нельзя.
 */
export function createdAtOf(cardId) {
  const seconds = Number.parseInt(String(cardId).slice(0, 8), 16);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

/** Ожидаемый результат прогона — раздел описания, а не служебное поле. */
export function expectationOf(human) {
  const lines = human.split('\n');
  const at = lines.findIndex((line) => EXPECTATION_HEADING.test(line));
  if (at === -1) return null;

  const rest = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    rest.push(line);
  }
  const text = rest.join('\n').trim();
  return text.length > 0 ? text : null;
}

/**
 * Название карточки без служебного префикса с идентификатором.
 *
 * Префикс — удобство для человека, а не хранилище: истиной служит поле
 * в машинном блоке. Поэтому здесь он просто срезается, а не разбирается.
 */
export function titleOf(name = '') {
  return name.replace(/^\s*\d{4}-[a-z0-9-]+\s*[·—–-]\s*/i, '').trim();
}

/** Название карточки с префиксом: так задача узнаётся взглядом на доску. */
export const nameWithId = (id, title) => (id ? `${id} · ${title}` : title);

/**
 * Разобрать карточку в задачу.
 *
 * Задача получается той же формы, что и прежняя запись бэклога: счётная
 * часть конвейера о Trello не знает и знать не должна.
 *
 * @param {object} card карточка Trello
 * @param {object} ctx  `{ stateByList, labelKeyById }`
 */
export function parseCard(card, { stateByList, labelKeyById }) {
  const { human, meta, broken } = splitDescription(card.desc ?? '');
  const labels = labelKeys(card.idLabels ?? [], labelKeyById);

  const task = {
    id: meta?.id ?? null,
    type: labels.types[0] ?? null,
    title: titleOf(card.name),
    description: human,
    status: stateByList.get(card.idList) ?? null,
    // Приоритет — положение карточки в колонке. Отдельного поля нет
    // намеренно: число и положение разошлись бы при первом перетаскивании.
    priority: card.pos ?? null,
    createdAt: createdAtOf(card.id),
    statusChangedAt: meta?.statusChangedAt ?? createdAtOf(card.id),
    owner: meta?.owner ?? null,
    returnTo: meta?.returnTo ?? null,
    links: { change: null, pr: null, run: null, related: [], ...(meta?.links ?? {}) },
    attempts: { continuations: 0, cycleFailures: 0, ...(meta?.attempts ?? {}) },
    history: [],
  };

  if (task.type === 'run') {
    task.run = { kind: labels.runKinds[0] ?? null, expectation: expectationOf(human) };
  }

  return {
    task,
    card: {
      id: card.id,
      name: card.name,
      human,
      metaBroken: Boolean(broken),
      types: labels.types,
      runKinds: labels.runKinds,
      flags: labels.flags,
    },
  };
}

/**
 * Разложить метки карточки по назначению.
 *
 * Меток на карточке может не быть вовсе, а может оказаться две одного
 * назначения. Ни то, ни другое здесь не лечится: разбор только называет
 * увиденное, а решает проверка карточки.
 */
function labelKeys(idLabels, labelKeyById) {
  const keys = idLabels.map((id) => labelKeyById.get(id)).filter(Boolean);

  return {
    types: keys.filter((key) => ['feature', 'run', 'note'].includes(key)),
    runKinds: keys.filter((key) => ['arena', 'perf', 'bench-tick'].includes(key)),
    flags: keys.filter((key) => ['unparsed', 'overdue'].includes(key)),
  };
}

/**
 * Машинные отметки задачи — то, что уедет в блок описания.
 *
 * История переходов сюда НЕ входит: она живёт комментариями карточки.
 * Поле переписывается, комментарий дозаписывается, а журнал обязан
 * дозаписываться — это его главное свойство.
 */
export function metaOf(task) {
  return {
    id: task.id,
    owner: task.owner ?? null,
    returnTo: task.returnTo ?? null,
    statusChangedAt: task.statusChangedAt,
    links: task.links ?? { change: null, pr: null, run: null, related: [] },
    attempts: task.attempts ?? { continuations: 0, cycleFailures: 0 },
  };
}
