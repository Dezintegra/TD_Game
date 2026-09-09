## 1. Безопасный импорт и сохранение CLI

- [ ] 1.1 Одним атомарным коммитом (до 2 часов) изолировать исполнение `scripts/experiment/tempo-factorial.mjs` проверкой прямого запуска, отложить разбор argv и загрузку SQLite, сохранить три экспорта и всю логику CLI. Добавить `scripts/experiment/tempo-factorial.test.mjs` с проверками импорта, матрицы, shardOf, прямого запуска и ошибки отдельной ячейки по design. Проверить относительный и абсолютный путь входа, отсутствие argv[1], чужие невалидные аргументы, точные аргументы арены и JSON. Все внешние эффекты подменять до импорта. Выполнить проверки ниже, отметить этот пункт, закоммитить, немедленно отправить `git -C <дерево> push` и открыть черновой PR штатным порядком implement; результат — отправленный коммит и номер draft PR.

### Проверки пункта 1.1

Команды запускаются по одной в назначенном дереве. Формы сверены с `supervisor/config/stage-settings.json`: `PowerShell(npx vitest:*)`, `PowerShell(npx eslint:*)`, `PowerShell(npx prettier:*)` и `PowerShell(git -C:*)`.

1. `npx vitest run --root scripts experiment/tempo-factorial.test.mjs` — файл найден, все сценарии выполнены, реальных процессов арены и файлов результатов нет. Базовый тест `baseHp: [1, 2, 4]` безусловный. Проверить состояние записи killBounty на освежённой базе: если 0012 уже влита, добавить также безусловный тест точных объектов c000/c001/c002 для killBounty 1/2/4; иначе записать в отчёт, что эта интеграция ещё отсутствует. Не добавлять множитель самостоятельно и не считать тест baseHp доказательством поддержки killBounty.
2. Временно убрать защиту прямого входа и повторить ту же узкую команду: сценарий импорта обязан упасть, реальные побочные эффекты остаются перехваченными. Восстановить защиту и получить зелёный результат. Контрольную порчу не стейджить.
3. `npx eslint scripts/experiment/tempo-factorial.mjs scripts/experiment/tempo-factorial.test.mjs` и отдельным вызовом `npx prettier --check scripts/experiment/tempo-factorial.mjs scripts/experiment/tempo-factorial.test.mjs`.
4. `openspec validate guard-tempo-factorial-import --strict` и отдельным вызовом `openspec status --change guard-tempo-factorial-import`.

### Состав коммита

Разрешены только рабочие правки двух файлов scripts и отметка выполнения собственного пункта в `openspec/changes/guard-tempo-factorial-import/tasks.md`. Добавлять явным списком: `git -C <дерево> add -- scripts/experiment/tempo-factorial.mjs scripts/experiment/tempo-factorial.test.mjs openspec/changes/guard-tempo-factorial-import/tasks.md`.

До коммита прочитать `git -C <дерево> diff --cached --name-only` и `git -C <дерево> diff --cached`; после — `git -C <дерево> show --stat HEAD` и `git -C <дерево> show --format=fuller HEAD`. Проверить не только имена, но и содержание: нет изменения факторов, баланса, метрик, чужих задач, временной порчи или несвязанных правок tasks.md. Полный verify, настоящая арена и ожидание CI в этот пункт не входят; CI наблюдает супервизор.
