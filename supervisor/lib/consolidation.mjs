import { dependencyCycleProblem, pendingCompletion } from './dependencies.mjs';
import { applyTransition } from './task-file.mjs';

const SOURCE_STATES = ['candidate', 'new', 'maintenance', 'failed', 'awaiting-po'];
const TARGET_STATES = ['candidate', 'new', 'maintenance', 'token-limit'];

/** Семантический вывод делает аналитик; сохранность требований и маршрута проверяет код. */
export function planConsolidations(items, { tasks, originId, stage, machine, busy, entryOf, now }) {
  const operations = [],
    rejected = [];
  if (items == null) return { operations, rejected };
  if (
    !Array.isArray(items) ||
    items.length > 5 ||
    !['decompose', 'design', 'triage', 'postmortem', 'interpret'].includes(stage)
  )
    return {
      operations,
      rejected: ['поглощение допустимо только ограниченным отчётом аналитического этапа'],
    };
  const known = new Map(tasks.map((t) => [t.id, t]));
  const targets = new Map(),
    sources = new Map();
  const sourceIds = items.map((i) => i?.sourceId);
  for (const item of items) {
    const source = known.get(item?.sourceId),
      target = targets.get(item?.targetId) ?? known.get(item?.targetId);
    const reject = (why) => rejected.push(`${item?.sourceId ?? '?'}: ${why}`);
    if (
      !source ||
      !target ||
      source.id === target.id ||
      [source.id, target.id].includes(originId) ||
      sourceIds.includes(target.id) ||
      sources.has(source.id)
    ) {
      reject('неоднозначные участники или цепочка внутри одного отчёта');
      continue;
    }
    if (
      !['absorb', 'duplicate'].includes(item.mode) ||
      typeof item.evidence !== 'string' ||
      !item.evidence.trim() ||
      typeof item.coverage !== 'string' ||
      !item.coverage.trim()
    ) {
      reject('нужны mode, evidence и соответствие требований coverage');
      continue;
    }
    if (
      [source, target].some((task) => task.pipelineIncident && !task.pipelineIncident.verifiedAt)
    ) {
      reject('инцидент требует проверки исходного пути до поглощения карточки');
      continue;
    }
    if (
      !SOURCE_STATES.includes(source.status) ||
      source.links?.pr ||
      source.splitInto?.length ||
      (source.type === 'feature' && source.links?.change) ||
      entryOf?.(source.id)
    ) {
      reject('исходная задача уже начата либо имеет ресурсы/продолжения');
      continue;
    }
    if (
      (source.owner && source.owner !== machine) ||
      (target.owner && target.owner !== machine) ||
      typeof busy !== 'function' ||
      busy(source.id) ||
      busy(target.id)
    ) {
      reject('живость и владение участников не подтверждены');
      continue;
    }
    if (item.mode === 'duplicate') {
      if (target.status !== 'completed' || pendingCompletion(target.id, tasks).length) {
        reject('выполнение преемника не доказано');
        continue;
      }
    } else if (!TARGET_STATES.includes(target.status)) {
      reject('принимающая задача уже исполняется');
      continue;
    }
    const nextSource = {
      ...source,
      splitInto: [target.id],
      closureReason: `Передано в ${target.id}. ${item.evidence.trim()}\nСоответствие требований: ${item.coverage.trim()}`,
    };
    const all = [...known.values()].map(
      (t) => sources.get(t.id) ?? (t.id === source.id ? nextSource : t),
    );
    if (dependencyCycleProblem(nextSource, all)) {
      reject('замещение создаёт цикл зависимостей');
      continue;
    }
    if (item.mode === 'absorb') {
      const marker = `## Требования из ${source.id}`;
      const section = `${marker}\n\n${source.title}\n\n${source.description}\n\nСоответствие: ${item.coverage.trim()}`;
      const description = target.description?.includes(section)
        ? target.description
        : `${target.description}\n\n${section}`;
      // Оставляем место служебным полям в ограниченном описании Trello.
      if (
        description.length + JSON.stringify(target).length - String(target.description).length >
        14500
      ) {
        reject('требования не помещаются без потери данных');
        continue;
      }
      const nextTarget = {
        ...target,
        description,
        links: {
          ...target.links,
          related: [...new Set([...(target.links?.related ?? []), source.id])],
        },
      };
      if (target.status === 'token-limit' && target.type === 'feature' && target.tokenHold)
        nextTarget.tokenHold = { ...target.tokenHold, resumeStatus: 'design' };
      targets.set(target.id, nextTarget);
    }
    const moved = applyTransition(nextSource, {
      status: 'closed',
      note: nextSource.closureReason,
      now,
      consolidation: true,
    });
    if (!moved.task) {
      reject(moved.problems.join('; '));
      continue;
    }
    const closed = { ...moved.task, owner: null, returnTo: null };
    delete closed.question;
    sources.set(source.id, closed);
  }
  // Все требования сохранены до первого закрытия; каждый получатель записывается один раз.
  for (const next of [...targets.values(), ...sources.values()])
    operations.push({
      task: next,
      journal: {
        at: now,
        from: known.get(next.id).status,
        to: next.status,
        what: next.closureReason ?? 'Сохранены требования поглощённых задач',
        ...(next.closureReason ? { closureReason: next.closureReason } : {}),
      },
    });
  return { operations, rejected };
}

/** Объявленная область исправляется аналитиком; категория infrastructure её не заменяет. */
export function planClassifications(
  items,
  { tasks, originId, stage, machine, busy, now, reserved = [] },
) {
  const operations = [],
    rejected = [];
  if (items == null) return { operations, rejected };
  if (
    !Array.isArray(items) ||
    items.length > 8 ||
    !['decompose', 'design', 'triage', 'postmortem', 'interpret'].includes(stage)
  )
    return { operations, rejected: ['неверный пакет classifications'] };
  const seen = new Set(reserved);
  for (const item of items) {
    const task = tasks.find((t) => t.id === item?.taskId);
    if (
      !task ||
      task.id === originId ||
      seen.has(task.id) ||
      task.status !== 'candidate' ||
      item.area !== 'pipeline' ||
      typeof item.evidence !== 'string' ||
      !item.evidence.trim() ||
      (task.owner && task.owner !== machine) ||
      typeof busy !== 'function' ||
      busy(task.id)
    ) {
      rejected.push(`классификация ${item?.taskId ?? '?'} не подтверждена`);
      continue;
    }
    seen.add(task.id);
    const moved = applyTransition(
      { ...task, area: 'pipeline' },
      { status: 'maintenance', note: item.evidence, now },
    );
    if (!moved.task) {
      rejected.push(moved.problems.join('; '));
      continue;
    }
    operations.push({
      task: moved.task,
      journal: {
        at: now,
        from: 'candidate',
        to: 'maintenance',
        what: `Уточнена область конвейера: ${item.evidence}`,
      },
    });
  }
  return { operations, rejected };
}

/** Возврат остановленной одобренной работы требует доказательства и сохраняет общий предел возвратов. */
export function planResumptions(
  items,
  { tasks, originId, stage, machine, busy, now, reserved = [], maxReturns = 2 },
) {
  const operations = [],
    rejected = [];
  if (items == null) return { operations, rejected };
  if (!Array.isArray(items) || items.length > 5 || !['triage', 'postmortem'].includes(stage))
    return { operations, rejected: ['неверный пакет resumptions'] };
  const seen = new Set(reserved);
  for (const item of items) {
    const task = tasks.find((t) => t.id === item?.taskId);
    const target = item?.stage;
    if (
      !task ||
      task.id === originId ||
      seen.has(task.id) ||
      task.status !== 'failed' ||
      task.tokenHold ||
      task.flags?.includes('unparsed') ||
      target !== task.returnTo ||
      ![
        'decompose',
        'design',
        'audit',
        'implement',
        'revise',
        'pr',
        'review',
        'benchmark',
        'interpret',
        'triage',
      ].includes(target) ||
      typeof item.evidence !== 'string' ||
      !item.evidence.trim() ||
      typeof busy !== 'function' ||
      busy(task.id) ||
      (task.owner && task.owner !== machine) ||
      (task.recovery?.returns ?? 0) >= maxReturns
    ) {
      rejected.push(`возврат ${item?.taskId ?? '?'} не подтверждён или исчерпан`);
      continue;
    }
    const moved = applyTransition(task, {
      status: target,
      note: `Причина остановки устранена: ${item.evidence}`,
      now,
    });
    if (!moved.task) {
      rejected.push(moved.problems.join('; '));
      continue;
    }
    seen.add(task.id);
    operations.push({
      task: {
        ...moved.task,
        owner: task.owner ?? machine,
        attempts: {
          continuations: 0,
          cycleFailures: 0,
          rejections: 0,
          spawnFailures: 0,
          apiErrors: 0,
        },
        recovery: {
          ...task.recovery,
          causedBy: null,
          fixedBy: [],
          returns: (task.recovery?.returns ?? 0) + 1,
        },
      },
      journal: {
        at: now,
        from: 'failed',
        to: target,
        what: `Проверен возврат на сохранённый этап: ${item.evidence}`,
      },
    });
  }
  return { operations, rejected };
}
