import { canTransition } from '../config/transitions.mjs';

/**
 * Что означает исход этапа для состояния задачи.
 *
 * Сканер решает, ЧТО запускать; здесь решается, куда задача двинется, когда
 * запущенное кончилось. Разделение не косметическое: сканер работает
 * по картине мира, а этот разбор — по одному отчёту, и смешение двух правд
 * о переходах было бы первым местом, где они разойдутся.
 *
 * Переход всегда сверяется с таблицей. Если исход требует невозможного,
 * задача уходит в ошибку с внятной причиной, а не тихо застревает.
 */

/** Исходы, с которыми сессия вправе завершиться. */
export const OUTCOMES = ['done', 'rejected', 'question', 'failed'];

/**
 * Куда ведёт успешно законченный этап.
 *
 * Разбор нарочно табличный: маршрут читается глазами целиком, а не
 * собирается из ветвлений по всему файлу.
 */
function afterDone(task) {
  switch (task.status) {
    case 'triage':
      return 'closed';
    case 'design':
      return 'audit';
    case 'audit':
      return 'implement';
    case 'implement':
      // Прогон перед pull request нужен, только если задача его заказывала.
      return task.run ? 'benchmark' : 'pr';
    case 'benchmark':
      return task.type === 'run' ? 'closed' : 'pr';
    // Доработка ведёт обратно в ожидание проверок, а не в ревью: правка
    // требует нового прогона CI, а ревью на непроверенном коде запрещено.
    case 'revise':
      return 'pr';
    case 'review':
      return 'deploy'; // вливание уже случилось: три условия сошлись
    case 'deploy':
      return 'cleanup';
    case 'cleanup':
      return 'closed';
    default:
      return null;
  }
}

/**
 * Куда ведёт этап, закончившийся замечаниями.
 *
 * Замечания — не ошибка, а рабочий ход: аудит возвращает предложение
 * в проработку, ревью отправляет код в доработку.
 */
function afterRejected(task) {
  switch (task.status) {
    case 'audit':
      return 'design';
    case 'review':
      return 'revise';
    default:
      return null;
  }
}

/**
 * Разобрать отчёт сессии и сказать, каким станет состояние задачи.
 *
 * @param {object} task   запись бэклога в нынешнем состоянии
 * @param {object} report отчёт: `{ stage, outcome, summary }`
 * @returns {{ status, returnTo, note, problems }}
 */
export function applyReport(task, report) {
  const problems = [];

  if (!OUTCOMES.includes(report.outcome)) {
    problems.push(`неизвестный исход «${report.outcome}»`);
    return { status: 'failed', returnTo: task.status, note: problems.join('; '), problems };
  }

  if (report.stage !== task.status) {
    // Отчёт о чужом этапе означает, что состояние успели сменить без нас.
    // Молча применять его нельзя: он посчитан по другой картине.
    problems.push(`отчёт об этапе «${report.stage}», а задача в «${task.status}»`);
    return { status: 'failed', returnTo: task.status, note: problems.join('; '), problems };
  }

  if (report.outcome === 'failed') {
    return {
      status: 'failed',
      returnTo: task.status,
      note: report.summary ?? 'этап завершился неуспешно',
      problems,
    };
  }

  if (report.outcome === 'question') {
    return {
      status: 'awaiting-po',
      returnTo: task.status,
      note: report.summary ?? 'сессия упёрлась в решение уровня продукта',
      problems,
    };
  }

  const target = report.outcome === 'done' ? afterDone(task) : afterRejected(task);
  if (!target) {
    problems.push(`из «${task.status}» исход «${report.outcome}» никуда не ведёт`);
    return { status: 'failed', returnTo: task.status, note: problems.join('; '), problems };
  }

  const verdict = canTransition(task, target);
  if (!verdict.ok) {
    problems.push(verdict.reason);
    return { status: 'failed', returnTo: task.status, note: verdict.reason, problems };
  }

  return {
    status: target,
    returnTo: null,
    note: report.summary ?? verdict.reason,
    problems,
  };
}

/**
 * Что даёт опрос внешнего состояния.
 *
 * Проверки CI и прогоны на чужом железе отвечают не отчётом сессии,
 * а состоянием снаружи. Ревью не начинается, пока проверки не зелёные:
 * замечания к коду, который не собирается, бесполезны.
 */
export function applyExternal(task, external) {
  if (task.status === 'pr') {
    if (external.state === 'pending')
      return { status: 'pr', returnTo: null, note: 'проверки идут' };
    if (external.state === 'success') {
      return { status: 'review', returnTo: null, note: 'проверки зелёные' };
    }
    return {
      status: 'revise',
      returnTo: null,
      note: `проверки красные: ${external.failed ?? 'причина не названа'}`,
    };
  }

  if (task.status === 'benchmark') {
    if (external.state === 'pending')
      return { status: 'benchmark', returnTo: null, note: 'прогон идёт' };
    if (external.state === 'success') {
      return {
        status: task.type === 'run' ? 'closed' : 'pr',
        returnTo: null,
        note: 'прогон закончен, результат в журнале',
      };
    }
    return { status: 'failed', returnTo: 'benchmark', note: 'прогон не удался' };
  }

  return { status: task.status, returnTo: task.returnTo, note: 'опрос не относится к состоянию' };
}
