# Задачи

Каждый пункт — отдельный коммит, отправляемый сразу.

Тесты конвейера обычным `vitest` не видны, у них свой корень:
`npx vitest run --root supervisor <файл>`.

## 1. Правило

- [x] 1.1 Завести изменение OpenSpec: предложение, замысел, дельта
      спецификации `dev-backlog`, задачи. Проверяемо:
      `openspec validate --changes --strict` зелёный

## 2. Признак и положение карточки

- [ ] 2.1 Проводить признак блокирующей до задачи полем `blocking: true`
      (`supervisor/lib/requests.mjs`), объявить поле в `manage/schema.json`,
      заводить такую карточку с `pos: 'top'`
      (`supervisor/lib/backlog-trello.mjs`). Проверяемо:
      `requests.test.mjs` — блокирующая задача несёт поле и проходит
      схему, обычная, прогон и заявка с чужого этапа поля не несут;
      `backlog-trello.test.mjs` — блокирующая карточка заводится
      с `pos: 'top'`, обычная с `pos: 'bottom'`

## 3. Документы

- [ ] 3.1 Сказать в `manage/README.md` и `supervisor/skills/postmortem.md`,
      что блокирующая заявка встаёт первой в очереди. Проверяемо:
      `npx prettier --check` по обоим файлам зелёный
