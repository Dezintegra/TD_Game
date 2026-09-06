# Проверка предусловия 0243

## Источник и согласование документов

Проверка implement 07.09.2026. Назначенная ветка 0247 подтверждена, дерево исходно чистое. `git -C . fetch origin` выполнен, `git -C . merge origin/main` ответил `Already up to date.` Установка `pnpm install --frozen-lockfile --prefer-offline` завершилась успешно.

В свежей базе каталог `stop-launches-on-session-outages` отсутствовал. Полный каталог из шести файлов перенесён только в дерево 0247 командой `git -C . restore --source=17aed1e1b0766c4e08f89e5542528559c7fdb9dd -- openspec/changes/stop-launches-on-session-outages`. Источник — опубликованная ветка `origin/worktree-0243-ostanavlivat-novye-zapuski-pri-nesostoya`; её SHA подтверждён после fetch. Код 0243 не переносился, её дерево не изменялось.

После явного добавления шести новых для этой ветки файлов `git -C . diff 17aed1e1b0766c4e08f89e5542528559c7fdb9dd -- openspec/changes/stop-launches-on-session-outages` показывает изменения только design.md и tasks.md. До добавления Git считал неотслеживаемые файлы отсутствующими при сравнении с другой ревизией; тот предварительный вывод не использован как результат проверки.

Дословно сохранены `.openspec.yaml`, README.md, proposal.md и `specs/pipeline-supervision-resilience/spec.md`. Все четыре чекбокса 0243 и их содержание сохранены; алгоритмы и сценарии не менялись. Добавлены общее удержание до closed 0242 и MERGED PR 177, его охват модели 1.1 и resume, повторная проверка перед 3.1, проверка предка mergeCommit и наличия dependencyUpdates/readStartTask после обновления дерева. Самостоятельность коммита не разрешает раннюю сессию. Порядок поставки 0243/0244 действует после общего допуска.

`openspec validate stop-launches-on-session-outages --strict` завершился кодом 0: `Change 'stop-launches-on-session-outages' is valid`. Проверка Prettier двух изменённых плановых файлов прошла.

Git предупреждает об отказе чтения `C:\Users\dmitry.ivanov/.config/git/ignore`; команды завершаются успешно, обход ограничений не выполнялся.

## Поставка канала

`gh pr view 177 --json number,state,mergedAt,baseRefName,mergeCommit,headRefOid` вернул:

```json
{
  "baseRefName": "main",
  "headRefOid": "4c9ed9a2c3140d2fbfc66155f28096eb30c84bd3",
  "mergeCommit": null,
  "mergedAt": null,
  "number": 177,
  "state": "OPEN"
}
```

Поставка канала и ревизия принимающего супервизора не подтверждены. Поле dependencyUpdates пока не передаётся, запись карточки и независимый GET не объявляются выполненными. Пункт 2.1 остаётся открытым до готовности канала и проверки его поставленных тестов. Реальная failed-карточка не читалась и не изменялась. Review должен повторно сверить актуальную ветку 0243 и проверить последующее свидетельство записи метаданных.
