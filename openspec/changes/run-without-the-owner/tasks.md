# Задачи

Каждый пункт — отдельный коммит, отправляемый сразу.

Тесты конвейера обычным `vitest` не видны, у них свой корень:
`npx vitest run --root supervisor <файл>`.

## 1. Правило

- [x] 1.1 Завести изменение OpenSpec: предложение, замысел, дельты
      спецификаций `dev-backlog`, `dev-pipeline-supervisor`,
      `dev-pipeline-worker`, задачи. Проверяемо:
      `openspec validate --changes --strict` зелёный

## 2. Починка конвейера минует шлюз с любого этапа

- [x] 2.1 Разбирать в заявке поле `area: "pipeline"` строго
      (`supervisor/lib/requests.mjs`): такая заявка заводится в `new`
      с `blocking: true` независимо от этапа; поле `area` объявить в обеих
      схемах записи (`manage/schema.json`,
      `supervisor/config/task-schema.json`) и заодно свести их: обе знают
      `blocking` и `spawnFailures`. Проверяемо: `requests.test.mjs` —
      заявка имплементации с `area` встаёт в очередь первой и проходит
      схему, с `area: true` и `"Pipeline"` — кандидатом; прогон с `area`
      несёт `blocking`
- [ ] 2.2 Дать правило `area` скиллам, подающим заявки: `design`, `audit`,
      `implement`, `revise`, `review`, `interpret`, `triage`,
      `postmortem` — с признаками причины в конвейере; описать третье
      исключение из шлюза в `manage/README.md`. Проверяемо:
      `transitions.test.mjs` — каждый скилл из перечня упоминает
      `area: "pipeline"`; `npx prettier --check` по файлам зелёный

## 3. Возврат из ошибки

- [ ] 3.1 Завести поле `recovery` на задаче: схемы, `metaOf` и `parseCard`
      (`supervisor/lib/card.mjs`), стирание вердикта при входе в разбор
      с сохранением счёта (`supervisor/lib/task-file.mjs`). Проверяемо:
      `card.test.mjs` — поле переживает дорогу туда и обратно;
      `task-file.test.mjs` — вход в разбор стирает вердикт и хранит
      `returns`, `resetAttempts` поле не трогает
- [ ] 3.2 Вердикт разбора: `supervisor/lib/recovery.mjs` собирает
      `recovery` из отчёта, заведённых конвейерных задач и описи; перенос
      отчёта (`execute.mjs`) записывает его, при `causedBy: "pipeline"`
      считает заявки конвейерными, при исчерпанном пределе пишет «дальше
      человек». Проверяемо: `recovery.test.mjs` — строгость `causedBy`,
      отбрасывание чужого идентификатора, предел; `execute.test.mjs` —
      задача в ошибке несёт `fixedBy` с номером заведённой задачи
- [ ] 3.3 Действие `return-task`: сканер назначает его при закрытых
      починках и называет ожидание при незакрытых
      (`supervisor/lib/scan.mjs`); исполнение переводит, обнуляет попытки,
      наращивает счёт, забывает сессию, пишет журнал (`execute.mjs`);
      предел `maxAutoReturns` в `config/defaults.mjs`; действие в перечне
      пишущих в главную ветку (`cycle.mjs`). Проверяемо: `scan.test.mjs` —
      четыре сценария из спецификации; `execute.test.mjs` — возврат
      меняет состояние, счёт и журнал, `forgetSession` позван
- [ ] 3.4 Скилл разбора: поля `causedBy` и `fixedBy`, правило «конвейер
      вернёт сам», образцы отчётов; раздел про возврат
      в `manage/README.md`. Проверяемо: `transitions.test.mjs` — скилл
      разбора упоминает `causedBy`; `npx prettier --check` зелёный

## 4. Самообновление супервизора

- [ ] 4.1 Команды git: `currentBranch`, `aheadOn`, `treeOf`
      (`supervisor/lib/git.mjs`); решение о самообновлении
      `supervisor/lib/self-update.mjs` — выключено, актуально, заблокировано
      с причиной, подтянуто, ждёт тишины, перезапуск. Проверяемо:
      `self-update.test.mjs` — по сценарию на каждый исход спецификации
- [ ] 4.2 Переданный замок: `lockVerdict` берёт замок с собственным
      номером (`supervisor/lib/lock.mjs`). Проверяемо: `lock.test.mjs`
- [ ] 4.3 Провести в супервизор (`bin/supervise.mjs`): `git fetch`
      в начале оборота, проверка после оборота, перезапуск отсоединённым
      процессом с передачей замка, настройка `selfUpdate` в умолчаниях,
      строка о самообновлении в приветствии; описать в `supervisor/README.md`.
      Проверяемо: `defaults.test.mjs` — умолчание включено;
      `npx prettier --check` и `npx eslint` по файлам зелёные
