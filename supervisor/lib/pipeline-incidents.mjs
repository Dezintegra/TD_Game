import { createHash } from 'node:crypto';
import { NEEDS_SESSION } from '../config/transitions.mjs';
import { pendingDependencies } from './dependencies.mjs';
import {
  INCIDENT_REPORT_RECOVERIES,
  incidentRecoveryKey,
} from '../config/incident-report-recoveries.mjs';
import { reportTaskIds } from './report-targets.mjs';

export function incidentRecoveryHeld(taskId, state = {}) {
  const item = INCIDENT_REPORT_RECOVERIES.find((item) => item.taskId === taskId);
  if (!item) return false;
  const confirmation = state.incidentRecoveries?.[taskId];
  return confirmation?.key !== incidentRecoveryKey(item) || confirmation.complete !== true;
}

/** Даже устаревший пакет не вправе изменить удержанный источник. */
export function incidentRecoveryActionHeld(action, state = {}) {
  const report = state.reports?.find((entry) => entry.reportId === action.reportId);
  const payload = report?.report ?? report;
  const ids = new Set([
    action.taskId,
    ...(action.batch ?? []),
    ...(report ? reportTaskIds(report.report ?? report) : []),
    ...[payload?.amendments, payload?.dependencyUpdates].flatMap((items) =>
      Array.isArray(items) ? items.map((item) => item?.taskId) : [],
    ),
  ]);
  return [...ids].some(
    (id) =>
      incidentRecoveryHeld(id, state) &&
      !(
        action.kind === 'transfer-report' &&
        action.taskId === id &&
        action.reportId &&
        state.incidentRecoveries?.[id]?.pendingReportId === action.reportId
      ),
  );
}

const text = (value) => typeof value === 'string' && value.trim().length > 0;
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const CHECK_STAGES = NEEDS_SESSION.filter((stage) => stage !== 'postmortem');

function evidenceText(value) {
  if (text(value)) return value;
  if (Array.isArray(value) && value.length && value.every(text)) return value.join('\n');
  return null;
}

export function incidentDeclarationProblem(value, task, report) {
  if (value === undefined) return null;
  if (report.stage !== 'postmortem' || report.outcome !== 'done' || report.causedBy !== 'pipeline')
    return 'pipelineIncident принимается только из успешного разбора общей поломки конвейера';
  if (
    !value ||
    !evidenceText(value.evidence) ||
    !Array.isArray(value.affectedStages) ||
    !value.affectedStages.length ||
    value.affectedStages.some((stage) => !NEEDS_SESSION.includes(stage)) ||
    new Set(value.affectedStages).size !== value.affectedStages.length ||
    !value.check ||
    !CHECK_STAGES.includes(value.check.stage) ||
    !text(value.check.expectation) ||
    value.check.stage !== task.returnTo ||
    !value.affectedStages.includes(value.check.stage)
  )
    return 'pipelineIncident требует свидетельство, затронутые этапы и проверку исходного сломанного этапа';
  return null;
}

export function incidentStateProblem(value) {
  if (value === undefined) return null;
  if (
    !value ||
    !text(value.id) ||
    !text(value.evidence) ||
    !date(value.openedAt) ||
    !Array.isArray(value.fixedBy) ||
    !value.fixedBy.length ||
    value.fixedBy.some((id) => !text(id)) ||
    !Array.isArray(value.affectedStages) ||
    !value.affectedStages.length ||
    value.affectedStages.some((stage) => !NEEDS_SESSION.includes(stage)) ||
    !value.check ||
    !CHECK_STAGES.includes(value.check.stage) ||
    !text(value.check.expectation) ||
    !value.affectedStages.includes(value.check.stage) ||
    (value.probeStartedAt != null && !date(value.probeStartedAt)) ||
    (value.verifiedAt != null && (!date(value.verifiedAt) || !text(value.verificationEvidence)))
  )
    return 'неполный pipelineIncident: источник изолирован до восстановления данных инцидента';
  return null;
}

/** Новый диагноз отличается содержанием и исправлениями, а не минутой повторной доставки. */
export function incidentFromReport(task, report, fixedBy, now) {
  const declaration = report.pipelineIncident;
  const problem = incidentDeclarationProblem(declaration, task, report);
  if (problem) return { problem };
  if (!declaration) return { incident: task.pipelineIncident };
  if (!fixedBy.length) return { problem: 'общему инциденту нужны конкретные карточки исправлений' };
  const data = {
    evidence: evidenceText(declaration.evidence),
    affectedStages: [...declaration.affectedStages].sort(),
    check: { ...declaration.check },
    fixedBy: [...new Set(fixedBy)].sort(),
  };
  const id = createHash('sha256')
    .update(JSON.stringify([task.id, data]))
    .digest('hex')
    .slice(0, 24);
  if (task.pipelineIncident?.id === id) return { incident: task.pipelineIncident };
  return { incident: { id, ...data, openedAt: now, probeStartedAt: null, verifiedAt: null } };
}

/** Доказательство проверяется до передачи результата этапа; одного done недостаточно. */
export function verifyIncident(task, report, now) {
  const incident = task.pipelineIncident;
  if (!incident || incident.verifiedAt || report.stage !== incident.check.stage) return null;
  const result = report.incidentVerification;
  const failure = (kind, field, why) => ({
    kind,
    problem: `инцидент ${incident.id}: проверка восстановления не подтверждена; ${field}: ${why}`,
  });
  if (report.outcome !== 'done')
    return failure('probe-failed', 'outcome', `${report.outcome}; нужен пересмотр диагноза`);
  if (!result || typeof result !== 'object' || Array.isArray(result))
    return failure('invalid-report', 'incidentVerification', 'ожидается объект');
  if (result.incidentId !== incident.id)
    return failure('invalid-report', 'incidentVerification.incidentId', `ожидается ${incident.id}`);
  if (typeof result.passed !== 'boolean')
    return failure('invalid-report', 'incidentVerification.passed', 'ожидается boolean');
  const evidence = evidenceText(result.evidence);
  if (evidence === null) {
    const index = Array.isArray(result.evidence) ? result.evidence.findIndex((v) => !text(v)) : -1;
    return failure(
      'invalid-report',
      `incidentVerification.evidence${index < 0 ? '' : `[${index}]`}`,
      'ожидается непустая строка либо непустой массив непустых строк',
    );
  }
  if (!date(incident.probeStartedAt))
    return failure(
      'invalid-report',
      'pipelineIncident.probeStartedAt',
      'начало пробы не подтверждено',
    );
  if (!result.passed)
    return failure(
      'probe-failed',
      'incidentVerification.passed',
      'false; нужен пересмотр диагноза',
    );
  return { incident: { ...incident, verifiedAt: now, verificationEvidence: evidence } };
}

/** Подтверждённые общие исправления старых разборов требуют одной общей пробы. */
export function legacyIncident(tasks, now, records = []) {
  const checked = [...tasks, ...records]
    .filter((task) => task.pipelineIncident?.verifiedAt)
    .map((task) => task.pipelineIncident);
  const sources = tasks.filter(
    (task) =>
      task.status === 'failed' &&
      !task.pipelineIncident &&
      task.recovery?.causedBy === 'pipeline' &&
      task.recovery.fixedBy?.length &&
      CHECK_STAGES.includes(task.returnTo),
  );
  for (const task of sources) {
    if (
      checked.some(
        (item) =>
          item.check.stage === task.returnTo &&
          task.recovery.fixedBy.every((id) => item.fixedBy.includes(id)),
      )
    )
      continue;
    const siblings = sources.filter(
      (other) =>
        other.id !== task.id &&
        other.returnTo === task.returnTo &&
        other.recovery.fixedBy.some((id) => task.recovery.fixedBy.includes(id)),
    );
    if (!siblings.length) continue;
    const evidence =
      `Разборы ${[task.id, ...siblings.map((item) => item.id)].sort().join(', ')} ` +
      `назвали общую конвейерную причину и общие исправления на этапе ${task.returnTo}.`;
    const fixedBy = [...new Set([task, ...siblings].flatMap((item) => item.recovery.fixedBy))];
    const report = {
      stage: 'postmortem',
      outcome: 'done',
      causedBy: 'pipeline',
      pipelineIncident: {
        evidence,
        affectedStages: [task.returnTo],
        check: {
          stage: task.returnTo,
          expectation:
            'Исходный этап выполняется и возвращает применимый результат без повторения общей поломки; приложены свидетельства сломанного пути.',
        },
      },
    };
    return { taskId: task.id, incident: incidentFromReport(task, report, fixedBy, now).incident };
  }
  return null;
}

/** Ремонт имеет приоритет, а независимые этапы не разделяют его остановку. */
export function incidentPolicy(state) {
  const records = [...(state.tasks ?? []), ...(state.dependencyRecords ?? [])];
  const held = records.filter((task) => incidentRecoveryHeld(task.id, state));
  const invalid = state.invalid ?? [];
  const broken = new Map(
    [
      ...records.filter(
        (task) =>
          incidentStateProblem(task.pipelineIncident) ||
          (task.valid === false && task.pipelineIncident),
      ),
      ...invalid.filter(
        (item) =>
          item.pipelineIncident ||
          item.problems?.some((problem) => problem.includes('pipelineIncident')),
      ),
    ].map((task) => [task.id, task]),
  );
  const incidents = records.filter(
    (task) =>
      !broken.has(task.id) &&
      task.pipelineIncident &&
      (!task.pipelineIncident.verifiedAt || incidentRecoveryHeld(task.id, state)),
  );
  const fixes = new Set();
  const sources = new Set([
    ...incidents.map((task) => task.id),
    ...broken.keys(),
    ...held.map((task) => task.id),
  ]);
  const stagesOf = (task) =>
    Array.isArray(task.pipelineIncident?.affectedStages)
      ? task.pipelineIncident.affectedStages.filter((stage) => NEEDS_SESSION.includes(stage))
      : [];
  const affectedStages = new Set([...incidents, ...broken.values()].flatMap(stagesOf));
  const probes = new Set();
  const notes = [];
  for (const task of held)
    notes.push(
      `инцидент ${task.id}: адресное восстановление удерживает источник; ${state.incidentRecoveries?.[task.id]?.why ?? 'полная исправляющая доставка не подтверждена'}`,
    );
  for (const task of broken.values()) {
    const stages = stagesOf(task);
    notes.push(
      `инцидент ${task.id}: повреждены данные, источник изолирован; ` +
        (stages.length
          ? `удержаны этапы ${stages.join(', ')}`
          : 'область неизвестна, общая остановка не подтверждена'),
    );
  }
  const byId = new Map(records.map((task) => [task.id, task]));
  const visit = (id) => {
    if (fixes.has(id) || sources.has(id)) return;
    fixes.add(id);
    const task = byId.get(id);
    for (const next of [...(task?.dependsOn ?? []), ...(task?.splitInto ?? [])]) visit(next);
  };
  for (const source of incidents) {
    const incident = source.pipelineIncident;
    const probed = incident.probeStartedAt || state.scheduling?.probes?.[incident.id];
    incident.fixedBy.forEach(visit);
    const pending = pendingDependencies(
      { ...source, dependsOn: incident.fixedBy, dependencyResults: [] },
      state.tasks ?? [],
      state.closedDependencyIds ?? [],
      { records: state.dependencyRecords ?? [], invalid },
    );
    if (!pending.length && !probed && !incidentRecoveryHeld(source.id, state))
      probes.add(source.id);
    notes.push(
      `инцидент ${incident.id}: ${incident.evidence} Затронутые этапы: ${incident.affectedStages.join(', ')}. Исправления: ${incident.fixedBy.join(', ')}; ` +
        (incidentRecoveryHeld(source.id, state)
          ? 'источник удержан до полной адресной доставки исходного отчёта'
          : pending.length
            ? `ожидаем ${pending.join(', ')}`
            : probed
              ? 'проба уже выдана; ожидаем свидетельство или новый диагноз'
              : `разрешена одна проба ${source.id}:${incident.check.stage}: ${incident.check.expectation}`),
    );
  }
  const isRecovery = (task, stage) =>
    !incidentRecoveryHeld(task.id, state) &&
    !broken.has(task.id) &&
    (fixes.has(task.id) ||
      (sources.has(task.id) &&
        (stage === 'postmortem' ||
          (probes.has(task.id) && stage === task.pipelineIncident?.check.stage))));
  return {
    active: incidents.length > 0 || broken.size > 0 || held.length > 0,
    sources,
    probes,
    affectedStages,
    notes,
    isRecovery,
    allows: (task, stage) =>
      isRecovery(task, stage) || (!sources.has(task.id) && !affectedStages.has(stage)),
  };
}
