/**
 * Вердикт разбора ошибки: чья причина падения и чем она снимается.
 *
 * Разбор отвечает на два вопроса — «в конвейере или в задаче» и «после
 * каких задач причина снята». По первому конвейер решает, возвращать ли
 * задачу из ошибки сам; по второму — когда. Всё это чистый счёт от отчёта
 * к полю `recovery`, и здесь нет ни доски, ни git: перенос отчёта приносит
 * уже заведённые идентификаторы и опись доски доводами.
 *
 * Идентификаторов собственных заявок разбор знать не может: их выдаёт
 * перенос позже, чем написан отчёт. Поэтому в `fixedBy` они подставляются
 * здесь — все задачи, заведённые по этому отчёту с `area: "pipeline"`, —
 * а разбор называет лишь уже существующие: кандидата о той же причине,
 * которого он дополнил.
 */

/** Чья может быть причина. Только два слова: третьего вердикта не бывает. */
export const CAUSES = ['pipeline', 'task'];

/**
 * Собрать поле `recovery` из отчёта разбора.
 *
 * @param {object} report  отчёт разбора: `causedBy`, `fixedBy`
 * @param {object} params
 * @param {object} params.task       разбираемая задача — ради счёта возвратов
 * @param {string[]} [params.created] заведённые по отчёту конвейерные задачи
 * @param {string[]} [params.known]   все идентификаторы доски
 * @param {number} [params.maxReturns] предел автоматических возвратов
 * @returns {{ recovery: object, notes: string[] }}
 */
export function recoveryFrom(report, { task, created = [], known = [], maxReturns = null }) {
  const notes = [];
  const returns = task.recovery?.returns ?? 0;

  // Строго, как `blocking` и `area`: отчёт приходит из недоверенного места,
  // и правдоподобное «Pipeline» не должно тихо вернуть задачу в работу.
  // Отчёт при этом не отвергается — разбор в нём есть, и терять его нельзя;
  // цена ошибки разбора — ручной подъём, как сегодня, а не лишние сессии.
  const causedBy = CAUSES.includes(report?.causedBy) ? report.causedBy : null;
  if (!causedBy) {
    notes.push(
      'разбор не назвал причину строго (`causedBy` — `"pipeline"` либо `"task"`): ' +
        'считаем причину в задаче, конвейер её не вернёт',
    );
  }
  if (causedBy !== 'pipeline') {
    return { recovery: { causedBy, fixedBy: [], returns }, notes };
  }

  // Предохранитель применяется здесь, а не при возврате: тогда сканеру
  // не нужно второе правило на «исчерпано», а запись «дальше человек»
  // делается один раз, а не каждый оборот.
  if (maxReturns != null && returns >= maxReturns) {
    notes.push(
      `возвращалась ${returns === 2 ? 'дважды' : `${returns} раз(а)`}, дальше человек: ` +
        'предел автоматических возвратов исчерпан, причина в конвейере снова',
    );
    return { recovery: { causedBy: null, fixedBy: [], returns }, notes };
  }

  const fixedBy = [...created];
  const named = report.fixedBy;
  if (named != null && !Array.isArray(named)) {
    notes.push('`fixedBy` в отчёте разбора — не перечень; названное в нём отброшено');
  }
  for (const raw of Array.isArray(named) ? named : []) {
    const id = String(raw ?? '').trim();
    if (!id) continue;
    if (id === task.id) {
      notes.push('в `fixedBy` названа сама задача — отброшено: ждать себя нельзя');
      continue;
    }
    // Несуществующий идентификатор ждался бы вечно: задача, которой нет,
    // никогда не закроется. Отбрасывается с причиной, а не молча.
    if (!known.includes(id)) {
      notes.push(`в \`fixedBy\` названа задача ${id}, которой нет на доске, — отброшена`);
      continue;
    }
    if (!fixedBy.includes(id)) fixedBy.push(id);
  }

  return { recovery: { causedBy: 'pipeline', fixedBy, returns }, notes };
}

/**
 * Считает ли отчёт разбора причину конвейерной.
 *
 * По этому признаку все заявки отчёта заводятся конвейерными, даже если
 * разбор забыл поставить `area`: отчёт с причиной в конвейере и починкой
 * в кандидатах противоречил бы сам себе — задача вернулась бы сразу
 * и упала бы снова, а починка ждала бы человека.
 */
export const pipelineCause = (report) => report?.causedBy === 'pipeline';
