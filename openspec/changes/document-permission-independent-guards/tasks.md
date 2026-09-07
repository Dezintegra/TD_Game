## 1. Согласовать единый перечень и предписания этапов

- [ ] 1.1 За один атомарный коммит (до 2 часов) добавить `$permissionIndependentGuardsNote`, ссылки всех одиннадцати скиллов и комментария `STAGE_COMMANDS`, согласовать предписания удаления, окружения и .NET по design. Выполнить перечисленные ниже узкие проверки, отметить этот пункт, закоммитить явные пути и сразу отправить; после первого коммита открыть черновой PR по действующему порядку имплементации.

Перед правками выполнить отдельно `git -C <дерево> fetch origin` и `git -C <дерево> merge origin/main`, соблюдая правила этапа при конфликте и коммите слияния. Сверить свежие версии пересекающихся изменений из proposal. Не восстанавливать строки, уже исправленные соседней задачей.

Состав работы: новый ключ с тройкой подтверждённых случаев, источниками и областью применимости; ссылки на подробности `$cleanupImpossibleNote`, `$codeStringNote`, `$readNote`, `$note` и известный случай UNC; ссылка на общий ключ из старых заметок; по одной доступной ссылке из каждого скилла. В deploy убрать присваивания окружения, .NET и `Push-Location`, в benchmark убрать присваивание окружения перед командой. Сохранить предусловие собственных согласованных портов перед проверкой и замером, честный исход несостоявшегося замера и ссылку на 0079. Комментарий к `STAGE_COMMANDS` объясняет предел покрытия и невозможность исправить независимый отказ добавлением allow. Сам объект команд, функции покрытия и массивы разрешений не изменять.

Разрешённые рабочие пути этого коммита перечислены полностью:

- `supervisor/config/stage-settings.json`
- `supervisor/config/permissions.mjs` (только пояснение)
- `supervisor/skills/audit.md`
- `supervisor/skills/benchmark.md`
- `supervisor/skills/decompose.md`
- `supervisor/skills/deploy.md`
- `supervisor/skills/design.md`
- `supervisor/skills/implement.md`
- `supervisor/skills/interpret.md`
- `supervisor/skills/postmortem.md`
- `supervisor/skills/review.md`
- `supervisor/skills/revise.md`
- `supervisor/skills/triage.md`
- `openspec/changes/document-permission-independent-guards/tasks.md` (отметка выполненного пункта).

Проверки реализации, каждая отдельным вызовом из своего дерева:

```powershell
npx vitest run --root supervisor config/transitions.test.mjs
```

```powershell
npx prettier --check supervisor/config/stage-settings.json supervisor/config/permissions.mjs supervisor/skills/audit.md supervisor/skills/benchmark.md supervisor/skills/decompose.md supervisor/skills/deploy.md supervisor/skills/design.md supervisor/skills/implement.md supervisor/skills/interpret.md supervisor/skills/postmortem.md supervisor/skills/review.md supervisor/skills/revise.md supervisor/skills/triage.md
```

```powershell
openspec validate document-permission-independent-guards --strict
```

Формы `npx vitest:*` и `npx prettier:*` разрешены текущим stage-settings; OpenSpec установлен глобально. Не запускать полный набор, замер или новые живые пробы независимых отказов. `openspec/` не форматируется.

Ручная приёмка с результатами в отчёте имплементации:

- Для всех одиннадцати скиллов проверить разрешение относительной ссылки на `../config/stage-settings.json` и наличие точного ключа `$permissionIndependentGuardsNote`. Ни одной потерянной ссылки и ни одного второго полного перечня.
- Сверить три случая с матрицей design: источник/дата, область пробы и действие присутствуют. `node -e` остаётся неопределённой пробой; нехватка allow для смены каталога не названа независимым запретом.
- Просмотреть все вхождения `env:`, `CLIENT_PORT=`, `.NET`, `OutputEncoding`, `Remove-Item`, `rm -rf`, `Push-Location` в `supervisor/skills/`: остаются только объяснения запрета/истории, а не исполняемые предписания. Согласованные собственные порты, запрет замера на неподтверждённом окружении, проверка машины и обязательность замера сохранены. Не добавлены несуществующие ключи CLI портов или сценарий обхода запрета среды.
- Проверить, что порядок точечного `git clean` собственного файла в implement сохранён со всеми предохранителями. Комментарий `STAGE_COMMANDS` ссылается на единый ключ и объясняет удержание; исходный состав `STAGE_COMMANDS`, `SHELLS`, `allow`, `deny`, `additionalDirectories` и код сопоставления не изменились.
- Заголовки и нумерация шагов сохранены; новые вставки кода не переходят на другую физическую строку. Упоминания существующих 0077/0079/0118/0168 не стали дублирующими заявками.

После отметки пункта добавить только фактически изменённые пути из явного списка выше через `git -C <дерево> add -- <явные пути>`. Перед коммитом прочитать `git -C <дерево> diff --cached --name-only` и `git -C <дерево> diff --cached`: допустимы только перечисленные пути и относящееся к задаче содержание, включая лишь свою отметку в tasks. Проверить `git -C <дерево> diff --cached --check`. После создания коммита проверить его имена и содержание через `git -C <дерево> show --format=fuller --stat HEAD` и `git -C <дерево> show --format= --patch HEAD`, затем сразу `git -C <дерево> push -u origin HEAD`. Временные файлы проверки/тела PR в коммит не входят. Ожидание CI выполняет супервизор и пунктом этого списка не является.
