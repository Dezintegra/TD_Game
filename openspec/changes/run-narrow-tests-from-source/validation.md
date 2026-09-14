# Живая приёмка 0337

13 сентября 2026 года проверен чистый отправленный SHA
`ddf751d1bbc5acd277f1117a3f10a8da06b6e073` в назначенном дереве
`C:/src/dezintegra/TD_Game/.claude/worktrees/0337-obespechit-uzkie-proverki-sim-i-ai-posle`.
Среда: Windows, Node v24.3.0, pnpm 10.12.4, Vitest 2.1.9, Git 2.45.1.windows.1.

## Подготовка и команда

```powershell
node scripts/testing/check-source-tests.mjs --fresh
```

Общий checker вызван напрямую, без временной конфигурации. Существующий
`checkInstallSnapshot` создал собственную копию архива HEAD и установил
346 пакетов с `--frozen-lockfile --store-dir .pnpm-store`, первоначально
без node_modules и кеша. Проверки установки, чистоты и отрицательные контроли
Git прошли. Исходное дерево осталось чистым на том же SHA.

Итог: `.matchlog/source-check-00NiED/result.json`, `ok: true`.
Подготовка: `.matchlog/install-check-oqemnE/result.json`, `ok: true`.
Проверенная копия: `.matchlog/install-check-oqemnE/snapshot`.
Пути таблицы относительны этой копии. Локальные отчёты остаются игнорируемыми;
в коммит входит это свидетельство.

## Фактически исполненные файлы

| Среда | Файл | Passed | Каталог отчёта в `.matchlog/` |
| --- | --- | ---: | --- |
| node | packages/sim/src/crowd.test.ts | 11 | source-test-SKCrGV |
| node | packages/sim/src/step.test.ts | 98 | source-test-SKCrGV |
| jsdom | packages/sim/src/crowd.test.ts | 11 | source-test-MNZrbF |
| jsdom | packages/sim/src/step.test.ts | 98 | source-test-MNZrbF |
| node | packages/sim/src/determinism.golden.match.test.ts | 5 | source-test-djtnDr |
| jsdom | packages/sim/src/determinism.golden.match.test.ts | 5 | source-test-PVkcvm |
| node | packages/ai/src/profile.golden.match.test.ts | 5 | source-test-eIWWKT |

Пять вызовов, 233 успешных исполнения. Везде failed/skipped равны нулю;
нет посторонних или отсутствующих файлов. Каждый каталог содержит
`vitest.json` и `result.json`. `noDistBefore`, `noDistAfter`, `controlsNoDist`
равны true: shared/sim/ai dist отсутствовали до матрицы, после неё и контролей.

## Контроли чтения исходников

Только в собственной копии checker поочерёдно добавлял уникальную ошибку
в src/index.ts и восстанавливал исходные байты через finally.

- shared: ошибка `TD_SOURCE_CONTROL_SHARED` обнаружена при загрузке crowd,
  отчёт `source-test-wF4ni1`. После восстановления прошли 11 тестов,
  отчёт `source-test-akubVV`.
- sim: ошибка `TD_SOURCE_CONTROL_SIM` обнаружена при загрузке golden ai,
  отчёт `source-test-SiQrAk`. После восстановления прошли 5 тестов,
  отчёт `source-test-BrgIOD`.

Оба detected, restoredBytes и restored.ok равны true. Это реальные провалы
и повторные загрузки исходников копии, не mocks. Игровые правила и эталоны
ветки 0337 не изменены.

## Проверки оснастки и ограничения

Успешны 17 тестов source-runner, 15 check-source-tests, 8 source-tests-ci
и 26 ci-affected с `--root scripts`. ESLint и Prettier рабочих файлов прошли.

Обязательный `pnpm test:pipeline` выполнен через собственный переходник
`node .matchlog/0337-checks.mjs pipeline`, передающий TMP/TEMP/TMPDIR в
собственный каталог дерева для существующих временных фикстур. Прошли
2940 из 2941 теста, включая 12 новых проверок команд и 233 transitions.
Единственное падение — существующий watch-lifetime: `new PID and both streams`.
Адресный повтор watch-lifetime и новых команд: 13 прошли, тот же один тайм-аут.
Файлы наблюдателя и теста не отличаются от origin/main. Аналогичная проблема
уже названа задачей 0284 в confirm-contradictory-ci-results/tasks.md и
permit-node-syntax-checks/tasks.md. Общий набор не объявляется зелёным.

Первый свежий запуск на том же SHA, отчёт
`.matchlog/source-check-Od15UF/result.json`, завершился системным кодом Node
3221225477 после 98 тестов step без итогового JSON Vitest. Checker отверг
неполный результат. Та же узкая команда в назначенном дереве прошла 109 тестов;
повтор всей свежей приёмки без правки кода дал полный успех выше. Причина
единичного системного завершения не установлена; её устранение не заявляется.

Однократное чтение CI первого коммита выявило сбой tinypool в быстрой фикстуре.
Исправление a37789f4 изолирует pnpm-workspace фикстуры от родителя; локальная
регрессия проходит. ddf751d1 добавляет разрешение pnpm/action-setup launcher
при самостоятельном Node-вызове в CI, сохраняя контракт помощника установки.
Результаты CI после отправок не ожидались.

Git предупреждал о Permission denied при чтении пользовательского ignore,
команды завершались успешно. Отказов политики на команды и обходов не было.
Полные игровые наборы, сборки и арена не запускались.

## Доработка после красного CI, 14 сентября 2026

Run 34778720113, job 103781680309, head `3087ca0e`, checkout
`3bf55b92befcd1f1fe6bba6effbb4359ae268b95`: режим `--installed` остановился
до матрицы с `Prerequisites: installed pnpm CLI not found`. В логе указан
PNPM_HOME `/home/runner/setup-pnpm/node_modules/.bin`. Установка action-setup
использует pnpm и добавляет этот каталог в PATH; обычный shell-shim в нём
не превращается через realpath в pnpm.cjs. Прежний тест моделировал только ссылку.

Коммит `3d019daec99e3088b1ee4f1d8b316ae1adfead5f` добавил поиск соседнего
`pnpm/bin/pnpm.cjs` с сохранением существующего помощника и поддержки ссылок.
Новый тест создаёт обычный shell-shim и запускает найденный CLI реальным Node;
отдельный контроль отвергает shim без установленного пакета. Успешны 17 тестов
checker, ESLint, Prettier и OpenSpec strict (status 4/4).

На этом чистом отправленном SHA выполнено:

```powershell
node scripts/testing/check-source-tests.mjs --installed
```

Windows, Node v24.3.0, pnpm 10.12.4, Vitest 2.1.9. Результат
`.matchlog/source-check-hKptxn/result.json`: `ok: true`. Пять запусков в
назначенном дереве дали 233 успешных исполнения: crowd/step — 11/98 в каждом
из node/jsdom, golden sim — по 5, golden ai — 5. Состав точный, failed/skipped
равны нулю. Каталоги отчётов соответственно `source-test-XcKBjG`,
`source-test-Kd0EvS`, `source-test-eOP12A`, `source-test-uS9PBu`,
`source-test-xhLTIp` в собственном `.matchlog`.

Созданная из этого SHA копия `.matchlog/source-check-hKptxn/controls` получила
собственную установку. Оба маркера TD_SOURCE_CONTROL_SHARED/SIM обнаружены;
байты восстановлены, повторные crowd (11) и golden ai (5) успешны.
`noDistBefore`, `noDistAfter`, `controlsNoDist` равны true. Проверка подтвердила
неизменность HEAD и чистоту исходного дерева. Это локальная проверка режима
CI на Windows; результат нового Linux CI не ожидался и здесь не утверждается.

Main обновлена слиянием `adc9cc06` без конфликтов. Игровые файлы и эталоны
не менялись. Отказов политики не было; предупреждение Git о недоступном
пользовательском ignore не мешало командам и не обходилось.

## Передача 0013 после доработки

Черновой PR ремонта — 272. Памятка `docs/narrow-source-tests.md` даёт команды
и замену временной подготовки всех трёх пунктов increase-unit-spacing.
Назначенная сессия 0013 сохраняет PR 265 и атомарное обновление обоих golden
вместе с радиусом. После доставки ремонта обязательны проба исходного implement
и `incidentVerification` с фактическими свидетельствами. Служебная приёмка
не закрывает исходный инцидент и не заменяет пробу 0013.
