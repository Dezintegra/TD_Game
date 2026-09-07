# Проверка предусловия 0181

Дата: 2026-09-07. Проверяемая ревизия: `8c08a9d601e3f6aa06de59289968bd857a6d9229`.
Перед правкой выполнены `git -C . fetch origin` и `git -C . merge origin/main`; результат слияния: Already up to date.
Зависимости установлены `pnpm install --frozen-lockfile --prefer-offline`, код 0.

## Результат пункта 1.1

53 адресных сценария прошли. Пятнадцать отрицательных входов проверены при всех пяти счётчиках attempts, равных 0, 1 и 999; каждое решение повторено на неизменном снимке. Причина удержания проверяется через настоящий pendingDependencies и заметку scan, а не только отсутствие запуска. Положительный контроль до и после отрицательных снимков выдаёт continue-stage implement. Живой этап сохраняется, готовый отчёт передаётся. Положительное доказательство не выводит failed из восстановления; пауза, квота и awaiting-po остаются ограничениями.

Проба импортирует настоящие buildDependencyState, collectDependencyEvidence (через сборщик), pendingDependencies и scan. Подменён только runner GitHub; Trello, реальный запуск этапов и запись карточек не вызываются. Все входы приведены в исходнике ниже. Это модель поведения при уже записанном условии, НЕ подтверждение изменения карточки 0181.

## Препятствие пункту 2.1

`gh pr view 177 --json number,state,mergedAt,baseRefName` вернул код 0:

```text
{"baseRefName":"main","mergedAt":null,"number":177,"state":"OPEN"}
```

`rg -n dependencyUpdates supervisor/lib` завершился с кодом 1, совпадений нет. Канал 0242 не поставлен на проверяемой базе; сведений о ревизиях активных принимающих супервизоров нет. Пункт 2.1 остаётся открытым. Payload не передаётся, реальная запись/readback, идемпотентность адресного адаптера и защита устаревшего старта не объявляются проверенными. Рекомендация — завершить существующую поставку 0242 и подтвердить ревизии активных станций, затем продолжить 2.1; альтернативное продолжение ожидания сохраняет блокировку задачи и откладывает закрепление. Механизм не дублировать.

`gh pr view 132 --json number,state,mergedAt,baseRefName` вернул код 0:

```text
{"baseRefName":"main","mergedAt":null,"number":132,"state":"OPEN"}
```

Реальный PR 132 ещё не разрешает запуск. После передачи и readback супервизора review должен независимо подтвердить обе записи и сохранность прежних данных. Перед отдельной реализацией 0181 обязательны свежая main и proposal.md, design.md, tasks.md mark-every-command-block либо их единственная архивная копия; без документов правку не начинать. Чужие деревья, живые процессы и postmortem не менялись.

Отказов проверки разрешений не было. Git предупреждал о Permission denied при чтении пользовательского ignore; команды завершались успешно. Предупреждения npm приведены в полном выводе тестов.

## Исходник воспроизводимой пробы

Сохранить этот блок как `.matchlog/0250-prerequisite.mjs` внутри назначенного дерева; файл не входит в коммит.

```javascript
import assert from 'node:assert/strict';
import { buildDependencyState } from '../supervisor/lib/dependency-state.mjs';
import { pendingDependencies } from '../supervisor/lib/dependencies.mjs';
import { scan } from '../supervisor/lib/scan.mjs';
import { resolveConfig } from '../supervisor/config/defaults.mjs';

const target = '0181-ispravit-v-mark-every-command-block-lozh';
const predecessor = '0175-razmetit-komandnye-bloki-supervisor-skil';
const other = '0001-existing-prerequisite';
const { config } = resolveConfig({ commands: { verify: 'x', deploy: 'x', perf: 'x' }, mainBranch: 'main', maxConcurrent: 1 });
const merged = { number: 132, state: 'MERGED', mergedAt: '2026-09-07T00:00:00Z', baseRefName: 'main' };
const zero = { continuations: 0, cycleFailures: 0, rejections: 0, spawnFailures: 0, apiErrors: 0 };
const task = (id, over = {}) => ({ id, type: 'feature', status: 'closed', priority: 10, createdAt: '2026-09-07T00:00:00Z', attempts: { ...zero }, ...over });
const registry = { entries: [{ taskId: target, branch: `worktree-${target}`, path: `.claude/worktrees/${target}` }] };
let count = 0;
async function check(name, { value = merged, response, targetOver = {}, baseOver = {}, extras = [], stateOver = {}, expected = 'held', attempts = zero } = {}) {
  const tasks = [task(target, { status: 'implement', dependsOn: [predecessor], dependencyResults: [{ taskId: predecessor, kind: 'merged-pr', pr: 132 }], attempts: { ...attempts }, ...targetOver }), task(predecessor, { links: { pr: 132 }, ...baseOver }), ...extras];
  const running = stateOver.running ?? [];
  const reports = stateOver.reports ?? [];
  const original = structuredClone({ tasks, running, reports });
  let reads = 0;
  const state = await buildDependencyState({ backlog: { tasks }, config, root: process.cwd(), running, reports, run: async (args, tool, root, options) => {
    reads++;
    assert.deepEqual(args, ['pr', 'view', '132', '--json', 'number,state,mergedAt,baseRefName']);
    assert.equal(tool, 'gh');
    assert.equal(options.timeout, 10000);
    if (response === 'timeout') throw new Error('ETIMEDOUT');
    return response ?? { code: 0, stdout: JSON.stringify(value), stderr: '' };
  } });
  const input = { ...state, config, registry, ...stateOver };
  const snapshot = structuredClone(input);
  const pending = pendingDependencies(tasks[0], tasks, [], { evidence: input.dependencyEvidence, mainBranch: config.mainBranch });
  const result = scan(input);
  assert.deepEqual(scan(input), result);
  assert.deepEqual(input, snapshot);
  assert.deepEqual({ tasks, running, reports }, original);
  const own = result.actions.filter(a => a.taskId === target);
  if (expected === 'held') {
    assert.ok(pending.length > 0);
    assert.deepEqual(own, []);
    assert.ok(result.notes.some(n => n.includes(target) && n.includes('жд')));
  } else if (expected === 'released') {
    assert.deepEqual(pending, []);
    assert.ok(own.some(a => a.kind === 'continue-stage' && a.stage === 'implement'));
  } else if (expected === 'report') {
    assert.equal(reads, 0);
    assert.deepEqual(own, [{ kind: 'transfer-report', taskId: target, stage: 'implement', outcome: 'done' }]);
  } else if (expected === 'live') {
    assert.equal(reads, 0);
    assert.deepEqual(own, []);
  } else {
    assert.deepEqual(pending, []);
    assert.ok(!own.some(a => ['continue-stage', 'start-stage', 'return-task'].includes(a.kind)));
  }
  console.log(JSON.stringify({ name, expected, reads, pending, actions: result.actions, notes: result.notes, unchanged: true }));
  count++;
}

await check('positive-control', { expected: 'released' });
const cases = [
  ['predecessor-open', { baseOver: { status: 'pr' } }],
  ['pr-open', { value: { ...merged, state: 'OPEN', mergedAt: null } }],
  ['pr-closed-unmerged', { value: { ...merged, state: 'CLOSED', mergedAt: null } }],
  ['unavailable', { response: { code: 1, stdout: '', stderr: 'unavailable' } }],
  ['timeout', { response: 'timeout' }],
  ['invalid-json', { response: { code: 0, stdout: '{', stderr: '' } }],
  ['empty-response', { response: { code: 0, stdout: '', stderr: '' } }],
  ['null-response', { value: null }],
  ['missing-date', { value: { number: 132, state: 'MERGED', baseRefName: 'main' } }],
  ['empty-date', { value: { ...merged, mergedAt: '' } }],
  ['invalid-date', { value: { ...merged, mergedAt: 'invalid' } }],
  ['other-base', { value: { ...merged, baseRefName: 'release' } }],
  ['other-number', { value: { ...merged, number: 133 } }],
  ['other-links-pr', { baseOver: { links: { pr: 133 } } }],
  ['existing-dependency-open', { targetOver: { dependsOn: [predecessor, other] }, extras: [task(other, { status: 'awaiting-po' })] }],
];
for (const amount of [0, 1, 999]) {
  const attempts = Object.fromEntries(Object.keys(zero).map(key => [key, amount]));
  for (const [name, options] of cases) await check(`${name}/attempts=${amount}`, { ...options, attempts });
}
await check('next-snapshot-releases', { expected: 'released' });
await check('live-preserved', { value: null, stateOver: { running: [{ taskId: target, stage: 'implement' }] }, expected: 'live' });
await check('report-preserved', { value: null, stateOver: { reports: [{ taskId: target, stage: 'implement', outcome: 'done' }] }, expected: 'report' });
await check('failed-not-recovered', { targetOver: { status: 'failed', postmortem: { reason: 'fixture' }, recovery: { fixedBy: ['0002-not-fixed'] }, returnTo: 'implement' }, stateOver: { dependencyEvidence: { 132: merged } }, expected: 'restricted' });
await check('awaiting-po-not-launched', { targetOver: { status: 'awaiting-po', returnTo: 'implement' }, stateOver: { dependencyEvidence: { 132: merged } }, expected: 'restricted' });
await check('quota-respected', { stateOver: { running: [{ taskId: '0003-other-running', stage: 'implement' }] }, expected: 'restricted' });
await check('pause-respected', { stateOver: { paused: true }, expected: 'restricted' });
console.log(`PASS ${count} cases; real modules, mocked GitHub, no Trello or process launch.`);
```

## Полный вывод пробы

Команда: `node .matchlog/0250-prerequisite.mjs`. Код 0.

```text
{"name":"positive-control","expected":"released","reads":1,"pending":[],"actions":[{"kind":"continue-stage","taskId":"0181-ispravit-v-mark-every-command-block-lozh","stage":"implement","reason":"этапу нужна сессия, живого процесса нет"}],"notes":[],"unchanged":true}
{"name":"predecessor-open/attempts=0","expected":"held","reads":0,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (pr)","0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: не закрыт (pr))"],"actions":[{"kind":"poll-external","taskId":"0175-razmetit-komandnye-bloki-supervisor-skil","what":"ci"}],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (pr), 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: не закрыт (pr))"],"unchanged":true}
{"name":"pr-open/attempts=0","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: PR не влит)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: PR не влит)"],"unchanged":true}
{"name":"pr-closed-unmerged/attempts=0","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: PR не влит)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: PR не влит)"],"unchanged":true}
{"name":"unavailable/attempts=0","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: unavailable)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: unavailable)"],"unchanged":true}
{"name":"timeout/attempts=0","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: ETIMEDOUT)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: ETIMEDOUT)"],"unchanged":true}
{"name":"invalid-json/attempts=0","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: Expected property name or '}' in JSON at position 1 (line 1 column 2))"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: Expected property name or '}' in JSON at position 1 (line 1 column 2))"],"unchanged":true}
{"name":"empty-response/attempts=0","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: Unexpected end of JSON input)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: Unexpected end of JSON input)"],"unchanged":true}
{"name":"null-response/attempts=0","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства вливания)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства вливания)"],"unchanged":true}
{"name":"missing-date/attempts=0","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет корректной даты вливания)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет корректной даты вливания)"],"unchanged":true}
{"name":"empty-date/attempts=0","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет корректной даты вливания)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет корректной даты вливания)"],"unchanged":true}
{"name":"invalid-date/attempts=0","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет корректной даты вливания)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет корректной даты вливания)"],"unchanged":true}
{"name":"other-base/attempts=0","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: другая база PR)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: другая база PR)"],"unchanged":true}
{"name":"other-number/attempts=0","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: не совпадает номер PR в доказательстве)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: не совпадает номер PR в доказательстве)"],"unchanged":true}
{"name":"other-links-pr/attempts=0","expected":"held","reads":0,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: links.pr не совпадает с ожидаемым PR)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: links.pr не совпадает с ожидаемым PR)"],"unchanged":true}
{"name":"existing-dependency-open/attempts=0","expected":"held","reads":1,"pending":["0001-existing-prerequisite (awaiting-po)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0001-existing-prerequisite (awaiting-po)"],"unchanged":true}
{"name":"predecessor-open/attempts=1","expected":"held","reads":0,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (pr)","0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: не закрыт (pr))"],"actions":[{"kind":"poll-external","taskId":"0175-razmetit-komandnye-bloki-supervisor-skil","what":"ci"}],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (pr), 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: не закрыт (pr))"],"unchanged":true}
{"name":"pr-open/attempts=1","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: PR не влит)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: PR не влит)"],"unchanged":true}
{"name":"pr-closed-unmerged/attempts=1","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: PR не влит)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: PR не влит)"],"unchanged":true}
{"name":"unavailable/attempts=1","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: unavailable)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: unavailable)"],"unchanged":true}
{"name":"timeout/attempts=1","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: ETIMEDOUT)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: ETIMEDOUT)"],"unchanged":true}
{"name":"invalid-json/attempts=1","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: Expected property name or '}' in JSON at position 1 (line 1 column 2))"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: Expected property name or '}' in JSON at position 1 (line 1 column 2))"],"unchanged":true}
{"name":"empty-response/attempts=1","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: Unexpected end of JSON input)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: Unexpected end of JSON input)"],"unchanged":true}
{"name":"null-response/attempts=1","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства вливания)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства вливания)"],"unchanged":true}
{"name":"missing-date/attempts=1","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет корректной даты вливания)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет корректной даты вливания)"],"unchanged":true}
{"name":"empty-date/attempts=1","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет корректной даты вливания)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет корректной даты вливания)"],"unchanged":true}
{"name":"invalid-date/attempts=1","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет корректной даты вливания)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет корректной даты вливания)"],"unchanged":true}
{"name":"other-base/attempts=1","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: другая база PR)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: другая база PR)"],"unchanged":true}
{"name":"other-number/attempts=1","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: не совпадает номер PR в доказательстве)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: не совпадает номер PR в доказательстве)"],"unchanged":true}
{"name":"other-links-pr/attempts=1","expected":"held","reads":0,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: links.pr не совпадает с ожидаемым PR)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: links.pr не совпадает с ожидаемым PR)"],"unchanged":true}
{"name":"existing-dependency-open/attempts=1","expected":"held","reads":1,"pending":["0001-existing-prerequisite (awaiting-po)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0001-existing-prerequisite (awaiting-po)"],"unchanged":true}
{"name":"predecessor-open/attempts=999","expected":"held","reads":0,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (pr)","0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: не закрыт (pr))"],"actions":[{"kind":"poll-external","taskId":"0175-razmetit-komandnye-bloki-supervisor-skil","what":"ci"}],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (pr), 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: не закрыт (pr))"],"unchanged":true}
{"name":"pr-open/attempts=999","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: PR не влит)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: PR не влит)"],"unchanged":true}
{"name":"pr-closed-unmerged/attempts=999","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: PR не влит)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: PR не влит)"],"unchanged":true}
{"name":"unavailable/attempts=999","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: unavailable)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: unavailable)"],"unchanged":true}
{"name":"timeout/attempts=999","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: ETIMEDOUT)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: ETIMEDOUT)"],"unchanged":true}
{"name":"invalid-json/attempts=999","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: Expected property name or '}' in JSON at position 1 (line 1 column 2))"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: Expected property name or '}' in JSON at position 1 (line 1 column 2))"],"unchanged":true}
{"name":"empty-response/attempts=999","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: Unexpected end of JSON input)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства: Unexpected end of JSON input)"],"unchanged":true}
{"name":"null-response/attempts=999","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства вливания)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства вливания)"],"unchanged":true}
{"name":"missing-date/attempts=999","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет корректной даты вливания)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет корректной даты вливания)"],"unchanged":true}
{"name":"empty-date/attempts=999","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет корректной даты вливания)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет корректной даты вливания)"],"unchanged":true}
{"name":"invalid-date/attempts=999","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет корректной даты вливания)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет корректной даты вливания)"],"unchanged":true}
{"name":"other-base/attempts=999","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: другая база PR)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: другая база PR)"],"unchanged":true}
{"name":"other-number/attempts=999","expected":"held","reads":1,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: не совпадает номер PR в доказательстве)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: не совпадает номер PR в доказательстве)"],"unchanged":true}
{"name":"other-links-pr/attempts=999","expected":"held","reads":0,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: links.pr не совпадает с ожидаемым PR)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: links.pr не совпадает с ожидаемым PR)"],"unchanged":true}
{"name":"existing-dependency-open/attempts=999","expected":"held","reads":1,"pending":["0001-existing-prerequisite (awaiting-po)"],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт зависимостей: 0001-existing-prerequisite (awaiting-po)"],"unchanged":true}
{"name":"next-snapshot-releases","expected":"released","reads":1,"pending":[],"actions":[{"kind":"continue-stage","taskId":"0181-ispravit-v-mark-every-command-block-lozh","stage":"implement","reason":"этапу нужна сессия, живого процесса нет"}],"notes":[],"unchanged":true}
{"name":"live-preserved","expected":"live","reads":0,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства вливания)"],"actions":[],"notes":[],"unchanged":true}
{"name":"report-preserved","expected":"report","reads":0,"pending":["0175-razmetit-komandnye-bloki-supervisor-skil (PR #132: нет доказательства вливания)"],"actions":[{"kind":"transfer-report","taskId":"0181-ispravit-v-mark-every-command-block-lozh","stage":"implement","outcome":"done"}],"notes":[],"unchanged":true}
{"name":"failed-not-recovered","expected":"restricted","reads":0,"pending":[],"actions":[],"notes":[],"unchanged":true}
{"name":"awaiting-po-not-launched","expected":"restricted","reads":0,"pending":[],"actions":[],"notes":[],"unchanged":true}
{"name":"quota-respected","expected":"restricted","reads":1,"pending":[],"actions":[],"notes":["задача 0181-ispravit-v-mark-every-command-block-lozh ждёт сессию: свободных мест нет"],"unchanged":true}
{"name":"pause-respected","expected":"restricted","reads":1,"pending":[],"actions":[],"notes":["взведён рубильник паузы: конвейер не порождает работы"],"unchanged":true}
PASS 53 cases; real modules, mocked GitHub, no Trello or process launch.
```

## Полный вывод узких тестов

Команда: `npx vitest run --root supervisor lib/dependency-state.test.mjs lib/dependency-evidence.test.mjs`. Код 0.

```text
npm warn Unknown project config "strict-peer-dependencies". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.
npm warn Unknown project config "auto-install-peers". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

 RUN  v2.1.9 C:/src/dezintegra/TD_Game/.claude/worktrees/0250-zakrepit-i-proverit-preduslovie-povtorno/supervisor

 ✓ |pipeline| lib/dependency-evidence.test.mjs (34 tests) 13ms
 ✓ |pipeline| lib/dependency-state.test.mjs (17 tests) 20ms

 Test Files  2 passed (2)
      Tests  51 passed (51)
   Start at  05:45:37
   Duration  1.12s (transform 134ms, setup 0ms, collect 291ms, tests 34ms, environment 0ms, prepare 1.14s)
```

