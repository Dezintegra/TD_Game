import { createHash } from 'node:crypto';
import { NEEDS_SESSION } from '../config/transitions.mjs';
import { pendingDependencies } from './dependencies.mjs';

const text = (value) => typeof value === 'string' && value.trim().length > 0;
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const CHECK_STAGES = NEEDS_SESSION.filter((stage) => stage !== 'postmortem');

export function incidentDeclarationProblem(value, task, report) {
  if (value === undefined) return null;
  if (report.stage !== 'postmortem' || report.outcome !== 'done' || report.causedBy !== 'pipeline')
    return 'pipelineIncident принимается только из успешного разбора общей поломки конвейера';
  if (
    !value ||
    !text(value.evidence) ||
    !Array.isArray(value.affectedStages) ||
    !value.affectedStages.length ||
    value.affectedStages.some((stage) => !CHECK_STAGES.includes(stage)) ||
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
    value.affectedStages.some((stage) => !CHECK_STAGES.includes(stage)) ||
    !value.check ||
    !CHECK_STAGES.includes(value.check.stage) ||
    !text(value.check.expectation) ||
    !value.affectedStages.includes(value.check.stage) ||
    (value.probeStartedAt != null && !date(value.probeStartedAt)) ||
    (value.verifiedAt != null && (!date(value.verifiedAt) || !text(value.verificationEvidence)))
  )
    return 'неполный pipelineIncident: выдача удержана до восстановления данных инцидента';
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
    evidence: declaration.evidence,
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
  if (
    report.outcome !== 'done' ||
    !incident.probeStartedAt ||
    !result ||
    result.incidentId !== incident.id ||
    result.passed !== true ||
    !text(result.evidence)
  )
    return {
      problem: `инцидент ${incident.id}: проверка восстановления не подтверждена; нужен пересмотр диагноза`,
    };
  return { incident: { ...incident, verifiedAt: now, verificationEvidence: result.evidence } };
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

/** Разрешены только источник диагноза, исправления и их необходимые зависимости/части. */
export function incidentPolicy(state) {
  const records = [...(state.tasks ?? []), ...(state.dependencyRecords ?? [])];
  const invalid = state.invalid ?? [];
  const broken = records.find((task) => incidentStateProblem(task.pipelineIncident));
  const badCard = invalid.find((item) =>
    item.problems?.some((problem) => problem.includes('pipelineIncident')),
  );
  if (broken || badCard)
    return {
      active: true,
      allows: () => false,
      probes: new Set(),
      sources: new Set(),
      notes: [`инцидент ${broken?.id ?? badCard.id}: повреждены данные, выдача удержана`],
    };
  const incidents = records.filter(
    (task) => task.pipelineIncident && !task.pipelineIncident.verifiedAt,
  );
  const fixes = new Set();
  const sources = new Set(incidents.map((task) => task.id));
  const probes = new Set();
  const notes = [];
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
    if (!pending.length && !probed) probes.add(source.id);
    notes.push(
      `инцидент ${incident.id}: ${incident.evidence} Исправления: ${incident.fixedBy.join(', ')}; ` +
        (pending.length
          ? `ожидаем ${pending.join(', ')}`
          : probed
            ? 'проба уже выдана; ожидаем свидетельство или новый диагноз'
            : `разрешена одна проба ${source.id}:${incident.check.stage}: ${incident.check.expectation}`),
    );
  }
  return {
    active: incidents.length > 0,
    sources,
    probes,
    notes,
    allows: (task, stage) =>
      !incidents.length ||
      fixes.has(task.id) ||
      (sources.has(task.id) &&
        (stage === 'postmortem' ||
          (probes.has(task.id) && stage === task.pipelineIncident.check.stage))),
  };
}
