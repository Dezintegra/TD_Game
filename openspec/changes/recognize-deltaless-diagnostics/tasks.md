## 1. Согласовать мерку и проверить её границы

- [ ] 1.1 Одним атомарным коммитом (до 2 часов) согласовать в `supervisor/skills/design.md` и `supervisor/skills/audit.md` правило из design.md: полное начало сообщения, ровно одна ошибка во всём выводе, допустимые Ensure your change…, Tip: run… и Next steps, отсутствие specs/, обязательный раздел и проверенное по существу обоснование; другая или дополнительная ошибка исключением не покрывается. Согласовать исходное требование «Проверка формы изменения зовётся по имени этого изменения» и сценарии «Валидатор отверг изменение без дельт» / «Валидатор назвал что-то ещё» по живому месту после освежения базы. Расширить существующий сторож в `supervisor/config/transitions.test.mjs`, включая контрольные мутации текста каждого скилла; пройти все строки матрицы design.md для каждого этапа и записать результат с основанием в собственный `verification.md`. Проверка: узкий вызов `npx vitest run --root supervisor config/transitions.test.mjs`, `npx prettier --check supervisor/skills/design.md supervisor/skills/audit.md supervisor/config/transitions.test.mjs`, `openspec validate recognize-deltaless-diagnostics --strict`; вывод Vitest подтверждает фактическое выполнение сторожа и контрольных мутаций в `config/transitions.test.mjs` (отсутствие найденных тестов или их пропуск не считается успехом); все строки матрицы совпадают с ожиданиями, удаление условий и возврат запрета любой дополнительной строки обнаруживаются сторожем. После проверки отметить этот пункт, закоммитить и сразу отправить, затем открыть черновой PR по правилам implement.

Работа неделима: раздельные коммиты двух скиллов и спецификации оставляют разные решения для одной диагностики. Этот первый и единственный шаг сразу даёт проверяемую реализацию для чернового PR. Ожидание CI выполняет супервизор, в список работ оно не входит.

Перед правкой применить обязательное освежение базы этапа implement отдельными командами `git -C <дерево> fetch origin` и `git -C <дерево> merge origin/main`. Формы Git, OpenSpec, npx vitest и npx prettier сверены с `supervisor/config/stage-settings.json`: соответственно PowerShell(git -C:*), PowerShell(openspec:*), PowerShell(npx vitest:*), PowerShell(npx prettier:*). Каждая команда вызывается отдельно, без цепочек.

Допустимые пути рабочего коммита перечислены явно:

- `supervisor/skills/design.md`;
- `supervisor/skills/audit.md`;
- `supervisor/config/transitions.test.mjs`;
- `openspec/changes/recognize-deltaless-diagnostics/verification.md`;
- `openspec/changes/recognize-deltaless-diagnostics/tasks.md` — обязательная отметка фактически выполненного пункта;
- `openspec/changes/admit-changes-without-deltas/specs/dev-pipeline-worker/spec.md`, пока исходная дельта открыта; если она уже архивирована, вместо этого пути — `openspec/specs/dev-pipeline-worker/spec.md` с живой нормой.

Историческую копию в archive не менять. Сохранять прочие абзацы и сценарии исходного требования; не выполнять архивацию. Если живое требование уже объединено, изменить только соответствующую норму, как описано в design.md. В verification.md записать фактический выбранный путь и основание выбора.

Добавлять свои файлы явным перечнем через `git -C <дерево> add -- <пути>`, подставляя только фактически изменённые пути выше. Перед коммитом проверить имена и содержание через `git -C <дерево> diff --cached --name-only` и `git -C <дерево> diff --cached`; после коммита — `git -C <дерево> show --format=fuller --stat HEAD` и `git -C <дерево> show --format= --patch HEAD`. Допуск пути не разрешает несвязанные правки внутри него. В коммите должны быть только рабочие правки шага, результаты его проверки и собственная отметка выполнения; временные артефакты не добавлять.
