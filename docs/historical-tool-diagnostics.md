# Адресная диагностика исторических назначений

Базовый вход поставлен коммитом `62d8e4d4dfb875d2ce3ca40ab4f7a56d749f7b96`
ветки `worktree-0383-obespechit-adresnyy-vhod-diagnostiki-024`, PR #303.
Для приёмки до вливания используется сборка с поправкой аттестации владельца
из PR #307; её фактический `codeSha` берётся из загруженного коммита.
Это инструкция Windows-хозяину, а не разрешение исполнителю менять чужое
дерево, `.pipeline`, настройки безопасности или работающий супервизор.
Фактическая загрузка сборки и четыре живых ответа пока не подтверждены.

## Подготовка владельцем

Хозяин устанавливает согласованный код штатным порядком обслуживания
существующего runtime. Нельзя запускать второй writer того же report-store.
Сохраняются его root, конфигурация provider, ledger, registry, pending reports
и все ограничения запуска. К штатной команде `node supervisor/bin/supervise.mjs`
добавляется `--diagnostic-endpoint`. Установка невлитой версии требует
отдельной подготовки хозяина: основной checkout не переключают, дерево
исполнителя 0383 не меняют и проверку идентичности не обходят.

### Временный runtime из подтверждённого дерева

Хозяин сначала сверяет точный коммит сборки PR #307, зелёный CI, чистоту
`supervisor/`, регистрацию дерева в `git worktree list --porcelain` и общий
Git common-dir с основным checkout. В `.pipeline/pending-reports.json` не
должно быть незавершённых обычных отчётов, а у супервизора — живых этапов.
После этого хозяин ставит собственную временную `.pipeline/pause` и штатно
останавливает старого владельца через `node supervisor/bin/launch.mjs --stop`.
Если пауза уже принадлежит другому инциденту, её не заменяют и не снимают.
Планировщик Windows `TD pipeline supervisor` временно отключают перед
переключением и обязательно включают обратно после возврата main: его
нынешний код ещё не умеет опознавать невлитого владельца. Один свежий lock
сам по себе всё равно не даёт второму процессу стать writer, но не должен
быть основанием для лишних запусков или удаления lock старым `--stop`.

В PowerShell из основного checkout, указав реальное зарегистрированное
дерево сборки и сохранённую конфигурацию, запускают один процесс:

```powershell
$projectRoot = 'C:\src\dezintegra\TD_Game'
$stagedRoot = '<абсолютный путь проверенного дерева сборки>'
$entry = Join-Path $stagedRoot 'supervisor\bin\supervise.mjs'
$config = Join-Path $projectRoot '.pipeline\pipeline.codex.local.json'
$owner = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' `
  -ArgumentList @($entry, '--provider=codex', '--quiet', "--config=$config", '--diagnostic-endpoint', $projectRoot) `
  -WorkingDirectory $projectRoot -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $projectRoot '.pipeline\host-diagnostic-supervisor.out.log') `
  -RedirectStandardError (Join-Path $projectRoot '.pipeline\host-diagnostic-supervisor.err.log') -PassThru
```

При включённом endpoint проверка Codex выполняется и под ручной паузой;
пауза продолжает удерживать обычную выдачу задач. Дескриптор обязан назвать
`entrypoint`, `codeSha`, `rootSha`, `runtimeSha=codeSha`, PID/Windows SID и
generation. Хозяин сопоставляет PID с единственным lock, командной строкой
процесса и HEAD подтверждённого дерева. Клиент повторяет проверку Git и
командной строки перед каждым обращением. Если endpoint не появился или
проверка отказала, хозяин сохраняет точную ошибку, останавливает только
этот runtime, восстанавливает обычный запуск из main и снимает только свою
временную паузу. Отсутствие endpoint не считается диагностическим ответом.

После сохранения всех четырёх ответов и повторных get хозяин останавливает
staged-процесс через `node <stagedRoot>/supervisor/bin/launch.mjs --stop
--root=<projectRoot>`: этот пускатель проверяет staged owner по его
дескриптору. Затем штатно запускает runtime main, снимает только свою паузу,
включает планировщик Windows и проверяет следующий цикл. Старым пускателем
main останавливать живой staged runtime нельзя, пока исправление не влито.

До обращения хозяин подтверждает SHA загруженного кода, чистоту `supervisor/`,
PID и идентичность владельца lock, отсутствие второго владельца каждого
назначения, его актуальные cwd/ветку, provider и полномочия на чтение.
Проверка PID включает существующую проверку командной строки супервизора;
одного наличия процесса недостаточно. Код сам создаёт локальный named pipe
с защищённой ACL текущего Windows SID и запретом сетевых клиентов.
Непроверенная ACL или неподтверждённый клиент означают отказ.

Runtime публикует `.pipeline/diagnostic-endpoint.json`: `entrypoint`,
`codeSha`, `rootSha`, `runtimeSha` (равен `codeSha`),
`generation`, `ownerPid`, `helperPid`, `ownerUser`, `ownerSid`, `acl`,
`lockPath`, `root`, `startedAt`, `storePath`. Путь относится к каталогу
локального состояния этого владельца. Он не является полномочием сам по себе.

## Запрос и подтверждение контекста

JSON запроса содержит ровно шесть полей. Пример для неизвестного исторического
launchId (не утверждение, что он неизвестен у реального назначения):

```json
{
  "schemaVersion": 1,
  "requestId": "0383-0156-revise-01",
  "taskId": "0156-svesti-komandy-etapov-k-odnoy-obolochke-",
  "stage": "revise",
  "sourceLaunchId": "unknown",
  "profile": "historical-revise"
}
```

Известный исходный launchId надо сохранить. Команды, cwd, provider и полномочия
из клиентского JSON не принимаются. Допустимы только следующие назначения:

| taskId                                        | stage  | profile                  | Контроли                         |
| --------------------------------------------- | ------ | ------------------------ | -------------------------------- |
| 0156-svesti-komandy-etapov-k-odnoy-obolochke- | revise | historical-revise        | revise.md, Git status            |
| 0208-zavesti-storozha-na-ssylki-po-nomeram-sh | revise | historical-revise        | revise.md, Git status            |
| 0175-razmetit-komandnye-bloki-supervisor-skil | revise | historical-revise-design | revise.md, design.md, Git status |
| 0074-zhurnal-zadachi-v-prompte-etapa-obrezaet | audit  | historical-audit         | audit.md, Git status             |

Хозяин сохраняет в своём каталоге состояния `diagnostic-authorizations.json`
объект `{ "schemaVersion": 1, "requests": [] }`, добавляя отдельное разрешение
для каждого requestId. Разрешение содержит `requestId`, `fingerprint`,
`generation`, `ownerUser`, `noCompetingOwner: true`, непустое
`coordinationEvidence`, `expiresAt` (UTC, не более 15 минут вперёд),
`prepareOnly` и затем `source`. При согласованной диагностике на ручной паузе
нужно явное `duringPause: true`; это не снимает прочие ограничения запуска.
Fingerprint получают штатной `parseDiagnosticRequest(request).fingerprint`
из `supervisor/lib/addressed-tool-diagnostics.mjs`: SHA-256 компактного JSON
в порядке шести полей примера. Хеш форматированного файла для этого не подходит.

Первое разрешение имеет `prepareOnly: true`. Submit возвращает
`ok: false, reason: "owner-confirmation-required"`, наблюдаемые `source`,
`generation`, `fingerprint`, `observedAt`. Это подготовка без запуска provider,
записи диагностического запроса или расхода; это ещё не диагностический ответ.
Хозяин проверяет полученные task/status, cwd, branch/head, context,
providerVersion/runtimeSha и history. В `history` сохраняются доступные
исторические идентификаторы и ссылки на свидетельства; неизвестное отмечается
явно. Для 0074 нужны оба исторических audit либо описание недоступных данных.
После проверки хозяин сохраняет подтверждённый `source` в разрешении,
ставит `prepareOnly: false` и повторяет тот же submit. Истечение разрешения,
смена контекста, живое назначение, чужой владелец, лимит или incident hold
дают отказ. Нельзя подгонять source или снимать ограничения ради запуска.

## Точные обращения

Следующие команды выполняет хозяин из `C:/src/dezintegra/TD_Game` после
подготовки существующего runtime. Файл примера запроса он сохраняет как
`.matchlog/0383-0156-request.json`:

```powershell
node supervisor/bin/diagnose-assignment.mjs submit --endpoint .pipeline/diagnostic-endpoint.json --request .matchlog/0383-0156-request.json
```

```powershell
node supervisor/bin/diagnose-assignment.mjs get --endpoint .pipeline/diagnostic-endpoint.json --request-id 0383-0156-revise-01
```

Для остальных назначений используются отдельные файлы
`.matchlog/0383-0208-request.json`, `.matchlog/0383-0175-request.json`,
`.matchlog/0383-0074-request.json` и requestId `0383-0208-revise-01`,
`0383-0175-revise-01`, `0383-0074-audit-01` с полями из таблицы.
CLI печатает один JSON; отказ имеет код выхода 1. После потери ответа следует
получить результат через get, а не создавать новый requestId. После рестарта
runtime разрешение обновляется на его поколение; сохранённый результат не
пересоздаётся. Uncertain после прерванного запуска не даёт права на повтор.

## Свидетельства и передача

Успешное чтение содержит `entry`, точную строку `bytes` и её `sha256`.
Проверять следует UTF-8 байты строки `bytes`, без добавления новой строки.
Первичные сохранённые ответы находятся в `entry.launches[].run`; result.primary
содержит их JSON pointers и SHA-256 компактного JSON. Launch intent сохраняется
до запуска, run — до учёта, receipt — после него. Неизвестный расход не равен нулю.
Используется единственный pending-reports.json с обеими коллекциями;
отдельная очередь, retry envelope или право повтора исходного этапа не создаются.

Для каждого адресата сохранить UTC, исходную идентичность и контекст,
diagnostic launchId/sessionId либо доказанное отсутствие, точные команды,
structured results, receipts и доступные первичные записи с SHA-256.
Повторный get из нового клиента должен вернуть те же bytes/hash без нового
launch и расхода. Перед публикацией проверить отсутствие секретов; удалённые
данные описать, сохранив первичные источники в доступном уполномоченному
потребителю месте. Manifest перечисляет все четыре ответа, пути и хеши;
путь и SHA-256 самого manifest передаются 0383 и потребителю 0381.

Отказ helper может быть результатом проверки. Отсутствие endpoint, неподготовленное
разрешение или одни тестовые фикстуры не заменяют четыре живых ответа.
Снимок v2, ремонт запуска и доказательство сохранности слияния остаются 0381.
