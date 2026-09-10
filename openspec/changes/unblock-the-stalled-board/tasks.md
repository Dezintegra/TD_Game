## 1. Закрытие снимает ожидание у ждущих

- [ ] 1.1 Ввести разрешение рёбер при закрытии: в `supervisor/lib/closure.mjs`
  собрать ждущих закрываемую карточку по `dependsOn` и `recovery.fixedBy`,
  при непустом `splitInto` перевести ребро на части, иначе снять. В
  `supervisor/lib/scan.mjs` планировать действие по снимку доски, чтобы
  разбирался и уже накопившийся затор. Комментарий ждущей карточке содержит
  причину закрытия предшественника дословно и основание снятия.
  Проверка: `npx vitest run --root supervisor lib/closure.test.mjs lib/scan.test.mjs`.
  Пути: `supervisor/lib/closure.mjs`, `supervisor/lib/closure.test.mjs`,
  `supervisor/lib/scan.mjs`, `supervisor/lib/scan.test.mjs`,
  `supervisor/lib/execute.mjs`, отметка пункта здесь.

- [ ] 1.2 Закрепить частичность и повторность: неудача на одной ждущей карточке
  не отменяет остальных и не мешает закрытию; повтор на неизменном снимке
  не дублирует комментарий; снятие последнего ребра возвращает задачу в очередь
  обычной разблокировкой с сохранением счётчиков, положения и артефактов.
  Проверка: `npx vitest run --root supervisor lib/closure.test.mjs lib/dependencies.test.mjs`.
  Пути: `supervisor/lib/closure.test.mjs`, `supervisor/lib/dependencies.test.mjs`,
  отметка пункта здесь.

## 2. Неизвестный расход перестаёт удерживать

- [ ] 2.1 Убрать причину `unknown-usage` из `tokenAdmission`
  (`supervisor/lib/token-hold.mjs`), сохранив `exhausted` и `invalid-limit`.
  Неучтённый заход писать в журнал цикла и одной записью в карточку, не
  предлагая владельцу поднять лимит. Возвращать в сохранённый этап карточки,
  удержанные исключительно по незнанию, с сохранением `returnTo`, положения,
  счётчиков, ссылок и владельца.
  Проверка: `npx vitest run --root supervisor lib/token-hold.test.mjs lib/token-budget.test.mjs`.
  Пути: `supervisor/lib/token-hold.mjs`, `supervisor/lib/token-hold.test.mjs`,
  `supervisor/lib/token-budget.test.mjs`, отметка пункта здесь.

## 3. Застрявшее ожидание получает разбор

- [ ] 3.1 Дать `acceptedWait` срок: принимать `now` и предел (по умолчанию сутки),
  освобождать от разбора только внутри предела. Назначать разбор немедленно,
  если предшественник в терминальном состоянии без требуемого результата,
  пропал или негоден. Сверить `sameEpisode` с `originSince`, чтобы наблюдение
  не глушило повторный разбор после истечения срока.
  Проверка: `npx vitest run --root supervisor lib/delay-analysis.test.mjs`.
  Пути: `supervisor/lib/delay-analysis.mjs`, `supervisor/lib/delay-analysis.test.mjs`,
  отметка пункта здесь.

- [ ] 3.2 Сохранить действующие регрессии: порог ровно пять часов для обычного
  рабочего статуса, немедленная проверка непроверенного `awaiting-po`,
  отсутствие повторного разбора подтверждённого вопроса, доставка `delayJournal`,
  диагностика неполного `blockedContext`.
  Проверка: та же команда; убедиться, что перечисленные сценарии выполняются.
  Пути: `supervisor/lib/delay-analysis.test.mjs`, отметка пункта здесь.

## 4. Колонка «Обслуживание»

- [ ] 4.1 Ввести состояние `maintenance`: `STATES` (позиция задаёт порядок колонок),
  `STATE_CLASS` класса `queue`, маршруты для `feature` и `note` в
  `supervisor/config/transitions.mjs`; `trello.lists.maintenance: 'Обслуживание'`
  в `supervisor/config/defaults.mjs`; статус в `supervisor/config/task-schema.json`.
  Проверка: `npx vitest run --root supervisor config/transitions.test.mjs config/defaults.test.mjs`.
  Пути: `supervisor/config/transitions.mjs`, `supervisor/config/defaults.mjs`,
  `supervisor/config/task-schema.json`, `supervisor/config/transitions.test.mjs`,
  `supervisor/config/defaults.test.mjs`, отметка пункта здесь.

- [ ] 4.2 Направить заявки про конвейер в «Обслуживание» по объявленной области
  работы, а не по догадке; кандидатами оставить только предложения про игру.
  Перенести при включении уже лежащие в кандидатах карточки с областью
  «конвейер», сохранив описание, метки, связи и относительный порядок.
  Проверка: `npx vitest run --root supervisor lib/requests.test.mjs`.
  Пути: `supervisor/lib/requests.mjs`, `supervisor/lib/requests.test.mjs`,
  отметка пункта здесь.

- [ ] 4.3 Брать «Обслуживание» раньше «Заведено» одной сортировкой отбора,
  сохранив право прогонов идти вне очереди и все действующие проверки квот,
  зависимостей и удержаний.
  Проверка: `npx vitest run --root supervisor lib/scan.test.mjs`.
  Пути: `supervisor/lib/scan.mjs`, `supervisor/lib/scan.test.mjs`,
  отметка пункта здесь.

## 5. Замер перестаёт сторожить выкладку

- [ ] 5.1 Различить исходы замера: `scripts/perf-run.mjs` отдаёт 2 при взятом
  замере с непройденным порогом и 1 при несостоявшемся. `scripts/deploy.mjs`
  продолжает выкладку при 2, называя просадку, и умирает при 1.
  Проверка: `npx vitest run scripts/perf-run.test.mjs` либо узкий тест разбора
  кодов, если файла нет — завести его.
  Пути: `scripts/perf-run.mjs`, `scripts/deploy.mjs`, тест разбора кодов,
  отметка пункта здесь.

- [ ] 5.2 Оставить замер только перед выкладкой: отклонять заявку на прогон вида
  `perf`, убрать предложение замера по ходу обычной задачи из скиллов и из
  `CLAUDE.md`. Заявку на просадку класть в «Обслуживание» с ревизией, медианами,
  порогом, занятостью и составом пакета.
  Проверка: `npx vitest run --root supervisor lib/requests.test.mjs config/transitions.test.mjs`.
  Пути: `supervisor/lib/requests.mjs`, `supervisor/lib/requests.test.mjs`,
  `supervisor/skills/deploy.md`, `supervisor/skills/benchmark.md`, `CLAUDE.md`,
  отметка пункта здесь.

## 6. Выкладка пакетом по порогу и сроку

- [ ] 6.1 Ввести условие запуска пакета в `supervisor/lib/scan.mjs`: не меньше
  пяти накопленных задач либо не меньше пяти часов с прошлой выкладки, оба
  порога настраиваемые. Разобрать `now` в `scan()`. Причину ожидания называть
  числом накопленных и временем с прошлой выкладки.
  Проверка: `npx vitest run --root supervisor lib/scan.test.mjs`.
  Пути: `supervisor/lib/scan.mjs`, `supervisor/lib/scan.test.mjs`,
  `supervisor/config/defaults.mjs`, отметка пункта здесь.

- [ ] 6.2 Хранить время прошлой выкладки в состоянии конвейера: записывать при
  переносе успешного отчёта выкладки, поднимать при запуске, переживать
  перезапуск. Отсутствие записи считать выполненным сроком.
  Проверка: `npx vitest run --root supervisor lib/report-plan.test.mjs lib/scan.test.mjs`.
  Пути: `supervisor/lib/report-plan.mjs`, `supervisor/lib/report-plan.test.mjs`,
  `supervisor/bin/supervise.mjs`, отметка пункта здесь.

- [ ] 6.3 Согласовать спеку соседнего изменения: сценарий «Единственная задача
  в выкладке получает сессию» в `openspec/changes/batch-deploy` противоречит
  порогу и должен быть приведён к новому условию либо явно подчинён ему.
  Проверка: `openspec validate unblock-the-stalled-board --strict`.
  Пути: `openspec/changes/batch-deploy/specs/dev-pipeline-supervisor/spec.md`,
  отметка пункта здесь.

## 7. Прерываемая машина поднимается сама

- [ ] 7.1 Завести `scripts/ensure-deploy-host.mjs`: проверка доступности хоста,
  подъём облачной утилитой с ограниченным сроком и без интерактивности,
  ожидание готовности ограниченное время, внятные коды возврата. Протухшие
  учётные данные дают быстрый отказ с причиной, а не молчаливое ожидание.
  Проверка: `npx vitest run scripts/ensure-deploy-host.test.mjs`.
  Пути: `scripts/ensure-deploy-host.mjs`, `scripts/ensure-deploy-host.test.mjs`,
  отметка пункта здесь.

- [ ] 7.2 Разрешить сценарий конвейеру и переписать скилл выкладки: снять запрет
  на подъём машины человеком, назвать разрешённую команду, потребовать
  упоминания подъёма в отчёте. Сверить дословные формы команд со сторожем
  покрытия.
  Проверка: `npx vitest run --root supervisor config/transitions.test.mjs config/syntax-check-permissions.test.mjs`.
  Пути: `supervisor/config/stage-settings.json`, `supervisor/config/permissions.mjs`,
  `supervisor/skills/deploy.md`, `supervisor/config/transitions.test.mjs`,
  отметка пункта здесь.

## Проверки каждого коммита

Работа идёт в назначенном рабочем дереве. Полные проверки, сборку, арену
и матчевый набор здесь не запускать — за этим есть CI (правило 6 CLAUDE.md).
Локально только узкое: `npx vitest run --root supervisor <свои файлы>` для
модулей супервизора, `npx vitest run <свой файл>` для `scripts`,
`npx eslint <свои файлы>` и `npx prettier --check <свои файлы>`.

Ключ `--root supervisor` обязателен: обычный `vitest` тестов супервизора
не видит.

Стейджить только свои пути явным списком: `git add -- <файлы>`. `git add -A`
затаскивает чужую незавершённую работу. Каждый коммит немедленно отправлять.
Тело коммита передавать файлом через `git commit -F`: проза внутри `-m`
отказывается правилами разрешений.

Задача считается сделанной по зелёному CI на pull request, а не по локальному
прогону. В конце проверить `openspec validate unblock-the-stalled-board --strict`.
