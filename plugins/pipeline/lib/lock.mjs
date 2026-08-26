/**
 * Замок цикла: два оркестратора разом не работают.
 *
 * Цикл может затянуться дольше своего интервала — отправка с повторами,
 * опрос проверок, заведение деревьев. Планировщик к тому времени разбудит
 * следующий, и два экземпляра устроят гонку за один бэклог: оба прочитают
 * одну картину, оба заведут по дереву, оба напишут владельца.
 *
 * Замок держится не вечно. Брошенным он считается по времени последнего
 * обновления, а не по времени взятия: живой цикл обновляет отметку по ходу
 * работы, поэтому долгая, но живая отправка не выглядит брошенной.
 */

/** Соотношение сроков, которое обязано выполняться. Проверяется настройкой. */
export const BUDGET_ORDER = 'бюджет отправки < интервал цикла < срок брошенности замка';

/**
 * Вправе ли цикл взять замок.
 *
 * @param {object|null} existing содержимое замка: `{ pid, takenAt, refreshedAt }`
 * @param {string} now           отметка времени
 * @param {number} staleMinutes  через сколько минут молчания замок брошен
 * @param {(pid:number)=>boolean} [isAlive] жив ли процесс, если это можно узнать
 */
export function lockVerdict(existing, now, staleMinutes, isAlive) {
  if (!existing) return { take: true, why: 'замок свободен' };

  const silentFor =
    (Date.parse(now) - Date.parse(existing.refreshedAt ?? existing.takenAt)) / 60000;

  if (Number.isNaN(silentFor)) {
    return { take: true, why: 'замок испорчен и считается брошенным' };
  }

  if (silentFor >= staleMinutes) {
    return {
      take: true,
      why: `замок брошен: не обновлялся ${Math.round(silentFor)} мин при пределе ${staleMinutes}`,
    };
  }

  // Живость процесса — уточнение, а не основание: узнать её можно не везде,
  // и отсутствие ответа не повод отбирать свежий замок.
  if (isAlive && existing.pid && !isAlive(existing.pid)) {
    return { take: true, why: `процесс ${existing.pid} не жив, замок освобождён` };
  }

  return {
    take: false,
    why: `замок держит процесс ${existing.pid ?? '?'}, обновлён ${Math.round(silentFor)} мин назад`,
  };
}

/** Содержимое нового замка. */
export const newLock = (pid, now) => ({ pid, takenAt: now, refreshedAt: now });

/** Обновить отметку живости, не трогая времени взятия. */
export const refreshLock = (lock, now) => ({ ...lock, refreshedAt: now });

/**
 * Согласованы ли сроки в настройке.
 *
 * Нарушение этого порядка означает, что живой цикл будет выглядеть брошенным
 * и его замок отберут посреди отправки. Проверяется при запуске, а не
 * в бою: там уже поздно.
 */
export function budgetsAgree(config) {
  const push = config.pushBudgetSeconds / 60;
  const cycle = config.cycleMinutes;
  const stale = config.lockStaleMinutes;
  if (push >= cycle) {
    return { ok: false, why: `бюджет отправки ${push} мин не меньше интервала цикла ${cycle} мин` };
  }
  if (cycle >= stale) {
    return {
      ok: false,
      why: `интервал цикла ${cycle} мин не меньше срока брошенности ${stale} мин`,
    };
  }
  return { ok: true, why: BUDGET_ORDER };
}
