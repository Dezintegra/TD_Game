/**
 * Отказ проверки разрешений судят по следу этапа, а не по своему наличию.
 *
 * Прежде отчёт отбрасывался при любом непустом перечне отказов. Мерка
 * оказалась слишком грубой: вечер 31.08.2026 дал шесть отброшенных отчётов
 * подряд, и ни один не потерян из-за настоящей беды. Самый чистый случай —
 * задача 0006: отказ пришёл на справочную `node --version`, чей ответ сессии
 * не понадобился, а в ошибку ушёл полностью снятый прогон шестидесяти матчей.
 *
 * Здесь принимается ровно одно решение: можно ли верить отчёту. Куда пойдёт
 * задача — дело `applyReport` и `execute`.
 *
 * Улики приходят доводом, а не собираются внутри. Это тот же приём, что
 * у `scan`, `applyReport` и `runCycle`, и выбран он по той же причине: весь
 * разбор проверяется без единого настоящего репозитория, ветки и запуска.
 * Живой прогон этапа стоит доллары и минуты; проверять на нём таблицу следов
 * значило бы не проверять её вовсе.
 */

/**
 * Средства, которыми сессия спрашивает человека.
 *
 * Отказ такому средству подрывает отчёт ВСЕГДА, при любом следе и любом
 * исходе. Он подменяет не действие, а решение: сессия продолжает работу,
 * приняв за человека решение, которого тот не принимал, — и никакой след
 * этого не покажет, потому что работа-то будет сделана.
 */
const HUMAN_TOOLS = ['AskUserQuestion'];

/**
 * Какой след оставляет каждый этап.
 *
 * Таблица — данные, а не ветвления, и объявлена поимённо. Выводить след из
 * имени средства или из приставки отказанной команды нельзя: перечни неполны
 * по устройству, и первый же неперечисленный случай снова уничтожает работу.
 * Ровно так и вышло с `node --version` — командой оболочки, а не средством.
 *
 * - `commit` — ветка у origin, хвоста нет, есть коммит не старше начала этапа;
 * - `branch` — только ветка и хвост: аудит и ревью законно не коммитят;
 * - `run` — отчёт называет номер прогона, и он новый;
 * - `none` — проверяемого следа нет вовсе, и об этом говорится вслух.
 */
const TRACE = {
  design: 'commit',
  implement: 'commit',
  revise: 'commit',
  audit: 'branch',
  review: 'branch',
  benchmark: 'run',
  triage: 'none',
  interpret: 'none',
  postmortem: 'none',
  deploy: 'none',
};

/**
 * Сверка следа с делом.
 *
 * Каждая возвращает `{ kind, why }`, где `kind` — `present` (след на месте),
 * `missing` (следа нет) либо `none` (сверять нечем). Третье не то же, что
 * второе: неотвечающий git и отсутствующая запись реестра — это поломка
 * прибора, и стоить работы этапа она не должна.
 */
const CHECKS = {
  branch: (report, evidence) => branchTrace(evidence),

  commit: (report, evidence) => {
    const branch = branchTrace(evidence);
    if (branch.kind !== 'present') return branch;

    const committed = Date.parse(evidence.lastCommitAt ?? '');
    if (Number.isNaN(committed)) {
      return { kind: 'none', why: 'даты последнего коммита ветки git не назвал' };
    }
    const started = Date.parse(evidence.stageStartedAt ?? '');
    if (Number.isNaN(started)) {
      return { kind: 'none', why: 'отметки начала этапа нет' };
    }
    if (committed < started) {
      return { kind: 'missing', why: 'с начала этапа в ветке не появилось ни одного коммита' };
    }
    return { kind: 'present', why: null };
  },

  run: (report, evidence) => {
    const run = report.links?.run;
    if (run == null || run === '') {
      return { kind: 'missing', why: 'отчёт не называет номера прогона' };
    }
    if (String(run) === String(evidence.previousRun ?? '')) {
      return { kind: 'missing', why: 'номер прогона тот же, что задача знала до этапа' };
    }
    return { kind: 'present', why: null };
  },

  none: () => ({ kind: 'none', why: 'проверяемого следа у этапа нет' }),
};

/** Ветка у origin и хвост: общая часть следа коммитящих этапов и аудита. */
function branchTrace(evidence) {
  // Отсутствие ветки и молчание git — разные вещи. Слив их в одно, мы
  // заставили бы поломку прибора стоить этапу работы.
  if (evidence.branchOnRemote == null) {
    return { kind: 'none', why: 'о ветке задачи git не ответил' };
  }
  if (evidence.branchOnRemote === false) {
    return { kind: 'missing', why: 'ветки задачи нет у удалённого репозитория' };
  }
  if (evidence.unpushed == null) {
    return { kind: 'none', why: 'хвост ветки не сосчитан' };
  }
  if (evidence.unpushed > 0) {
    const why = `в ветке ${evidence.unpushed} коммит(ов), которых нет у удалённой`;
    return { kind: 'missing', why };
  }
  return { kind: 'present', why: null };
}

/** Отказ одной строкой: имя средства и доводы вызова. */
export function describeDenial(denial) {
  const input = denial?.tool_input;
  const shown =
    input && typeof input === 'object' && typeof input.command === 'string'
      ? input.command
      : JSON.stringify(input ?? null);
  return `${denial?.tool_name ?? 'средство без имени'}: ${shown}`;
}

/**
 * Подрывает ли перечень отказов доверие к отчёту.
 *
 * @param {object} params
 * @param {object[]} params.denials  отказанные действия из ответа процесса
 * @param {object} params.report     разобранный отчёт этапа
 * @param {string} params.stage      этап, с которого отчёт пришёл
 * @param {object} params.evidence   `{ branchOnRemote, unpushed, lastCommitAt,
 *                                      stageStartedAt, previousRun }`
 * @returns {{ verdict: 'passing'|'undermining'|'unverifiable', why: string|null }}
 */
export function judgeDenials({ denials = [], report = {}, stage, evidence = {} }) {
  if (denials.length === 0) return { verdict: 'passing', why: null };

  const asked = denials.filter((denial) => HUMAN_TOOLS.includes(denial?.tool_name));
  if (asked.length > 0) {
    const listed = asked.map(describeDenial).join('; ');
    const why = `сессия попыталась спросить человека, и ей отказали (${listed}): такой отказ подменяет не действие, а решение, и следом это не проверяется`;
    return { verdict: 'undermining', why };
  }

  // Отчёт, ничего не объявлявший сделанным, годен сам по себе. Вопрос
  // и замечания читают как они есть, а `failed` и так ведёт в разбор,
  // где отказ становится уликой.
  if (report.outcome !== 'done') return { verdict: 'passing', why: null };

  const check = CHECKS[TRACE[stage]];
  const trace = check
    ? check(report, evidence)
    : { kind: 'none', why: `этап «${stage}» в таблице следов не назван` };

  if (trace.kind === 'present') return { verdict: 'passing', why: null };

  if (trace.kind === 'none') {
    return { verdict: 'unverifiable', why: `сопоставить отказ с делом нечем: ${trace.why}` };
  }

  const listed = denials.map(describeDenial).join('; ');
  const why = `этап «${stage}» отчитался об успехе, но следа нет: ${trace.why}. Отказано: ${listed}`;
  return { verdict: 'undermining', why };
}
