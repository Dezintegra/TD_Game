# Шаги реализации

Продолжение существующего плана name-the-commit-freshness.
Каждый отмечаемый пункт — отдельный проверяемый коммит до двух часов.
На этапе design пункты не выполняются.

Команды запускать из назначенного дерева отдельными вызовами.
В командах Git `<дерево>` заменить фактическим путём в кавычках.
Формы сверены с supervisor/config/stage-settings.json: git -C, npx vitest,
npx prettier и npx eslint разрешены. Перед проверками реализации подготовить
зависимости по правилам implement; на проработке установка не нужна.

## 1. Формула во всех существующих скиллах

- [x] 1.1 За один коммит (до 1 часа) заменить общий пункт о следе текстом
  из design.md во всех файлах NEEDS_SESSION: сейчас их одиннадцать,
  включая decompose.md. Сверить полный состав с NEEDS_SESSION;
  коммитный след самой декомпозиции не добавлять. Сохранить свежесть у design/revise
  и коммитной половины implement, альтернативу первого PR только
  у implement и общую оговорку об удалённой ветке без хвоста.
  Сохранить запрет считать одно освежение базы следом.
  Проверка: сверить разрешённые пути с полным составом NEEDS_SESSION,
  прочитать все одиннадцать абзацев по таблице случаев design.md,
  выполнить `npx vitest run --root supervisor config/transitions.test.mjs`
  и `npx prettier --check "supervisor/skills/*.md"`.
  Отметить пункт, проверить индекс и коммит по правилам ниже,
  сразу отправить. После первого коммита имплементация открывает
  черновой pull request по своим правилам.

Разрешённые пути шага 1, добавляемые явным списком:

- supervisor/skills/audit.md
- supervisor/skills/benchmark.md
- supervisor/skills/decompose.md
- supervisor/skills/deploy.md
- supervisor/skills/design.md
- supervisor/skills/implement.md
- supervisor/skills/interpret.md
- supervisor/skills/postmortem.md
- supervisor/skills/review.md
- supervisor/skills/revise.md
- supervisor/skills/triage.md
- openspec/changes/name-the-commit-freshness/tasks.md (только отметка пункта)

## 2. Сторож свежести с учётом альтернативы PR

- [x] 2.1 За один коммит (до 2 часов) экспортировать существующую TRACE,
  расширить проверку формулы в transitions.test.mjs согласно design.md:
  типы commit и commit-or-pr брать из TRACE; все существующие копии
  проверять полным обходом NEEDS_SESSION с различением частей формулы.
  Не ограничивать обход фиксированными десятью или одиннадцатью файлами
  и не пропускать отсутствующую формулу. Сохранить действующую защиту
  двух половин, добавить синтетические пробы на утрату свежести только
  у implement, утрату PR, общей оговорки о ветке без хвоста и новый этап
  каждого типа. Добавить пробу полного обхода набора текстов по NEEDS_SESSION:
  порча свежести только в decompose.md должна назвать decompose.md.
  Добавленный в синтетический NEEDS_SESSION скилл без формулы либо
  без свежести также должен обнаруживаться и называться по имени.
  Корректный текст и переносы строк должны проходить.
  Проверка: `npx vitest run --root supervisor config/transitions.test.mjs lib/denials.test.mjs`,
  `npx prettier --check supervisor/lib/denials.mjs supervisor/config/transitions.test.mjs`
  и `npx eslint supervisor/lib/denials.mjs supervisor/config/transitions.test.mjs`.
  Отметить пункт, проверить индекс и коммит, сразу отправить.

Разрешённые пути шага 2, добавляемые явным списком:

- supervisor/lib/denials.mjs (только экспорт TRACE)
- supervisor/config/transitions.test.mjs (сторож и его пробы)
- openspec/changes/name-the-commit-freshness/tasks.md (только отметка пункта)

## Проверка состава каждого коммита

До коммита использовать `git -C <дерево> diff --cached --name-only`
и `git -C <дерево> diff --cached`: допустимы только пути текущего шага
и его рабочие изменения вместе с собственной отметкой выполнения.
После коммита проверить `git -C <дерево> show --format=fuller --stat HEAD`
и `git -C <дерево> show --format= --patch HEAD`. Допуск пути не разрешает
постороннее содержание. Отправка — `git -C <дерево> push`.
Ожидание CI ведёт супервизор, отмечаемой задачей оно не является.
