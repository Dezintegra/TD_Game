## 1. Общая приёмка успешного отчёта

- [x] 1.1 Одним атомарным коммитом (до 2 часов) устранить оба пропуска в `supervisor/lib/report-plan.mjs` и `supervisor/lib/denials.mjs`, согласовать диагностику пустого перечня и комментарии сборщика в `supervisor/lib/io.mjs`, добавить регрессии в `supervisor/lib/denials.test.mjs` и `supervisor/lib/report-plan.test.mjs` по разделу «Проверки результата» design.md и всем сценариям дельты. Согласовать только затронутые фикстуры `supervisor/lib/execute.test.mjs`, если это необходимо. Обязательны реальные судья и обработчик: `done` проработки со старым коммитом должен уходить в `postmortem` при отсутствии поля `denials`, при `[]` и при обычном отказе; свежий коммит должен давать переход в аудит. Проверить остальные типы следа, неизвестные улики, отсутствие сбора улик для исходов не `done`, приоритет обращения к человеку, журнал остановки, сохранение отчёта при отказе записи и повтор сохранённого плана без новых улик. Выполнить узкие проверки ниже, отметить этот пункт, проверить состав и содержание индекса, закоммитить и сразу отправить. После этого коммита открыть черновой PR: вся правка уже самостоятельна и доступна проверкам CI.

### Проверки шага 1.1

Каждая команда вызывается отдельно из назначенного дерева. `<дерево>` означает его абсолютный путь. Формы сверены с `supervisor/config/stage-settings.json`: `PowerShell(pnpm test:pipeline:*)`, `PowerShell(npx eslint:*)`, `PowerShell(npx prettier:*)`, `PowerShell(git -C:*)`, `PowerShell(gh pr:*)`.

```powershell
pnpm test:pipeline lib/denials.test.mjs lib/report-plan.test.mjs lib/execute.test.mjs
npx eslint supervisor/lib/denials.mjs supervisor/lib/report-plan.mjs supervisor/lib/io.mjs supervisor/lib/denials.test.mjs supervisor/lib/report-plan.test.mjs supervisor/lib/execute.test.mjs
npx prettier --check supervisor/lib/denials.mjs supervisor/lib/report-plan.mjs supervisor/lib/io.mjs supervisor/lib/denials.test.mjs supervisor/lib/report-plan.test.mjs supervisor/lib/execute.test.mjs
git -C <дерево> diff --check
```

Ожидаемый результат: узкие тесты, линт и формат проходят; отрицательная регрессия ловит старый ранний `passing` на любом из двух уровней. Игровые тесты, сборка, полный `pnpm verify` и арена локально не запускаются. Новых зависимостей не требуется; подготовка зависимостей выполняется штатным порядком этапа implement.

### Состав коммита и доставка

Допустимы только рабочие правки перечисленных шести файлов `supervisor/lib/` и отметка выполнения 1.1 в собственном `openspec/changes/check-done-traces-without-denials/tasks.md`. В `io.mjs` правятся только связанные комментарии; в `execute.test.mjs` — только затронутые ожидания/фикстуры. Если последний файл не менялся, исключить его из add. Отметка не разрешает несвязанных изменений tasks.md.

```powershell
git -C <дерево> add -- supervisor/lib/denials.mjs supervisor/lib/report-plan.mjs supervisor/lib/io.mjs supervisor/lib/denials.test.mjs supervisor/lib/report-plan.test.mjs supervisor/lib/execute.test.mjs openspec/changes/check-done-traces-without-denials/tasks.md
git -C <дерево> diff --cached --name-only
git -C <дерево> diff --cached
git -C <дерево> commit -m "fix(pipeline): check done traces without denials" -m "Apply the existing trace contract even when no operation was denied. Preserve unverifiable evidence and durable report replay."
git -C <дерево> push -u origin HEAD
git -C <дерево> show --stat --oneline HEAD
git -C <дерево> show --format=fuller HEAD
git -C <дерево> log --oneline '@{u}..HEAD'
```

Перед коммитом по именам и полному diff индекса, после отправки по созданному коммиту подтвердить указанную область и отсутствие постороннего содержания. Последний log должен быть пустым; upstream должен указывать на собственную ветку задачи. Черновой PR открывается штатным шагом implement через `gh pr create --draft --base main --title "fix(pipeline): check done traces without denials" --body-file .matchlog/0075-pr-body.md`; файл тела не включается в коммит. Если PR уже существует, сохранить его номер. Ожидание CI исполняет супервизор и пунктом этого списка не является.
