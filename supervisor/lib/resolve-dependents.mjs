import { recoverClosureReason } from './closure.mjs';

/**
 * Снятие ожидания у тех, кто ждал закрытую карточку.
 *
 * Мерка запуска засчитывает закрытие только вместе с `splitInto`: закрытый
 * дроблением родитель передаёт доказательство частям, и ждущий продолжает
 * ждать уже их. Всякое иное закрытие — «предмет снят», «потеряло смысл» —
 * не засчитывается никогда, и ждущий остаётся ждать того, чего не будет.
 *
 * 09.09.2026 карточка 0117 закрылась с честной причиной: разрешения выкладки,
 * которых она требовала, уже лежали в origin/main. Через час тот же супервизор
 * записал «задача 0143 ждёт починок конвейера: 0117 (closed)» — и так про семь
 * задач. Всего на двух таких закрытиях висело четырнадцать карточек.
 *
 * Чинится это не смягчением мерки запуска, а снятием самого ребра. Разница
 * важная. Засчитай мы всякое закрытие за выполнение — ждущий однажды поехал
 * бы дальше молча, и почему поехал, из его журнала было бы не видно; заодно
 * рассыпалась бы рекурсивная проверка частей. Снятое ребро, наоборот, оставляет
 * в журнале два обоснования: почему закрыта ожидаемая задача и почему ожидание
 * больше не нужно.
 *
 * Закрытие дроблением ребра НЕ снимает: там работа не отпала, а переехала
 * в части, и передача доказательства уже работает рекурсивно. Снять ребро
 * значило бы пустить задачу вперёд её собственной незаконченной предпосылки.
 */

/** Два вида ребра ожидания, и оба ведут в одну и ту же беду. */
const EDGES = [
  {
    field: 'dependsOn',
    read: (task) => task.dependsOn ?? [],
    what: 'предусловие',
  },
  {
    field: 'recovery.fixedBy',
    read: (task) => task.recovery?.fixedBy ?? [],
    what: 'починка конвейера',
  },
];

/** Закрытая карточка, не передавшая работу частям. */
function closedWithoutParts(item) {
  return item?.status === 'closed' && !(item.splitInto?.length > 0);
}

/**
 * Найти рёбра, ведущие в закрытые карточки.
 *
 * Планируется по снимку доски, а не в момент закрытия. Так разбирается
 * и уже накопившийся затор, и переживается обрыв на середине: неснятое
 * ребро просто попадёт в план следующего оборота.
 */
export function planEdgeResolutions({ tasks = [], records = [] } = {}) {
  const byId = new Map();
  for (const item of [...tasks, ...records]) {
    byId.set(item.id, [...(byId.get(item.id) ?? []), item]);
  }
  const closedReason = (id) => {
    const matches = byId.get(id) ?? [];
    // Двусмысленный номер разбирают отдельно: снимать ребро, не зная,
    // какая из двух карточек имелась в виду, нельзя.
    if (matches.length !== 1) return null;
    return closedWithoutParts(matches[0])
      ? (recoverClosureReason(matches[0]) ?? 'Причина закрытия в карточке не сохранилась.')
      : null;
  };

  const plans = [];
  for (const task of tasks) {
    if (['completed', 'closed'].includes(task.status)) continue;
    const resolved = [];
    for (const edge of EDGES) {
      for (const id of edge.read(task)) {
        const reason = closedReason(id);
        if (reason) resolved.push({ dependencyId: id, field: edge.field, what: edge.what, reason });
      }
    }
    if (resolved.length > 0) plans.push({ taskId: task.id, edges: resolved });
  }
  return plans;
}

/** Запись в журнал ждущей карточки: два обоснования, и оба обязательны. */
export function resolutionNote(edges) {
  return edges
    .map(
      (edge) =>
        `Ожидание снято: ${edge.dependencyId} (${edge.what}) закрыта.\n\n` +
        `**Почему закрыта ожидаемая задача:** ${edge.reason}\n\n` +
        '**Почему ожидание снято:** закрытая карточка результата уже не даст, ' +
        'и дожидаться его больше не от кого. Удаление ребра не доказывает результат: ' +
        'для принятого blocked и явного результата требуется проверка предусловия или живая замена.',
    )
    .join('\n\n');
}

/** Снять названные рёбра у одной ждущей карточки. */
export async function resolveDependents(action, io) {
  const task = io.readTask(action.taskId);
  if (!task) return { result: 'skipped', why: 'задачи нет' };
  if (task.owner && task.owner !== io.machine)
    return { result: 'skipped', why: 'задача другой станции' };

  // Повтор на неизменном снимке ничего не пишет: снятого ребра уже нет,
  // и остаток плана оказывается пустым.
  const edges = action.edges.filter((edge) =>
    edge.field === 'dependsOn'
      ? (task.dependsOn ?? []).includes(edge.dependencyId)
      : (task.recovery?.fixedBy ?? []).includes(edge.dependencyId),
  );
  if (edges.length === 0) return { result: 'skipped', why: 'рёбра уже сняты' };

  const idsOf = (field) =>
    new Set(edges.filter((edge) => edge.field === field).map((edge) => edge.dependencyId));
  const fromDependsOn = idsOf('dependsOn');
  const fromFixedBy = idsOf('recovery.fixedBy');
  const next = { ...task };
  if (
    task.status === 'blocked' ||
    task.dependencyResults?.some((r) => fromDependsOn.has(r.taskId))
  ) {
    next.dependencyRecheck = {
      edges: [...(task.dependencyRecheck?.edges ?? []), ...edges],
      results: [
        ...(task.dependencyRecheck?.results ?? []),
        ...(task.dependencyResults ?? []).filter((r) => fromDependsOn.has(r.taskId)),
      ],
    };
  }

  if (fromDependsOn.size > 0) {
    next.dependsOn = (task.dependsOn ?? []).filter((id) => !fromDependsOn.has(id));
    // Ожидаемый влитый PR снимается вместе со своим ребром принудительно:
    // проверка формата требует, чтобы каждый dependencyResults указывал
    // на существующее предусловие. Оставь мы запись — карточка стала бы
    // негодной и встала бы уже по другой причине.
    if (task.dependencyResults)
      next.dependencyResults = task.dependencyResults.filter(
        (item) => !fromDependsOn.has(item.taskId),
      );
  }
  if (fromFixedBy.size > 0) {
    next.recovery = {
      ...task.recovery,
      fixedBy: (task.recovery?.fixedBy ?? []).filter((id) => !fromFixedBy.has(id)),
    };
  }

  // `blockedContext.reasons` остаётся нетронутым намеренно: это запись о том,
  // чего и почему задача ждала, и она верна даже после снятия. Схема требует
  // от неё непустоты, а разблокировка узнаёт по ней законное ожидание.
  const note = resolutionNote(edges);
  const saved = await io.saveTask(
    next,
    { at: io.now, from: task.status, to: task.status, what: note, source: 'supervisor' },
    `chore(backlog): ${task.id} снято ожидание ${edges.map((edge) => edge.dependencyId).join(', ')}`,
  );
  return saved.ok
    ? { result: 'done', status: task.status }
    : { result: 'failed', why: saved.why ?? saved.outcome };
}
