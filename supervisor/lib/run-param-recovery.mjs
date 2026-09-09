import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { splitDescription } from './card.mjs';
import { hasReceipt } from './report-receipts.mjs';
import { stagePrompt } from './stage-prompt.mjs';
import { benchmarkRunProblem } from './run-params.mjs';

export const runParamRecoveries = JSON.parse(
  readFileSync(new URL('../config/run-param-recoveries.json', import.meta.url), 'utf8'),
);

export const recoveryKey = (recipe, part) =>
  `run-params:${recipe.targetTaskId}:${recipe.sourceTaskId}:${recipe.sourceStage}:${recipe.launchId}:${recipe.requestKey}:${part}`;

export function paramsFromPrompt(prompt) {
  const section = prompt.split('## Задача\n\n```json\n')[1];
  if (!section) throw new Error('в назначении нет JSON задачи');
  return JSON.parse(section.split('\n```')[0]).run?.params;
}

/** Квитанция не заменяет сравнение полного заказа при каждом реальном допуске. */
export function recoveredOrderProblem(task, recipes = runParamRecoveries) {
  const recipe = recipes.find((item) => item.targetTaskId === task?.id);
  if (!recipe) return null;
  if (!isDeepStrictEqual(task.run?.params, recipe.params))
    return `${task.id}: run.params не совпадают с подтверждённым заказом ${recipe.requestKey}`;
  if (!hasReceipt(task, recoveryKey(recipe, 'ready')))
    return `${task.id}: run.params ещё не подтверждены новым снимком и назначением`;
  return null;
}

/** Сверка той же сборкой промпта, которую использует порождение этапа. */
export function confirmRecoveredAssignment(assignment, makePrompt = stagePrompt) {
  const task = assignment.task;
  const recipe = runParamRecoveries.find((item) => item.targetTaskId === task?.id);
  if (!recipe) return assignment;
  const problem = recoveredOrderProblem(task);
  if (problem) throw new Error(problem);
  const params = paramsFromPrompt(makePrompt({ assignment, task }));
  if (!isDeepStrictEqual(params, recipe.params))
    throw new Error(`${task.id}: run.params потеряны при сборке назначения`);
  return {
    ...assignment,
    reason: [
      assignment.reason,
      `run.params сверены при подготовке benchmark: ${recipe.requestKey}, launchId ${recipe.launchId}; новый снимок и назначение совпадают.`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/** Отложенная запись не должна блокировать доставку уже готового отчёта. */
export const afterRunParamRecovery = (actions, deferred) =>
  actions.filter(
    (action) =>
      action.kind === 'transfer-report' ||
      ![action.taskId, ...(action.batch ?? [])].some((id) => deferred.has(id)),
  );

const empty = (params) =>
  params &&
  typeof params === 'object' &&
  !Array.isArray(params) &&
  Object.keys(params).length === 0;
const occupied = (items, id) =>
  items.some((item) => item.taskId === id || item.batch?.includes(id));

/** Только владелец цикла передаёт полный независимый снимок; никаких чтений доски из агента. */
export async function recoverRunParams({
  store,
  snapshot,
  mayWrite,
  ownsCycle,
  machine,
  running = [],
  reports = [],
  maxAutoReturns,
  now,
  recipes = runParamRecoveries,
  makePrompt = stagePrompt,
}) {
  const deferred = new Set();
  const notes = [];
  const diagnostics = [];
  for (const recipe of recipes) {
    const id = recipe.targetTaskId;
    let canJournal = false;
    const diagnose = (why) => {
      deferred.add(id);
      notes.push(`${id}: восстановление run.params: ${why}`);
      if (canJournal) diagnostics.push({ id, why, key: recoveryKey(recipe, `diagnostic:${why}`) });
    };
    if (
      !mayWrite ||
      !ownsCycle ||
      !store ||
      snapshot?.ok !== true ||
      !Array.isArray(snapshot.cards)
    ) {
      diagnose('нет права записи, владения циклом или полного свежего снимка');
      continue;
    }
    if (occupied(running, id) || occupied(reports, id)) {
      diagnose('есть живой запуск или неприменённый отчёт');
      continue;
    }
    const matching = (taskId) =>
      snapshot.cards.filter((card) => splitDescription(card.desc).meta?.id === taskId);
    const targets = matching(id);
    if (targets.length !== 1 || targets[0].closed || matching(recipe.sourceTaskId).length !== 1) {
      diagnose('карточка отсутствует, архивирована или ID неоднозначен');
      continue;
    }
    const task = store.readTask(id);
    const source = store.readTask(recipe.sourceTaskId);
    if (!task || (task.owner && task.owner !== machine)) {
      diagnose('карточка недоступна либо имеет чужого владельца');
      continue;
    }
    canJournal = true;
    // Завершённый замер не становится новым заказом от появления рецепта.
    if (task.links?.run || ['interpret', 'completed', 'closed', 'cleanup'].includes(task.status))
      continue;
    const ready = hasReceipt(task, recoveryKey(recipe, 'ready'));
    if (ready && !task.recovery?.fixedBy?.includes(recipe.fixedByTaskId)) {
      if (recoveredOrderProblem(task, [recipe])) diagnose('подтверждённый заказ изменился');
      continue;
    }
    if (task.status !== 'failed') {
      if (!ready || recoveredOrderProblem(task, [recipe]))
        diagnose('заказ не подтверждён или изменился после возврата');
      continue;
    }
    if (
      task.type !== 'run' ||
      task.run?.kind !== 'arena' ||
      !task.run?.expectation?.trim() ||
      !task.links?.related?.includes(recipe.sourceTaskId) ||
      !source?.dependsOn?.includes(id)
    ) {
      diagnose('тип, ожидание или связь с исходной задачей не подтверждены');
      continue;
    }
    if (
      task.returnTo !== 'benchmark' ||
      !Number.isInteger(maxAutoReturns) ||
      (task.recovery?.returns ?? 0) >= maxAutoReturns
    ) {
      diagnose('returnTo не benchmark или предел автоматических возвратов исчерпан');
      continue;
    }
    const equal = isDeepStrictEqual(task.run.params, recipe.params);
    const written = hasReceipt(task, recoveryKey(recipe, 'written'));
    if (!equal && (written || (Object.hasOwn(task.run, 'params') && !empty(task.run.params)))) {
      diagnose('конфликт с существующим заказом; перезапись запрещена');
      continue;
    }
    const invalid = benchmarkRunProblem({ kind: 'arena', params: recipe.params });
    if (invalid) {
      diagnose(`негодный рецепт: ${invalid}`);
      continue;
    }
    const origin = `${recipe.sourceTaskId}, ${recipe.sourceStage}, launchId ${recipe.launchId}, requestKey ${recipe.requestKey}`;
    const save = async (next, part, what) => {
      const current = store.readTask(id);
      const result = await store.saveTask(
        next,
        { at: now, from: 'failed', to: 'failed', source: 'supervisor', what },
        'restore run parameters',
        [],
        { key: recoveryKey(recipe, part), expected: current },
      );
      if (!result.ok) throw new Error(result.why ?? result.outcome ?? 'запись не подтверждена');
    };
    try {
      await save(
        { ...task, run: { ...task.run, params: recipe.params } },
        'written',
        `Параметры записаны из ${origin}. Требуется следующий независимый снимок.`,
      );
      if (!written) {
        deferred.add(id);
        continue;
      }
      // task взят ДО saveTask: обновлённый byId не является новым чтением.
      const assignment = { taskId: id, stage: 'benchmark', task };
      const params = paramsFromPrompt(makePrompt({ assignment, task }));
      if (!equal || !isDeepStrictEqual(params, recipe.params))
        throw new Error('новый снимок или промпт потерял run.params');
      await save(
        store.readTask(id),
        'confirmed',
        `Подтверждены новый независимый снимок и назначение benchmark. Источник: ${origin}.\n\nТочные run.params:\n\n\`\`\`json\n${JSON.stringify(recipe.params, null, 2)}\n\`\`\``,
      );
      // Эта запись идёт только ПОСЛЕ успешной доставки подтверждающего комментария.
      const current = store.readTask(id);
      await save(
        {
          ...current,
          recovery: {
            ...current.recovery,
            causedBy: 'pipeline',
            fixedBy: [...new Set([...(current.recovery?.fixedBy ?? []), recipe.fixedByTaskId])],
            returns: current.recovery?.returns ?? 0,
          },
        },
        'ready',
        `Заказ подтверждён; штатный возврат ожидает завершения ${recipe.fixedByTaskId} и остальных починок.`,
      );
      if (!ready) deferred.add(id);
    } catch (error) {
      diagnose(error.message);
    }
  }
  for (const { id, why, key } of diagnostics) {
    try {
      const result = await store.amendTask(
        id,
        `Восстановление run.params остановлено: ${why}`,
        'run parameter recovery diagnostic',
        'supervisor',
        null,
        { key },
      );
      if (!result.ok)
        notes.push(`${id}: диагностика не доставлена: ${result.why ?? result.outcome}`);
    } catch (error) {
      notes.push(`${id}: диагностика не доставлена: ${error.message}`);
    }
  }
  return { deferred, notes };
}
