## 1. Согласовать адресную правку между этапами

- [ ] 1.1 Одним атомарным коммитом (до 2 часов) согласовать `supervisor/skills/design.md`, `supervisor/skills/audit.md`, `supervisor/skills/implement.md`, `supervisor/skills/review.md` и `supervisor/skills/revise.md` по решениям 1–4 design.md: выбор существующей открытой дельты до создания изменения; пределы разрешённого diff; обязательное содержание отчёта и `links.change`; независимая проверка адресной правки; пропуск чужих пунктов исходного tasks и собственный черновой PR без фиктивного коммита; область review, включая мерку каждого сценария и иных открытых пунктов; исправление дефекта адресного diff на revise в прежних границах и прежнем PR с повторной проверкой. Согласовать только названные в решении 5 общие требования и условия их сценариев по живому месту, сохранив остальное содержание и диагностику 0251. Выполнить все строки Verification matrix, включая вливание при незавершённых чужих сценариях и возврат дефекта самой правки, и записать наблюдаемый результат с адресами правил в `openspec/changes/amend-existing-deltas-in-design/verification.md`. Проверки: `npx vitest run --root supervisor config/transitions.test.mjs` (сторожи фактически выполнены, отсутствие тестов не успех), `npx prettier --check supervisor/skills/design.md supervisor/skills/audit.md supervisor/skills/implement.md supervisor/skills/review.md supervisor/skills/revise.md`, `openspec validate amend-existing-deltas-in-design --strict`; содержательная сверка матрицы показывает один согласованный путь без выполнения чужих задач и без обхода аудита/CI/ревью. После успешных проверок отметить этот пункт, проверить индекс, закоммитить и сразу отправить, проверить созданный коммит и открыть черновой PR по правилам implement.

## Границы единственного коммита реализации

Допускаются только связанные правки перечисленных путей:

- `supervisor/skills/design.md`
- `supervisor/skills/audit.md`
- `supervisor/skills/implement.md`
- `supervisor/skills/review.md`
- `supervisor/skills/revise.md`
- `openspec/changes/agent-backlog-pipeline/specs/dev-pipeline-worker/spec.md` — только четыре требования из решения 5, включая мерку ревью и возврат дефекта адресной правки.
- `openspec/changes/admit-changes-without-deltas/specs/dev-pipeline-worker/spec.md` — только первое требование из решения 5 и его условие обычного случая.
- `openspec/changes/keep-ci-waiting-out-of-tasks/specs/dev-pipeline-worker/spec.md` — только область мерки открытых пунктов и сценарий содержательной работы в требовании из решения 5; запрет ожидания и остальные сценарии сохраняются.
- `openspec/specs/dev-pipeline-worker/spec.md` — только если соответствующие исходные нормы к моменту реализации уже перенесены в основу, вместо правок их архивных снимков.
- `openspec/changes/amend-existing-deltas-in-design/verification.md`
- `openspec/changes/amend-existing-deltas-in-design/tasks.md` — обязательная отметка фактически выполненного пункта.

Добавлять в индекс фактически изменённые пути явным перечнем. Перед коммитом проверить и имена, и содержание: `git -C <дерево> diff --cached --name-only` и `git -C <дерево> diff --cached`. После создания — `git -C <дерево> show --format=fuller --stat HEAD` и `git -C <дерево> show --format= --patch HEAD`. Посторонние файлы и несвязанные изменения внутри разрешённых файлов, включая tasks.md, недопустимы. Переводы строк внутри inline code не добавлять; существующую нумерацию шагов инструкций сохранить. Команды выполнять отдельными вызовами из назначенного дерева, git — с `-C <дерево>`; формы сверены с `supervisor/config/stage-settings.json`.

Новый файл тестов не нужен для этой правки инструкций: существующий набор защищает действующие ограничения, а связность нового исключения проверяется всей матрицей с записанными основаниями. Боевой конвейер, реальные карточки и чужие ветки для проверки не запускать и не менять. Архивация и ожидание CI не входят в список задач.
