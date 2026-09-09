import { canTransition } from '../config/transitions.mjs';
import { blockerReportProblem } from './blockers.mjs';
import { tokenReanalysisProblem } from './token-reanalysis.mjs';

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

/**
 * Исходы, с которыми сессия вправе завершиться.
 *
 * `moot` — «предмет снят»: описанного в задаче дефекта нет, работа уже сделана
 * чужим влитым изменением либо правило, которое просят завести, действует.
 * Проектировать такой задаче нечего, и прежде она уходила в сквозную «Ошибку»,
 * лгавшую о причине; теперь у неё есть честный конец — уборка и «Закрыто».
 */
export const OUTCOMES = [
  'done',
  'rejected',
  'question',
  'failed',
  'moot',
  'split',
  'blocked',
  'waiting-ci',
];

/** Ожидание не служит обходом замечаний и не удостоверяет право на merge. */
export function ciWaitProblem(task, report) {
  const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
  const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
  const wait = report.ciWait;
  if (!['review', 'revise'].includes(task.status))
    return 'waiting-ci допустим только review/revise';
  if (report.taskId !== task.id) return 'waiting-ci: чужая задача';
  if (
    !wait ||
    !Number.isSafeInteger(wait.pr) ||
    wait.pr <= 0 ||
    wait.pr !== task.links?.pr ||
    report.links?.pr !== wait.pr
  )
    return 'waiting-ci: PR не совпал с назначением';
  if (report.links?.change != null && report.links.change !== task.links?.change)
    return 'waiting-ci: изменение не совпало с назначением';
  if (!sha(wait.expectedHead) || !(wait.observedHead === null || sha(wait.observedHead)))
    return 'waiting-ci: нужен полный ожидаемый и пригодный наблюдаемый SHA';
  if (
    !nonempty(wait.why) ||
    !['ordinary', 'confirmed'].includes(wait.mode) ||
    !Array.isArray(wait.runs) ||
    wait.runs.some(
      (run) =>
        !run ||
        !Number.isSafeInteger(run.id) ||
        run.id <= 0 ||
        !Number.isSafeInteger(run.attempt) ||
        run.attempt <= 0 ||
        !sha(run.head),
    )
  )
    return 'waiting-ci: непригодные сведения CI';
  if (
    !Array.isArray(report.findings) ||
    report.findings.length ||
    report.conflict === true ||
    wait.failed
  )
    return 'waiting-ci: отсутствие самостоятельных замечаний не подтверждено';
  const recovery = task.status === 'revise';
  if (
    !(recovery
      ? wait.checkpoint === 'revise-recovery'
      : ['entry', 'pre-merge'].includes(wait.checkpoint))
  )
    return 'waiting-ci: checkpoint не соответствует этапу';
  if (
    !(wait.state === 'pending' && wait.exitCode === 2) &&
    !(
      recovery &&
      wait.state === 'success' &&
      wait.exitCode === 0 &&
      wait.observedHead === wait.expectedHead
    )
  )
    return 'waiting-ci: непригодная пара state/exitCode';
  if (wait.state === 'pending' && (wait.mode !== 'ordinary' || wait.runs.length))
    return 'waiting-ci: pending не содержит подтверждённых runs';
  if (recovery) {
    const evidence = report.recoveryEvidence;
    if (
      !evidence ||
      evidence.taskId !== task.id ||
      evidence.pr !== wait.pr ||
      evidence.change !== task.links?.change ||
      !nonempty(evidence.source) ||
      !nonempty(evidence.session) ||
      !nonempty(evidence.returnId) ||
      !Number.isFinite(Date.parse(evidence.startedAt)) ||
      evidence.pendingOnly !== true ||
      evidence.complete !== true ||
      !Array.isArray(evidence.unresolved) ||
      evidence.unresolved.length ||
      !nonempty(evidence.reason)
    )
      return 'waiting-ci: не доказан текущий ошибочный возврат revise';
  }
  return null;
}

/**
 * Куда ведёт остановка задачи.
 *
 * Прямо в ошибку задача больше не падает: между рабочим этапом и ошибкой
 * стоит разбор, который читает журнал и лог упавшего этапа, называет причину
 * и заявляет её починку. Иначе причина остаётся в логе, которого не читает
 * никто, и через день роняет следующую задачу.
 *
 * Единственное исключение — сам разбор. Не сумев разобраться, он
 * останавливает задачу, а не назначает разбор разбора: петля крутилась бы,
 * пока её не заметит человек.
 *
 * Правило живёт одной функцией, а не восемью условиями по двум файлам:
 * восемь копий одного правила — это восемь мест, где оно однажды разойдётся.
 */
export const haltOf = (task) => (task.status === 'postmortem' ? 'failed' : 'postmortem');

/** Остановка задачи с названной причиной. */
const halt = (task, why, problems = []) => ({
  status: haltOf(task),
  // Состояние возврата считает переход: из сквозного в сквозное оно
  // наследуется, чтобы человек поднял задачу в упавший этап, а не в разбор.
  returnTo: task.status,
  note: why,
  problems,
});

/**
 * Куда ведёт успешно законченный этап.
 *
 * Разбор нарочно табличный: маршрут читается глазами целиком, а не
 * собирается из ветвлений по всему файлу.
 */
function afterDone(task, report) {
  switch (task.status) {
    case 'triage':
      return report.requests?.length ? 'closed' : 'completed';
    case 'decompose':
      return task.tokenReanalysis?.phase === 'analyzing'
        ? task.tokenReanalysis.originStatus
        : 'design';
    case 'design':
      return 'audit';
    case 'audit':
      return 'implement';
    case 'implement':
      // Прогон перед pull request нужен, только если задача его заказывала.
      return task.run ? 'benchmark' : 'pr';
    case 'benchmark':
      // Задача-прогон после замера идёт толковать полученные числа, а не
      // закрываться. Задача-доработка — сразу в pull request: у неё замер
      // лишь одна из проверок перед ревью, и толковать его будет ревьюер.
      return task.type === 'run' ? 'interpret' : 'pr';
    case 'interpret':
      return 'completed';
    // Доработка ведёт обратно в ожидание проверок, а не в ревью: правка
    // требует нового прогона CI, а ревью на непроверенном коде запрещено.
    case 'revise':
      return 'pr';
    case 'review':
      return 'deploy'; // вливание уже случилось: три условия сошлись
    case 'deploy':
      return 'cleanup';
    case 'cleanup':
      return task.links?.pr ? 'completed' : 'closed';
    // Удавшийся разбор ошибки ведёт задачу в саму ошибку — и это не сбой,
    // а его назначение. Разбор не спасает задачу, а объясняет, почему её
    // не удалось довести; поднимает её оттуда человек.
    case 'postmortem':
      return 'failed';
    // Ответ владельца продукта возвращает задачу туда, откуда она ушла.
    // Без этой ветки отчёт спрашивающей сессии было бы некуда применить,
    // и единственным выходом из ожидания остался бы ответ, вписанный
    // в файл вопросов руками.
    case 'awaiting-po':
      return task.returnTo;
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
 * @param {object} [limits] пределы: `maxRejections`
 * @returns {{ status, returnTo, note, problems }}
 */
export function applyReport(task, report, limits = {}) {
  const problems = [];

  if (
    task.status === 'decompose' &&
    report.outcome === 'done' &&
    task.tokenReanalysis?.phase === 'analyzing'
  ) {
    const problem =
      tokenReanalysisProblem(task) ||
      (typeof report.summary !== 'string' || !report.summary.trim()
        ? 'Не объяснена невозможность дробления.'
        : null) ||
      (report.requests?.length ? 'Неделимая задача не порождает части.' : null);
    if (problem) return halt(task, problem, [problem]);
  }

  if (!OUTCOMES.includes(report.outcome)) {
    problems.push(`неизвестный исход «${report.outcome}»`);
    return halt(task, problems.join('; '), problems);
  }

  if (report.stage !== task.status) {
    // Отчёт о чужом этапе означает, что состояние успели сменить без нас.
    // Молча применять его нельзя: он посчитан по другой картине.
    problems.push(`отчёт об этапе «${report.stage}», а задача в «${task.status}»`);
    return halt(task, problems.join('; '), problems);
  }

  const closing =
    ['moot', 'split'].includes(report.outcome) ||
    (task.status === 'triage' && report.outcome === 'done' && report.requests?.length);
  if (closing && (typeof report.summary !== 'string' || !report.summary.trim())) {
    const why = 'причина закрытия не названа: поле summary пусто';
    return halt(task, why, [why]);
  }

  if (report.outcome === 'failed') {
    return halt(task, report.summary ?? 'этап завершился неуспешно', problems);
  }

  if (report.outcome === 'waiting-ci') {
    const problem = ciWaitProblem(task, report);
    const transition = canTransition(task, 'pr');
    if (problem || !transition.ok)
      return halt(task, problem ?? transition.reason, [problem ?? transition.reason]);
    return {
      status: 'pr',
      returnTo: null,
      note: `Ожидание допуска CI: ${report.ciWait.why}`,
      problems: [],
    };
  }

  if (report.outcome === 'blocked') {
    const problem = blockerReportProblem(task, report);
    return problem
      ? halt(task, problem, [problem])
      : {
          status: 'blocked',
          returnTo: null,
          note: report.summary,
          problems: [],
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

  if (report.outcome === 'moot') {
    // Три предохранителя против тихого сбрасывания неудобной работы, и все
    // машинные: словесный запрет в скилле проверить нечем.
    //
    // Первый — этап. С имплементации, ревью или выкладки задачу этим ходом
    // не сбросить вовсе: там работа уже сделана.
    if (task.status !== 'design' && task.status !== 'triage') {
      const why = `исход «moot» объявлен этапом «${task.status}», а он бывает только у проработки и разбора заметки`;
      problems.push(why);
      return halt(task, why, problems);
    }

    // Второй — заведённые артефакты. Проработка, вернувшаяся из аудита
    // с замечаниями, обязана править заведённое изменение, а спорит
    // с постановкой отчётом `question`.
    const started = task.links?.change
      ? `изменение «${task.links.change}»`
      : task.links?.pr
        ? `pull request ${task.links.pr}`
        : null;
    if (started) {
      const why = `исход «moot» поверх сделанной работы: у задачи заведено ${started}`;
      problems.push(why);
      return halt(task, why, problems);
    }

    // Третий — доказательство. Заявленное без него ходом не считается:
    // назвать файл со строкой или номер влитого pull request можно, только
    // посмотрев, и это ровно та цена, которую ход обязан стоить.
    const evidence = String(report.evidence ?? '').trim();
    if (!evidence) {
      const why = 'исход «moot» без доказательства: поле evidence пусто';
      problems.push(why);
      return halt(task, why, problems);
    }

    // Переход всё так же сверяется с таблицей: у задачи не типа `feature`
    // маршрута `design` → `cleanup` нет, и ход обязан упереться в неё,
    // а не обойти.
    const target = task.status === 'triage' ? 'closed' : 'cleanup';
    const verdict = canTransition(task, target);
    if (!verdict.ok) {
      problems.push(verdict.reason);
      return halt(task, verdict.reason, problems);
    }

    return {
      status: target,
      returnTo: null,
      // Записка уезжает в журнал задачи: закрытие без названной причины
      // неотличимо на доске от брошенного.
      note: `Предмет снят: ${report.summary ?? 'причина не названа'}. Проверено: ${evidence}.`,
      problems,
    };
  }

  if (report.outcome === 'split') {
    // Три предохранителя, и все машинные — по образцу `moot`: ход, которым
    // этап закрывает собственную задачу, словесным запретом не удержать.
    //
    // Первый — этап. С проработки, имплементации или ревью задачу этим ходом
    // не сбросить: там работа уже начата, а разнести по карточкам можно
    // только замысел.
    if (task.status !== 'decompose') {
      const why = `исход «split» объявлен этапом «${task.status}», а он бывает только у анализа`;
      problems.push(why);
      return halt(task, why, problems);
    }

    // Второй — число частей. Дробление на одну часть — это не дробление,
    // а отказ от работы под видом дробления, и мерка тут обязана быть
    // машинной: словами такое не отличить.
    const parts = Array.isArray(report.requests) ? report.requests.length : 0;
    if (parts < 2) {
      const why = `исход «split» с ${parts} заявками: дробление меньше чем на две части — не дробление`;
      problems.push(why);
      return halt(task, why, problems);
    }

    // Третий — заведённые артефакты, дословно как у `moot`. Задача, дошедшая
    // до изменения или до pull request, дробится уже поверх сделанного.
    const started = task.links?.change
      ? `изменение «${task.links.change}»`
      : task.links?.pr
        ? `pull request ${task.links.pr}`
        : null;
    if (started) {
      const why = `исход «split» поверх сделанной работы: у задачи заведено ${started}`;
      problems.push(why);
      return halt(task, why, problems);
    }

    // Переход всё так же сверяется с таблицей: у задачи не типа `feature`
    // маршрута `decompose` → `closed` нет, и ход обязан упереться в неё.
    const verdict = canTransition(task, 'closed');
    if (!verdict.ok) {
      problems.push(verdict.reason);
      return halt(task, verdict.reason, problems);
    }

    return {
      status: 'closed',
      returnTo: null,
      note: `Работа разнесена по ${parts} карточкам: ${report.summary ?? 'причина не названа'}`,
      problems,
    };
  }

  // Возврат за возвратом на одном месте — это не работа, а спор двух сессий,
  // и оплачивается он кругами по десять минут. Считается ПОДРЯД идущее:
  // счёт обнуляется, едва проверка пройдена.
  if (report.outcome === 'rejected' && limits.maxRejections != null) {
    const already = (task.attempts?.rejections ?? 0) + 1;
    if (already >= limits.maxRejections) {
      const why =
        `${already}-й возврат подряд из «${task.status}»: стороны не сходятся, ` +
        `нужен разбор. Последнее замечание: ${report.summary ?? 'без пояснения'}`;
      return halt(task, why, problems);
    }
  }

  const target = report.outcome === 'done' ? afterDone(task, report) : afterRejected(task);
  if (!target) {
    problems.push(`из «${task.status}» исход «${report.outcome}» никуда не ведёт`);
    return halt(task, problems.join('; '), problems);
  }

  const verdict = canTransition(task, target);
  if (!verdict.ok) {
    problems.push(verdict.reason);
    return halt(task, verdict.reason, problems);
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
    if (external.state === 'conflict') {
      const pr = task.links?.pr ? `pull request #${task.links.pr}` : 'pull request';
      return {
        status: 'revise',
        returnTo: null,
        note: `${pr} конфликтует с главной веткой; обновите ветку и устраните конфликты перед повторным CI`,
      };
    }
    if (external.state === 'pending')
      return { status: 'pr', returnTo: null, note: external.why ?? 'проверки идут' };
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
        status: task.type === 'run' ? 'interpret' : 'pr',
        returnTo: null,
        note: 'прогон закончен, числа в журнале — вывод делает толкование',
      };
    }
    return halt(task, 'прогон не удался');
  }

  return { status: task.status, returnTo: task.returnTo, note: 'опрос не относится к состоянию' };
}
