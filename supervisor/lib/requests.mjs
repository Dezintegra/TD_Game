import { dependencyFormatProblem } from './dependencies.mjs';
import { categoriesProblem } from './categories.mjs';
import { runSourceProblem } from './run-source.mjs';
import { runParamsProblem } from './run-params.mjs';
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
export function taskFromRequest(
  request,
  { id, now, sourceId, mayQueue = false, pipelineByDefault = false, decomposed = false },
) {
  const problems = [];

  const categoryProblem = categoriesProblem(request?.categories);
  if (categoryProblem) problems.push(categoryProblem);

  const type = ['feature', 'run', 'note'].includes(request?.type) ? request.type : null;
  if (!type) problems.push(`неизвестный тип заявки «${request?.type}»`);

  const title = String(request?.title ?? '').trim();
  if (!title) problems.push('в заявке нет заголовка');

  const description = String(request?.description ?? '').trim();
  if (!description) problems.push('в заявке нет описания');

  if (type === 'run' && !String(request?.run?.expectation ?? '').trim()) {
    problems.push('прогон заявлен без ожидаемого результата');
  }
  if (type === 'run') {
    if (Object.hasOwn(request.run ?? {}, 'params')) {
      const paramsProblem = runParamsProblem(request.run.params);
      if (paramsProblem) problems.push(paramsProblem);
    }
    const sourceProblem = runSourceProblem(request.run);
    if (sourceProblem) problems.push(sourceProblem);
  }

  const dependencyProblem = dependencyFormatProblem({ ...request, id });
  if (dependencyProblem) problems.push(dependencyProblem);
  if (problems.length > 0) return { task: null, problems };

  const priority = Number.isInteger(request.priority) ? request.priority : 50;

  // Область причины сохраняется для разбора ошибок. Сама область больше
  // не даёт права обогнать очередь: необходимость задаётся отдельно.
  const pipeline = request.area === 'pipeline' || pipelineByDefault;

  // Разбор ошибки сохраняет право на необходимые починки причины.
  // Обычные этапы оформляют обязательную предпосылку через blockers.mjs.
  const blocking = mayQueue && (pipelineByDefault || request.blocking === true);

  const task = {
    $schema: '../schema.json',
    ...(request.categories ? { categories: [...request.categories] } : {}),
    ...(Object.hasOwn(request, 'dependsOn') ? { dependsOn: [...request.dependsOn] } : {}),
    ...(Object.hasOwn(request, 'dependencyResults')
      ? { dependencyResults: request.dependencyResults.map((result) => ({ ...result })) }
      : {}),
    id,
    type,
    title: title.slice(0, 200),
    description,
    // Заявка агента — предложение, а не решение, и ждёт владельца продукта
    // в кандидатах. Прежде она заводилась сразу в работу: агент заводил
    // себе работу сам, а человек узнавал об этом, когда задача уже шла
    // по маршруту.
    //
    // Прогоны и обязательные починки разбора имеют прежние исключения.
    // Предпосылки исхода blocked подтверждаются отдельным проверенным планом.
    status: type === 'run' || blocking ? 'new' : 'candidate',
    returnTo: null,
    priority: Math.min(999, Math.max(0, priority)),
    createdAt: now,
    statusChangedAt: now,
    owner: null,
    history: [],
    links: { change: null, pr: null, run: null, related: sourceId ? [sourceId] : [] },
    attempts: { continuations: 0, cycleFailures: 0 },
    // Часть, рождённая дроблением, анализ на дробность уже прошла — в лице
    // задачи, которая её и породила. Без признака каждая часть шла бы
    // разбираться на дробность заново, сессия за сессией на вопрос
    // с известным ответом.
    //
    // Ставится он ТОЛЬКО заявкам дробления: заявка разбора или аудита —
    // это находка по дороге, и её дробность никто не смотрел.
    decomposed: Boolean(decomposed) && type === 'feature',
  };

  // Признак едет дальше самой задачей: хранилище ставит такую задачу
  // в начало очереди. Пока признак терялся здесь, блокирующая задача
  // миновала кандидатов, но вставала в конец «Заведено» — и 02.09.2026
  // задача 0080 простояла так восемь часов двадцать седьмой из двадцати
  // семи, а четыре взятые перед ней упали на той же причине.
  //
  // У прочих задач поля нет вовсе, а не `false`: отсутствие и есть
  // «обычная», и записи с ним состав не меняют.
  if (blocking) task.blocking = true;

  // Зона причины остаётся на задаче тем же порядком, что и признак
  // блокирующей: только у конвейерной и только словом. По ней перенос
  // отчёта разбора узнаёт, какие из заведённых задач — починки конвейера,
  // после закрытия которых упавшую задачу можно вернуть в работу.
  if (pipeline) task.area = 'pipeline';

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
export function planRequests(
  requests,
  { existingIds, now, sourceId, sourceStage = null, pipelineCause = false, decomposed = false },
) {
  const planned = [];
  const rejected = [];
  const taken = [...existingIds];

  // Право заводить работу мимо шлюза кандидатов есть только у разбора
  // ошибки: он судит не о том, что игре не помешало бы, а о том, почему
  // конвейер встал.
  const mayQueue = sourceStage === 'postmortem';

  // Разбор, назвавший причину конвейерной, подаёт конвейерные заявки:
  // иначе задача вернулась бы сразу, а починка ждала бы человека
  // в кандидатах, и падение повторилось бы на ровном месте.
  const pipelineByDefault = mayQueue && pipelineCause;

  for (const request of requests ?? []) {
    const id = nextId(taken, request?.title ?? 'zadacha');
    const { task, problems } = taskFromRequest(request, {
      id,
      now,
      sourceId,
      mayQueue,
      pipelineByDefault,
      decomposed,
    });
    if (!task) {
      rejected.push({ request, problems });
      continue;
    }
    taken.push(id);
    planned.push(task);
  }

  return { planned, rejected };
}

/**
 * Состояния, задачи в которых дополнений не принимают.
 *
 * Та же причина, всплывшая после закрытия задачи, — это не «ещё один
 * случай», а регрессия: закрытую задачу починили и проверили, и приписывать
 * к ней новую фактуру значит хоронить сигнал в законченной истории.
 * Остановленная не лучше: её саму ещё предстоит поднимать человеку.
 */
const CLOSED_TO_FACTS = ['completed', 'closed', 'failed'];

/**
 * Разобрать дополнения отчёта.
 *
 * Дополнение — это фактура к уже заведённой задаче: «та же причина, вот
 * ещё один случай». Оно ничего не двигает и никого не заводит, поэтому
 * и проверок ему нужно немного — но нужны: `taskId` приходит из отчёта
 * сессии, то есть из недоверенного по сути места.
 *
 * Одна негодная запись не отменяет остальных: каждая проверяется сама
 * по себе, а причина отказа уезжает в журнал разбираемой задачи.
 *
 * @param {object[]} amendments перечень `{ taskId, facts }`
 * @param {object} params  `known` — задачи бэклога по идентификаторам,
 *                         `sourceId` — кто дополняет
 * @returns {{ planned: object[], rejected: object[] }}
 */
export function planAmendments(amendments, { known, sourceId }) {
  const planned = [];
  const rejected = [];

  for (const amendment of amendments ?? []) {
    const taskId = String(amendment?.taskId ?? '').trim();
    const facts = String(amendment?.facts ?? '').trim();
    const problems = [];

    if (!taskId) problems.push('в дополнении не названа задача');
    else if (taskId === sourceId) problems.push('дополнить саму себя задача не может');

    const target = taskId ? (known.get?.(taskId) ?? known[taskId]) : null;
    if (taskId && taskId !== sourceId && !target) {
      problems.push(`задачи ${taskId} нет в бэклоге`);
    }
    if (target && CLOSED_TO_FACTS.includes(target.status)) {
      problems.push(
        `задача ${taskId} в состоянии «${target.status}» и дополнений не принимает: ` +
          'та же причина после закрытия — это регрессия, и ей нужна своя задача',
      );
    }
    if (!facts) problems.push(`дополнение к ${taskId || 'задаче'} пусто`);

    if (problems.length > 0) rejected.push({ amendment, problems });
    else planned.push({ taskId, facts });
  }

  return { planned, rejected };
}
