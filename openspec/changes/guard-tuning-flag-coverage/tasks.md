## 1. Экспорты и сторож полноты

- [ ] 1.1 Одним атомарным коммитом (до 2 часов) перенести актуальный `TUNING_FLAGS` в экспортируемый модуль `apps/arena/src/tuning-flags.ts`, подключить его к обоим потребителям в `main.ts`, экспортировать `FLAG_OF`, согласовать ожидание экспортов в `tempo-factorial.test.mjs` и добавить `scripts/experiment/tuning-flags.test.mjs` по design. Проверить реальные таблицы относительно `ruleTuning()`, диагностические отрицательные контроли, существующие цепочки имён и развёртку всех доступных факторов, безопасность импортов. Выполнить узкие проверки ниже, отметить этот пункт, закоммитить, немедленно отправить `git -C <дерево> push` и открыть черновой PR штатным порядком implement. Проверяемый результат — сторож в быстром наборе scripts, отправленный атомарный коммит и номер draft PR.

## Проверки шага 1.1

Все команды выполняются отдельными вызовами в назначенном дереве после его штатной подготовки этапом implement. `<дерево>` означает абсолютный путь назначенного дерева. Командные формы сверены с `supervisor/config/stage-settings.json`: `PowerShell(npx vitest:*)`, `PowerShell(npx eslint:*)`, `PowerShell(npx prettier:*)`, `PowerShell(git -C:*)`.

1. `npx vitest run --root scripts experiment/tuning-flags.test.mjs experiment/tempo-factorial.test.mjs` — найдены оба файла и выполнены их тесты. Рабочие таблицы проходят; удаление записи из каждой копии, новое ожидаемое поле, неизвестное поле и ошибочный CLI-ключ дают точную ожидаемую диагностику. Нет реальных дочерних процессов, SQLite и файлов замера. Прежние CLI-тесты сохраняют аргументы run/ingest и JSON; FACTORS не меняется. Новый тест использует TS-исходники своего дерева, не dist и не скопированный реестр полей.
2. `npx eslint apps/arena/src/main.ts apps/arena/src/tuning-flags.ts scripts/experiment/tempo-factorial.mjs scripts/experiment/tempo-factorial.test.mjs scripts/experiment/tuning-flags.test.mjs` — ошибок нет, границы пакетов не ослаблены.
3. `npx prettier --check apps/arena/src/main.ts apps/arena/src/tuning-flags.ts scripts/experiment/tempo-factorial.mjs scripts/experiment/tempo-factorial.test.mjs scripts/experiment/tuning-flags.test.mjs` — формат корректен.
4. `openspec validate guard-tuning-flag-coverage --strict` и отдельным вызовом `openspec status --change guard-tuning-flag-coverage` — дельта валидна, артефакты полны.
5. Просмотр diff подтверждает: таблица перенесена без потерь из свежей базы, main использует импорт в `tuningOf` и `tuningArgs`, второго литерала нет, module данных имеет только type-import. Нейтральный объект по-прежнему имеет полный тип `RuleTuning`; новые проверки не требуют изменений shared. Если 0012 появилась на базе, её записи сохраняются и безусловно участвуют в общей проверке; отсутствие 0012 не маскируется условно пропускаемым тестом.

Проверку типов и сборку выполнит существующий CI данного PR. Полные наборы, матчевые тесты и арену локально не запускать. Шага ожидания CI нет: результат проверок обрабатывает супервизор. Балансовый прогон не требуется, поскольку значения и игровые правила не меняются.

## Состав коммита

Допустимы только рабочие правки пяти указанных файлов и обязательная отметка пункта 1.1 в собственном `openspec/changes/guard-tuning-flag-coverage/tasks.md`. Добавлять явным списком, при необходимости несколькими короткими вызовами:

```powershell
git -C <дерево> add -- apps/arena/src/main.ts apps/arena/src/tuning-flags.ts
git -C <дерево> add -- scripts/experiment/tempo-factorial.mjs scripts/experiment/tempo-factorial.test.mjs scripts/experiment/tuning-flags.test.mjs
git -C <дерево> add -- openspec/changes/guard-tuning-flag-coverage/tasks.md
```

Каждая строка — отдельный вызов. Перед коммитом проверить имена путей через `git -C <дерево> diff --cached --name-only` и содержание через `git -C <дерево> diff --cached`. В созданном коммите проверить `git -C <дерево> show --format=fuller --stat HEAD` и `git -C <дерево> show --format= --patch HEAD`. Допуск пути не разрешает несвязанные правки внутри него; чужие tasks и временные файлы в коммит не входят. После коммита сразу выполнить отправку, затем проверку отсутствия неотправленного хвоста: `git -C <дерево> log --oneline '@{u}..HEAD'` — пусто.
