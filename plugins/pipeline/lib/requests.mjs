/**
 * Заявки на новые задачи.
 *
 * Сессии не правят бэклог: разбор замечания и прогон, обнаружив, что нужна
 * новая работа, перечисляют её заявками в отчёте. Заводит задачи оркестратор.
 *
 * Без этого разбора этап `triage` работал бы вхолостую: заявки уезжали бы
 * в журнал закрытой записи и там оставались. Дыру нашла сверка скиллов
 * с кодом — скиллы обещали то, чего в коде не было.
 */

/** Слаг для идентификатора: только строчные буквы, цифры и дефисы. */
export function slugify(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug.length > 0 ? slug : 'zadacha';
}

/**
 * Транслитерация: идентификатор служит именем ветки и каталога, а кириллица
 * в них — источник неприятностей на ровном месте.
 */
const LETTERS = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

export const translit = (text) =>
  String(text ?? '')
    .toLowerCase()
    .split('')
    .map((char) => LETTERS[char] ?? char)
    .join('');

/**
 * Следующий свободный идентификатор.
 *
 * Номер берётся на единицу больше самого большого занятого — включая номера
 * уже закрытых задач: идентификатор после закрытия не переиспользуется,
 * иначе имя ветки однажды совпадёт с именем давно убранной.
 */
export function nextId(existingIds, title) {
  const numbers = existingIds
    .map((id) => Number.parseInt(String(id).slice(0, 4), 10))
    .filter((n) => !Number.isNaN(n));
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  return `${String(next).padStart(4, '0')}-${slugify(translit(title))}`;
}

/**
 * Собрать запись бэклога из заявки.
 *
 * Заявка приходит из отчёта сессии, то есть из недоверенного по сути места:
 * поля проверяются, лишнее отбрасывается, недостающее заполняется разумным.
 * Негодную заявку лучше отвергнуть с причиной, чем завести задачу, которую
 * никто не сможет истолковать.
 */
export function taskFromRequest(request, { id, now, sourceId }) {
  const problems = [];

  const type = ['feature', 'run', 'note'].includes(request?.type) ? request.type : null;
  if (!type) problems.push(`неизвестный тип заявки «${request?.type}»`);

  const title = String(request?.title ?? '').trim();
  if (!title) problems.push('в заявке нет заголовка');

  const description = String(request?.description ?? '').trim();
  if (!description) problems.push('в заявке нет описания');

  if (type === 'run' && !String(request?.run?.expectation ?? '').trim()) {
    problems.push('прогон заявлен без ожидаемого результата');
  }

  if (problems.length > 0) return { task: null, problems };

  const priority = Number.isInteger(request.priority) ? request.priority : 50;

  const task = {
    $schema: '../schema.json',
    id,
    type,
    title: title.slice(0, 200),
    description,
    // Заявка агента — предложение, а не решение, и ждёт владельца продукта
    // в кандидатах. Прежде она заводилась сразу в работу: агент заводил
    // себе работу сам, а человек узнавал об этом, когда задача уже шла
    // по маршруту.
    //
    // Прогон — исключение, и единственное. Он заводится не потому, что так
    // придумал агент, а потому что правило требует замера при вливании
    // правки, задевшей правила игры. Решение принято раньше и не им.
    // Задержись прогон в шлюзе — в главную ветку уедет правка баланса
    // без заказанного замера, то есть ровно тот тихий сдвиг, от которого
    // правило и стоит.
    status: type === 'run' ? 'new' : 'candidate',
    returnTo: null,
    priority: Math.min(999, Math.max(0, priority)),
    createdAt: now,
    statusChangedAt: now,
    owner: null,
    history: [],
    links: { change: null, pr: null, run: null, related: sourceId ? [sourceId] : [] },
    attempts: { continuations: 0, cycleFailures: 0 },
  };

  if (type === 'run') {
    task.run = {
      kind: ['arena', 'perf', 'bench-tick'].includes(request.run?.kind)
        ? request.run.kind
        : 'arena',
      params: request.run?.params ?? {},
      expectation: String(request.run.expectation).trim(),
    };
  }

  return { task, problems: [] };
}

/**
 * Разложить заявки отчёта по будущим задачам.
 *
 * Идентификаторы выдаются заранее и все разом: они нужны, чтобы связать
 * порождённые задачи с породившей ещё до того, как хоть одна записана.
 */
export function planRequests(requests, { existingIds, now, sourceId }) {
  const planned = [];
  const rejected = [];
  const taken = [...existingIds];

  for (const request of requests ?? []) {
    const id = nextId(taken, request?.title ?? 'zadacha');
    const { task, problems } = taskFromRequest(request, { id, now, sourceId });
    if (!task) {
      rejected.push({ request, problems });
      continue;
    }
    taken.push(id);
    planned.push(task);
  }

  return { planned, rejected };
}
