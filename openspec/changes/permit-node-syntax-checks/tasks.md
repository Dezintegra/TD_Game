## 1. Допуск синтаксической проверки и его защита

- [ ] 1.1 Одним атомарным коммитом (до 2 часов) добавить в `supervisor/config/stage-settings.json` правила `Bash(node --check:*)` и `PowerShell(node --check:*)`, сохранив остальные правила и пояснения; создать `supervisor/config/syntax-check-permissions.test.mjs` по design. Проверить реальную настройку через `uncoveredCommands`, обе оболочки, путь с пробелом, существующие команды установки/узких проверок и закрытые формы Node. В копиях настройки в памяти проверить удаление допуска, точную форму без файла, перекрывающий deny и расширение до `node:*` отдельно для каждой оболочки. Проверки ниже должны фактически обнаружить и выполнить новый файл тестов; отсутствие найденных тестов успехом не является. Отметить пункт выполненным в собственном tasks.md с кратким результатом проверок, закоммитить, немедленно отправить и открыть черновой PR по контракту implement. Этот первый шаг даёт весь самостоятельный проверяемый результат.

### Проверки шага

Каждая команда — отдельный вызов из назначенного дерева:

```powershell
npx vitest run --root supervisor config/syntax-check-permissions.test.mjs config/transitions.test.mjs
```

```powershell
npx eslint supervisor/config/syntax-check-permissions.test.mjs
```

```powershell
npx prettier --check supervisor/config/stage-settings.json supervisor/config/syntax-check-permissions.test.mjs
```

```powershell
openspec validate permit-node-syntax-checks --strict
```

```powershell
git -C <дерево> diff --check
```

Полный набор остаётся CI; локально выполнять только эти узкие проверки. Подготовка зависимостей на implement — `pnpm install --frozen-lockfile --prefer-offline` по правилам этапа, без изменения lockfile. На design установка и тесты не запускаются. Приставки `npx vitest`, `npx eslint`, `npx prettier`, `pnpm install`, `openspec` и `git -C` уже покрыты `supervisor/config/stage-settings.json` для PowerShell. Сам `node --check` не включён в обязательные команды текущего исполнителя: правка JSON в ветке не меняет полученную им настройку среды. Отрицательные команды из design — только входы теста, а не команды оболочки.

### Состав коммита

Все добавляемые пути перечислить явно: `supervisor/config/stage-settings.json`, `supervisor/config/syntax-check-permissions.test.mjs`, `openspec/changes/permit-node-syntax-checks/tasks.md`. В последнем допускаются только отметка этого пункта и относящийся к нему результат проверки.

Перед коммитом прочитать `git -C <дерево> diff --cached --name-only` и `git -C <дерево> diff --cached`, после — `git -C <дерево> show --stat --oneline HEAD` и `git -C <дерево> show --format=fuller HEAD`: проверить и пути, и содержание, исключить посторонние изменения даже внутри разрешённых файлов. Отправка — `git -C <дерево> push -u origin HEAD`. Тело PR подготовить и передать через `--body-file` по правилам implement. Ожидание CI, архивация, перезапуск супервизора и прогоны игры пунктами реализации не являются.
