## 1. Подтвердить различение отправок и доставить результат

- [ ] 1.1 За один атомарный коммит (до 2 часов) выполнить протокол design.md: подготовить изолированный стенд, проверить исходные настройки свежей main настоящими инструментами Claude, сохранить воспроизводимые результаты в `openspec/changes/verify-lease-push-permissions/probe-results.md`, уточнить связанное с 0078 объяснение в `supervisor/skills/revise.md` и примечание в `supervisor/config/stage-settings.json`. Только при доказанном пересечении уточнить deny и подтвердить кандидата новой диагностической сессией; при отсутствии пересечения deny не менять. Добавить `supervisor/config/lease-push-permissions.test.mjs`, использующий действующий matcher и JSON, с положительным lease и отрицательным force-контролями обеих форм и обеих оболочек. Проверки: записанные инструментальные события показывают plain/lease разрешёнными, force запрещённым до Git; проверка устаревшего lease отвергается самим Git и не меняет удалённую голову. Узкий тест и проверки файлов ниже проходят. Отметить этот пункт тем же коммитом, немедленно отправить его и открыть черновой PR по правилам implement. При недоступности необходимой живой среды пункт не закрывать и результат не подменять проверкой Codex или matcher.

### Команды проверки реализации

Диагностическое продолжение 09.09.2026 выполняется по предварительно
отправленному разделу design «План диагностического продолжения 09.09.2026».
Сценарий: `node .matchlog/0078-loading-probe.mjs`. Две безопасные сессии чтения,
третий запуск только при доказанном исправлении загрузки; расход сохраняется
в probe-results. Уточнение и unknown не закрывают 1.1.

Продолжать сохранённый implement с PR 227 после доставки
`guard-permission-diagnostics`, сохраняя код и прежний probe-results. Исходный
1.1 остаётся открытым: наличие теста, нового протокола или коммита не заменяет
приёмку plain/lease/force. Не открывать второй PR.

Применить [общий протокол](../../../supervisor/permission-diagnostics.md) и новую
ветвь design: безопасная опись источников, независимые baseline/additive чтения,
сопоставимость снимков, три новые сессии по пять минут с учётом сохранённых
попыток. Не повторять неизменный эксперимент и не менять force-deny по одному
прохождению обоих контролей. Одноразовый сценарий использует
`classifyPermissionEvidence` из `supervisor/lib/permission-evidence.mjs`,
сохраняя отдельно settings/target/verified и причину. Только связанные native
события нормализуются; unknown и not-applied не считаются исправностью.
Очищенные результаты отбираются белым списком, без сырого потока и секретов.
Проверка актуального непотомкового lease обновляет bare origin; устаревшее
ожидание отвергается Git с сохранением SHA. Эти критерии и отказ force до Git
остаются обязательными независимо от verified. Порядок остановки — в design.

Каждая команда — отдельный вызов из назначенного дерева. `<дерево>` означает его абсолютный путь. Форма `node .matchlog/*` покрыта настройкой, но не разрешает обход инструментального отказа: диагностируемые Git-команды вызывает только оболочка внутри проверяемой сессии. Запуск пробы конечный, устройство и модель диагностической сессии соответствуют design.md и правилам выбора модели в CLAUDE.md. В сохранённом результате привести также исходный текст одноразового сценария для воспроизведения; секреты не включать.

```powershell
node .matchlog/0078-lease-probe.mjs
npx vitest run --root supervisor config/lease-push-permissions.test.mjs
npx eslint supervisor/config/lease-push-permissions.test.mjs
npx prettier --check supervisor/config/stage-settings.json supervisor/skills/revise.md supervisor/config/lease-push-permissions.test.mjs
git -C <дерево> diff --check
openspec validate verify-lease-push-permissions --strict
openspec status --change verify-lease-push-permissions
```

Формы сверены с `supervisor/config/stage-settings.json`: node .matchlog, npx vitest/eslint/prettier, git -C и openspec открыты. Проверки кода и живая проба относятся только к implement. Полный verify, сборка, арена и ожидание CI в задачи не входят; CI наблюдает супервизор. Для validate допускается ровно одна ошибка с началом `Change must have at least one delta. No deltas found.` при отсутствии specs/ и сохранении содержательного обоснования proposal; вывод прочитать целиком. Status ожидается 3/4, незакрыт specs.

### Границы коммита

Добавить фактически изменённые пути явным перечнем: `supervisor/config/stage-settings.json`, `supervisor/skills/revise.md`, `supervisor/config/lease-push-permissions.test.mjs`, `openspec/changes/verify-lease-push-permissions/probe-results.md` и обязательную отметку в `openspec/changes/verify-lease-push-permissions/tasks.md`. Для предварительного технического уточнения разрешены собственные `openspec/changes/verify-lease-push-permissions/design.md` и `openspec/changes/verify-lease-push-permissions/tasks.md` отдельным отправленным коммитом без закрытия 1.1. Другие файлы и несвязанные хунки в этих файлах не допускаются. Временный `.matchlog/0078-lease-probe.mjs` и всё `.matchlog/0078-lease-probe/` отсутствуют в индексе и созданном коммите.

Перед коммитом проверить имена и содержание отдельными командами `git -C <дерево> diff --cached --name-only` и `git -C <дерево> diff --cached`; после коммита — `git -C <дерево> show --format=fuller --stat HEAD` и `git -C <дерево> show --format= --patch HEAD`. Отправка — `git -C <дерево> push -u origin HEAD`. Ветка проекта для доставки результата отправляется обычным push, пробы force выполняются только внутри локального стенда. После отправки проверить `git -C <дерево> log --oneline '@{u}..HEAD'`: хвост пуст. Тело PR передать файлом согласно implement, его уборку выполнить по тем же правилам. Не архивировать изменение на implement.
