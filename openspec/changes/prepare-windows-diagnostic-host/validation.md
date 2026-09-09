## Имплементация 09.09.2026

Собственный draft PR: 234. Пункт 1.1 отправлен коммитом
`e5d09482158b8146a807d383c8b39572aac6eabf`. Ветка и дерево соответствуют
назначению; fetch выполнен, merge origin/main: Already up to date.
Зависимости установлены своим `pnpm install --frozen-lockfile --prefer-offline`.

### Проверка контракта 2.1

Закреплённый источник PR 232:
`07b7085ff932d4ccd4d17d7ec6567092bff03645`. Сценарий
`.matchlog/0302-host-contract.mjs` извлёк из этого Git-коммита 90 файлов — модули и
файл назначения — в `.matchlog/0302-host-contract/`. До импорта и после проверки
все SHA-256 совпали с извлечёнными байтами; опись сохранена в `source.json`.
Изменяемые соседние копии не импортировались. Ветка PR 232 не сливалась.

`node .matchlog/0302-host-contract.mjs` завершился с кодом 0:
`contractPassed=true`, `sourceUnchanged=true`, порядок вызовов
consumerAssignment → baseline → target → resume, три результата исходного
классификатора. Target/resume имеют одинаковый профиль и session id;
baseline отличается отсутствием двух точных grants. Все семь начальных файлов
стенда совпадают с контрактом PR 232, окружение доверяет только тестовым root/tree.
Результат сохранён в `.matchlog/0302-host-contract/result.json`.

После окончательной интеграции проверка повторена тем же скриптом с повторной
сверкой сохранённых исходников и отдельным тестовым каталогом `contract-final`.
Код 0, те же результаты; `.matchlog/0302-host-contract/result-final.json`.
Прежние исходники, тестовый стенд и result.json не перезаписывались.

Это синтетическая проверка подключения с настоящей Git-топологией только
собственного тестового репозитория. Consumer, CLI-version и события инструментов
подменены; прежний runProbeSession используется с тестовым start.
`nativeSessions=0`, `permissionAcceptance=not-run`. Настоящая 0083 и её черновики,
прежнее evidence 0299 и PR 232 не изменялись. Их живая сохранность этой проверкой
не доказывается и должна быть подтверждена внешним свидетельством.

### Локальные проверки

- Три новых набора Vitest: 48 тестов прошли, включая отказы идентичности,
  ссылки/reparse, занятые пути, изоляцию env, baseline/target/resume, смену
  назначения/версии/источника и остановку после неожиданной записи контроля.
- Первый обязательный `pnpm test:pipeline`: 2574 passed, 1 failed,
  89 файлов passed, 1 failed. Существующий `lib/watch-lifetime.test.mjs`,
  сценарий replacement writer: `Timed out: new PID and both streams`.
  Причина уже относится к карточке 0284; она не дублируется и этот файл не правится.
- После 2.1 повторный `pnpm test:pipeline`: 2589 passed, 1 failed,
  90 файлов passed, 1 failed; тот же watch-lifetime timeout, других ошибок нет.
  Последующий узкий прогон окончательного адаптера: все 48 тестов прошли.
- ESLint, Prettier по изменённым JS/Markdown и `git diff --check` прошли;
  `openspec validate prepare-windows-diagnostic-host --strict` прошёл.
  Вызов CLI без доводов завершился с кодом 0 и только напечатал помощь.
- Git предупреждал о Permission denied при чтении личного ignore-файла;
  команды Git завершались успешно. Доступ не изменялся, обхода не было.
  Отказов автоматической проверки разрешений в этой сессии не получено.

### Обязательная передача владельцу

Пункт 3.1 остаётся открытым: внешний prepare ещё не выполнен. Из этой сессии
`--prepare` не вызывался; чужие контексты и дочерние модели не использовались.
После отправки 2.1 ниже фиксируются SHA оснастки и хеши её модулей/конфигурации.
Внешняя предпосылка windows-host-evidence требует запуска штатным владельцем
NB3391 после окончания этой сессии и до новой проверяющей сессии 0302.

Сохранённое дерево:
`C:/src/dezintegra/TD_Game/.claude/worktrees/0302-podgotovit-razreshennyy-windows-marshrut`.
Home: его `supervisor/`. Ветка:
`worktree-0302-podgotovit-razreshennyy-windows-marshrut`. Владелец проверяет
чистоту исходников, отправленный SHA и отсутствие активного исполнителя;
из этого cwd выполняет `node supervisor/bin/prepare-project-skill-host.mjs --prepare`.
Супервизор не перезапускается, работающий home не обновляется.

Результат остаётся по `.matchlog/0302-project-skill-host-evidence.json` внутри
этого дерева. Владелец передаёт абсолютный путь, SHA-256, sourceSha, finishedAt
и очищенный итог через свой штатный канал внешней предпосылки. Требуются
hostReady=true, cliStart=true, permissionAcceptance=not-run, sessions=[],
неизменные опись/хеши 0083 и прежнее evidence 0299. Комментарий без доступного
файла не принимается. Вливание 0302 или PR 232 не является предусловием запуска.
После результата — новый анализ 0302 и отдельная сессия 3.1. Полная приёмка
остаётся у существующей 0299 с сохранёнными PR/change/evidence и расходом.

## Отправленная оснастка для внешней подготовки

Пункт 2.1 отправлен: `22623477ef3e10ddafe85f205524cd57580d0238`, draft PR 234.
Это ревизия исполняемого кода. Последующий коммит этой записи содержит только
плановые свидетельства: допускается запуск из сохранённого дерева на таком
потомке при полном совпадении следующих хешей. Evidence записывает фактический
HEAD в sourceSha; его родство с указанной ревизией проверяет новая сессия.

SHA-256 байтов файлов в сохранённом дереве (сняты после отправки 2.1):

```json
{
  "sources": {
    "supervisor/lib/windows-diagnostic-host.mjs": "ef933abf44673ff2ecd3a8351461ac2a28ca1b745eac06eeca56b2a5c417c142",
    "supervisor/lib/project-skill-host-fixture.mjs": "1d91db631a2af2e22f9279d7f1fdc95da382fe1ad70e3f93b3534a0431f0dfec",
    "supervisor/lib/codex-environment.mjs": "963a139837eabd12a8079705ab81909133da72695ede2e4a4e91806c2139c5fa",
    "supervisor/lib/provider.mjs": "49cc0cbbfcd7032bd54ebd490cfae15c9d7912f5e957e511f84456d9a387fbb2",
    "supervisor/lib/run-stage.mjs": "59ae4fc136c824e103c3397cb03a3bce7ba593663d79bbda91da34e9847d89fb",
    "supervisor/lib/codex-perf-files.mjs": "05f7b640b7c4f5b449c3ebeef62faf5f6423ad13ad49d8e39563dd7f739b2fb3",
    "supervisor/lib/token-budget.mjs": "d9cf44577ad99efa165f7d8098483e3c1dd4c743e87567d50324ca5a6100f0e7",
    "supervisor/lib/stage-model.mjs": "3cdfe20eb507595bee24cf510f48b413d7e2079e71299ae3102c184c21b210b9",
    "supervisor/bin/prepare-project-skill-host.mjs": "6c5409e26ace54a7553ab5404c77bb2db13865c7808b8816c6427eae038fccc4",
    "supervisor/bin/codex-runner.mjs": "a4a9f9c808ba09973b6f6ebecdda00e9e84e976d5589dd82751d2101ea4db796",
    "supervisor/pipeline.config.json": "097f296c6b2d6ef094201f93bd557621c3108e19d0e42ac01651c6799f2f50de",
    "supervisor/config/stage-settings.json": "35d3247c16810c2ff53b7c4eb8dd365713ca784a878d4326814dce25ae64e698"
  },
  "configDigest": "b487b4194d12d10b4ce8299549b8b1efb8dfc1c33927fce96e7556782663b5cc"
}
```

Проверка хешей: `node .matchlog/0302-host-source.mjs` (только чтение собственных
модулей и репозиторной конфигурации). Владелец передаёт новое свидетельство по
абсолютному пути `C:/src/dezintegra/TD_Game/.claude/worktrees/0302-podgotovit-razreshennyy-windows-marshrut/.matchlog/0302-project-skill-host-evidence.json`.
Пункт 3.1 не отмечен; этот коммит не является живым свидетельством.
