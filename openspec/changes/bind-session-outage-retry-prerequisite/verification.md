# Проверка предусловия 0243

## Источник и согласование документов

Проверка implement 07.09.2026. Назначенная ветка 0247 подтверждена, дерево исходно чистое. `git -C . fetch origin` выполнен, `git -C . merge origin/main` ответил `Already up to date.` Установка `pnpm install --frozen-lockfile --prefer-offline` завершилась успешно.

В свежей базе каталог `stop-launches-on-session-outages` отсутствовал. Полный каталог из шести файлов перенесён только в дерево 0247 командой `git -C . restore --source=17aed1e1b0766c4e08f89e5542528559c7fdb9dd -- openspec/changes/stop-launches-on-session-outages`. Источник — опубликованная ветка `origin/worktree-0243-ostanavlivat-novye-zapuski-pri-nesostoya`; её SHA подтверждён после fetch. Код 0243 не переносился, её дерево не изменялось.

После явного добавления шести новых для этой ветки файлов `git -C . diff 17aed1e1b0766c4e08f89e5542528559c7fdb9dd -- openspec/changes/stop-launches-on-session-outages` показывает изменения только design.md и tasks.md. До добавления Git считал неотслеживаемые файлы отсутствующими при сравнении с другой ревизией; тот предварительный вывод не использован как результат проверки.

Дословно сохранены `.openspec.yaml`, README.md, proposal.md и `specs/pipeline-supervision-resilience/spec.md`. Все четыре чекбокса 0243 и их содержание сохранены; алгоритмы и сценарии не менялись. Добавлены общее удержание до closed 0242 и MERGED PR 177, его охват модели 1.1 и resume, повторная проверка перед 3.1, проверка предка mergeCommit и наличия dependencyUpdates/readStartTask после обновления дерева. Самостоятельность коммита не разрешает раннюю сессию. Порядок поставки 0243/0244 действует после общего допуска.

`openspec validate stop-launches-on-session-outages --strict` завершился кодом 0: `Change 'stop-launches-on-session-outages' is valid`. Проверка Prettier двух изменённых плановых файлов прошла.

Git предупреждает об отказе чтения `C:\Users\dmitry.ivanov/.config/git/ignore`; команды завершаются успешно, обход ограничений не выполнялся.

## Поставка канала

`gh pr view 177 --json number,state,mergedAt,baseRefName,mergeCommit,headRefOid` вернул:

```json
{
  "baseRefName": "main",
  "headRefOid": "4c9ed9a2c3140d2fbfc66155f28096eb30c84bd3",
  "mergeCommit": null,
  "mergedAt": null,
  "number": 177,
  "state": "OPEN"
}
```

Поставка канала и ревизия принимающего супервизора не подтверждены. Поле dependencyUpdates пока не передаётся, запись карточки и независимый GET не объявляются выполненными. Пункт 2.1 остаётся открытым до готовности канала и проверки его поставленных тестов. Реальная failed-карточка не читалась и не изменялась. Review должен повторно сверить актуальную ветку 0243 и проверить последующее свидетельство записи метаданных.

## Изолированная матрица

Матрица прошла: 95 сценариев, каждый повторён на двух свежих снимках через scan и runCycle (380 проверок решений). Сравнивается весь вход до/после, включая этап, returnTo, attempts, прочие зависимости и контрольные метаданные. Существующий `npx vitest run --root supervisor lib/dependency-state.test.mjs` также прошёл: 17/17 тестов. Формат verification.md проверен. Тесты адресного канала из PR 177 пока не запускались: канал не поставлен; код соседней ветки ради этой проверки не переносился.

Команда: `node .matchlog/0247-prerequisite.mjs`. Проверяются существующие pendingDependencies, buildDependencyState, scan и runCycle с внедрённым runner. Никакое рассчитанное действие не исполняется.

Исходный текст:

```javascript
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pendingDependencies } from '../supervisor/lib/dependencies.mjs';
import { buildDependencyState } from '../supervisor/lib/dependency-state.mjs';
import { createCommandRunner } from '../supervisor/lib/command-runner.mjs';
import { resolveConfig } from '../supervisor/config/defaults.mjs';
import { scan } from '../supervisor/lib/scan.mjs';
import { runCycle } from '../supervisor/lib/cycle.mjs';

const consumer = '0243-ostanavlivat-novye-zapuski-pri-nesostoya';
const predecessor = '0242-dat-otchetu-etapa-adresnoe-poruchenie-na';
const control = '0073-zadacha-umeet-zhdat-druguyu-preduslovie-';
const child = '0900-isolated-child';
const root = process.cwd();
const { config } = resolveConfig({
  commands: { verify: 'x', deploy: 'x', perf: 'x' },
  provider: 'claude',
  mainBranch: 'main',
  maxConcurrent: 1,
  maxTaskCostUsd: 100,
});
const merged = { number: 177, state: 'MERGED', mergedAt: '2026-09-07T00:00:00Z', baseRefName: 'main' };
const task = (id, extra = {}) => ({
  id, type: 'feature', status: 'closed', priority: 20,
  createdAt: '2026-09-07T00:00:00Z', returnTo: null,
  attempts: { continuations: 0, cycleFailures: 0, spawnFailures: 0, apiErrors: 0, rejections: 0 },
  ...extra,
});
const fixture = (status, resume, exceeded) => [
  task(consumer, {
    status, returnTo: 'audit',
    ...(resume ? { sessionId: 'isolated-prior-session' } : {}),
    dependsOn: [control, predecessor],
    dependencyResults: [
      { taskId: control, kind: 'merged-pr', pr: 171 },
      { taskId: predecessor, kind: 'merged-pr', pr: 177 },
    ],
    metadata: { keep: ['human-text', 'unknown-field'] },
    ...(exceeded ? {
      spentUsd: 1e9,
      attempts: { continuations: 999, cycleFailures: 999, spawnFailures: 999, apiErrors: 999, rejections: 999 },
    } : {}),
  }),
  task(predecessor, { links: { pr: 177 }, splitInto: [child] }),
  task(control, { links: { pr: 171 } }),
  task(child),
];
const registry = { entries: [{ taskId: consumer, branch: `worktree-${consumer}`, path: '.claude/worktrees/isolated' }] };
const output = [];
let cases = 0;
async function check(label, { tasks = fixture('implement', false, false), value = merged,
  fault, running = [], reports = [], extra = {}, expected = 'held', noRead = false } = {}) {
  const snapshot = structuredClone({ tasks, running, reports, registry, extra });
  let calls = 0;
  const exec = (_file, args) => {
    calls += 1;
    const pr = Number(args[2]);
    assert.ok([171, 177].includes(pr));
    if (pr === 171) return JSON.stringify({ ...merged, number: 171 });
    if (fault === 'throw') throw new Error('isolated evidence unavailable');
    if (fault === 'json') return '{invalid';
    return JSON.stringify(value);
  };
  for (let repeat = 0; repeat < 2; repeat += 1) {
    const state = await buildDependencyState({
      backlog: { tasks }, config, root,
      run: createCommandRunner(root, exec), running, reports,
    });
    const pending = pendingDependencies(tasks[0], tasks, [], {
      evidence: state.dependencyEvidence, mainBranch: config.mainBranch,
    });
    const input = { ...state, registry, config, ...extra };
    const before = structuredClone(input);
    for (const mode of ['scan', 'cycle']) {
      const result = mode === 'scan' ? scan(input) : runCycle({
        state: input, config, git: { tail: () => 0, behind: () => 0 },
        now: '2026-09-07T00:00:00Z', pid: 1, lock: null, ourAuthors: [], elapsed: () => 0,
      });
      const own = result.actions.filter((action) => action.taskId === consumer);
      if (expected === 'held') {
        assert.ok(pending.length > 0, label);
        assert.equal(own.length, 0, label);
        assert.ok(result.notes.some((note) => note.includes(consumer)), label);
      } else if (expected === 'none') {
        assert.equal(own.length, 0, label);
      } else {
        assert.equal(own.length, 1, label);
        assert.equal(own[0].kind, expected, label);
      }
      assert.deepEqual(input, before, `${label}: entire scan input`);
      assert.deepEqual({ tasks, running, reports, registry, extra }, snapshot, label);
      cases += 1;
    }
  }
  if (noRead) assert.equal(calls, 0, label);
  if (fault) assert.equal(calls, 4, `${label}: fresh reads for both PRs on each snapshot`);
  output.push(`PASS ${label}: ${expected}, repeat x2, scan + runCycle, snapshot unchanged`);
}

const negatives = [
  ['OPEN', { value: { ...merged, state: 'OPEN', mergedAt: null } }],
  ['CLOSED without merge', { value: { ...merged, state: 'CLOSED', mergedAt: null } }],
  ['no evidence', { value: null }],
  ['runner error', { fault: 'throw' }],
  ['invalid JSON', { fault: 'json' }],
  ['wrong number', { value: { ...merged, number: 178 } }],
  ['wrong base', { value: { ...merged, baseRefName: 'other' } }],
  ['invalid mergedAt', { value: { ...merged, mergedAt: 'invalid' } }],
  ['missing mergedAt', { value: { ...merged, mergedAt: null } }],
  ['links mismatch', { mutate: (tasks) => { tasks[1].links.pr = 178; } }],
  ...['pr', 'review', 'deploy'].map((status) => [
    `predecessor ${status}`, { mutate: (tasks) => { tasks[1].status = status; } },
  ]),
];
for (const [status, resume] of [['new', false], ['implement', false], ['implement', true]]) {
  for (const exceeded of [false, true]) {
    for (const [label, { mutate, ...options }] of negatives) {
      const tasks = fixture(status, resume, exceeded);
      mutate?.(tasks);
      await check(`${status}/resume=${resume}/limits=${exceeded}: ${label}`, { tasks, ...options });
    }
  }
  await check(`${status}/resume=${resume}: admitted`, {
    tasks: fixture(status, resume, false), expected: status === 'new' ? 'start-stage' : 'continue-stage',
  });
  for (const index of [2, 3]) {
    const tasks = fixture(status, resume, false);
    tasks[index].status = 'awaiting-po';
    await check(`${status}/resume=${resume}: other dependency/child ${index}`, { tasks });
  }
}
await check('continuation limit still applies', { tasks: fixture('implement', true, true), expected: 'fail-stage' });
const costly = fixture('implement', false, false);
costly[0].spentUsd = 1e9;
await check('cost limit still applies', { tasks: costly, expected: 'decompose-again' });
const spawnCapped = fixture('implement', false, false);
spawnCapped[0].attempts.spawnFailures = 999;
await check('spawn limit still applies', { tasks: spawnCapped, expected: 'fail-stage' });
await check('no free slot', { running: [{ taskId: '0901-busy', stage: 'implement' }], expected: 'none' });
const exclusive = fixture('implement', false, false);
exclusive.push(task('0901-busy', { status: 'deploy' }));
await check('live exclusive with free slot', {
  tasks: exclusive, running: [{ taskId: '0901-busy', stage: 'deploy' }],
  extra: { config: { ...config, maxConcurrent: 2 } }, expected: 'none',
});
const failed = fixture('failed', false, false);
failed[0].returnTo = null;
await check('failed without recovery stays failed', { tasks: failed, expected: 'none', noRead: true });
await check('live consumer survives OPEN', {
  value: { ...merged, state: 'OPEN' }, running: [{ taskId: consumer, stage: 'implement' }],
  expected: 'none', noRead: true,
});
await check('ready report survives OPEN', {
  value: { ...merged, state: 'OPEN' }, reports: [{ taskId: consumer, stage: 'implement', outcome: 'done' }],
  expected: 'transfer-report', noRead: true,
});
output.push(`PASS total: ${cases} assertions of decisions; no actions executed, no Trello, no spawn.`);
console.log(output.join('\n'));

// Сохраняем воспроизводимую пробу и её вывод, не отчёт этапа и не данные доски.
const verification = new URL('../openspec/changes/bind-session-outage-retry-prerequisite/verification.md', import.meta.url);
const marker = '\n## Изолированная матрица\n';
const previous = readFileSync(verification, 'utf8').split(marker)[0];
writeFileSync(verification, previous + marker + '\nКоманда: `node .matchlog/0247-prerequisite.mjs`. Проверяются существующие pendingDependencies, buildDependencyState, scan и runCycle с внедрённым runner. Никакое рассчитанное действие не исполняется.\n\nИсходный текст:\n\n```javascript\n' + readFileSync(new URL(import.meta.url), 'utf8') + '```\n\nПолный вывод:\n\n```text\n' + output.join('\n') + '\n```\n');
```

Полный вывод:

```text
PASS new/resume=false/limits=false: OPEN: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=false: CLOSED without merge: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=false: no evidence: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=false: runner error: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=false: invalid JSON: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=false: wrong number: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=false: wrong base: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=false: invalid mergedAt: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=false: missing mergedAt: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=false: links mismatch: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=false: predecessor pr: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=false: predecessor review: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=false: predecessor deploy: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=true: OPEN: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=true: CLOSED without merge: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=true: no evidence: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=true: runner error: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=true: invalid JSON: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=true: wrong number: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=true: wrong base: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=true: invalid mergedAt: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=true: missing mergedAt: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=true: links mismatch: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=true: predecessor pr: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=true: predecessor review: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false/limits=true: predecessor deploy: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false: admitted: start-stage, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false: other dependency/child 2: held, repeat x2, scan + runCycle, snapshot unchanged
PASS new/resume=false: other dependency/child 3: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=false: OPEN: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=false: CLOSED without merge: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=false: no evidence: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=false: runner error: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=false: invalid JSON: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=false: wrong number: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=false: wrong base: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=false: invalid mergedAt: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=false: missing mergedAt: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=false: links mismatch: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=false: predecessor pr: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=false: predecessor review: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=false: predecessor deploy: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=true: OPEN: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=true: CLOSED without merge: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=true: no evidence: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=true: runner error: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=true: invalid JSON: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=true: wrong number: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=true: wrong base: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=true: invalid mergedAt: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=true: missing mergedAt: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=true: links mismatch: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=true: predecessor pr: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=true: predecessor review: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false/limits=true: predecessor deploy: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false: admitted: continue-stage, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false: other dependency/child 2: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=false: other dependency/child 3: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=false: OPEN: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=false: CLOSED without merge: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=false: no evidence: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=false: runner error: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=false: invalid JSON: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=false: wrong number: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=false: wrong base: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=false: invalid mergedAt: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=false: missing mergedAt: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=false: links mismatch: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=false: predecessor pr: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=false: predecessor review: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=false: predecessor deploy: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=true: OPEN: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=true: CLOSED without merge: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=true: no evidence: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=true: runner error: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=true: invalid JSON: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=true: wrong number: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=true: wrong base: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=true: invalid mergedAt: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=true: missing mergedAt: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=true: links mismatch: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=true: predecessor pr: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=true: predecessor review: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true/limits=true: predecessor deploy: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true: admitted: continue-stage, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true: other dependency/child 2: held, repeat x2, scan + runCycle, snapshot unchanged
PASS implement/resume=true: other dependency/child 3: held, repeat x2, scan + runCycle, snapshot unchanged
PASS continuation limit still applies: fail-stage, repeat x2, scan + runCycle, snapshot unchanged
PASS cost limit still applies: decompose-again, repeat x2, scan + runCycle, snapshot unchanged
PASS spawn limit still applies: fail-stage, repeat x2, scan + runCycle, snapshot unchanged
PASS no free slot: none, repeat x2, scan + runCycle, snapshot unchanged
PASS live exclusive with free slot: none, repeat x2, scan + runCycle, snapshot unchanged
PASS failed without recovery stays failed: none, repeat x2, scan + runCycle, snapshot unchanged
PASS live consumer survives OPEN: none, repeat x2, scan + runCycle, snapshot unchanged
PASS ready report survives OPEN: transfer-report, repeat x2, scan + runCycle, snapshot unchanged
PASS total: 380 assertions of decisions; no actions executed, no Trello, no spawn.
```
