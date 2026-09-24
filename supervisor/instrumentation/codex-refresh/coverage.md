# Coverage: подготовка, не инструментированный источник

Статус: **partial-source; runtime-coverage-unimplemented**.

Проверена доставка исходных bytes Codex 0.153.4 по source-manifest/receipts/source.json.
Проверки prepare.test.mjs (16) охватывают закреплённые идентификаторы,
ограничения Windows-путей, повреждение/пропуск/лишние файлы архива,
PAX path traversal, checksum/truncation и reparse/escape на файловой границе.
Эти тесты не являются отрицательными проверками Windows/IPC instrumentation.

| Требуемая производственная граница                                | Состояние                                                                                                                         |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| leaf call → ToolCtx → request → elevated/spawn_blocking           | Не инструментирована, mutation controls отсутствуют                                                                               |
| SetupFlight leader/joiner/refresh identity                        | Ядро instrumented и проверено на fake spawn; production context ещё не подведён                                                   |
| helper resolver/image/child handshake                             | Не инструментирована, выбранный image не наблюдался                                                                               |
| ReadAclsOnly и scope.spawn/thread lifetime                        | Не инструментированы                                                                                                              |
| acl.rs и setup_main/win.rs: SetNamedSecurityInfoW/SetSecurityInfo | Патч отсутствует, достижимость всех ветвей не проверена                                                                           |
| effective token и mutators                                        | Native token adapter компилируется; fake API tests проверяют выбор и стабильность; ACL wrapper и mutator review отсутствуют       |
| writer/pipe/seq/seal/loss и Node reader                           | Node: 30 synthetic controls; Rust writer: 9 wire tests и cargo check, receipts/wire.json; pipe и причинная приёмка не реализованы |
| build/reproduce/package/delivery                                  | Не выполнены                                                                                                                      |

Статический обзор шести upstream build.rs описан в README и source receipt.
Он устанавливает отсутствие setup launch в этих файлах, но не полноту
call graph, не безопасность транзитивных build scripts и не source availability.
`release-lock.patch` и его receipt подтверждают только подготовку согласованного
lockfile; refresh-boundary.patch покрывает wire writer и ядро singleflight. Поиск дополнительно
выявил SetSecurityInfo в `windows-sandbox-rs/src/desktop.rs:420` на закреплённом
SHA: достижимость и контроль этой ветви ещё предстоит установить. Отсутствие
её в первоначальном перечне не разрешает считать покрытие полным.

Повтор 2026-09-24 выявил старую редакцию patch при более новом тестируемом source.
Patch пересоздан, manifest согласован; driver теперь требует обратное применение
patch к проверяемым исходникам до Cargo. Исторический прогон после этой правки относился к hash
`8aebbad888d9a47cb9b31cf87ad2191131250c0c8d98dc7af8f9069fc1046672`.
Актуальный hash каждого прогона указан в соответствующем receipt. Эти проверки
не подтверждают сборку из чистого экспорта или производственные Windows/IPC sites.

Шаг singleflight от 2026-09-24: `receipts/singleflight.json` связывает текущий
patch с cargo check, тремя перечисленными Rust tests, семью принятыми reader
frames и двумя отрицательными mutation controls. Два конкурентных вызова
используют один fake spawn и разные call/attempt IDs; следующий flight получает
новый refreshId. Потеря join edge и обход coalescing обнаруживаются тестом.
После мутаций исходник восстановлен и обычная проверка повторена. Первый
mutation-run выявил зависание самого теста при потере edge; исправленный тест
освобождает fake leader до проверки timeout. Этот первый run не принят как успех.
Диагностическая ошибка не меняет штатный результат setup. Это ещё не закрывает
3.3: production callers передают `None`, no-op и передача контекста остаются
незавершёнными. `sourceAvailable=false`; token/ACL/setup не запускались.

Локальный `pnpm test:pipeline` этого шага: 3180 passed, 4 failed в
stage-tool-recovery, dependency-delivery и watch-lifetime. Собственные build,
reader, prepare и release-lock tests проходят; независимость четырёх падений
от ветки пока не доказана. Полный набор не объявляется успешным.

Token increment: allowlisted native `GetTokenInformation` queries используют
ограниченные выровненные buffers с проверкой всех pointer/count ranges. Handles
удерживаются в `Captured` до окончания наблюдения и закрываются через RAII.
`OpenThreadToken` использует только TOKEN_QUERY и OpenAsSelf FALSE; только
ERROR_NO_TOKEN разрешает process fallback. До/после чтения полей сверяются
TokenId/AuthenticationId/ModifiedId/type; повторный выбор обнаруживает смену
selection или содержимого. Native adapter исключён из test build: пять тестов
используют fake TokenApi, настоящее чтение токена не выполняется.
`receipts/token.json` фиксирует cargo check native adapter, тесты и мутации
fallback-on-denied/ignore-snapshot-change. Это не закрывает 4.2: wrapper у ACL,
прямой DWORD, интервалы и сериализация snapshot ещё не интегрированы.

Повтор общей проверки до token increment: 3182 passed, 2 failed — EPERM rename
в tool-settlement и прежний watch-lifetime timeout. CI main на
`e59fc16b66894a3f900003aa495d5ea07b507e0a` успешен; нестабильные локальные
результаты не выданы за доказанную поломку main или препятствие разработке.

Проверка token increment: 3180 passed, 4 failed — stage-tool-recovery (2),
tool-retry и watch-lifetime. Два отказа содержат EPERM rename тестового
pending.json; собственные build/reader/prepare/release-lock проверки прошли.

Carrier increment: `SandboxSetupRequest.diagnostic` явно доходит до
`run_setup_refresh_inner_using` → `run_setup_singleflight_observed` → runner.
Новый Rust test `refresh_boundary_singleflight_setup_request_preserves_payload`
исполняет реальную подготовку payload с fake runner: b64 одинаков с context
и без него, opaque callId не попадает в payload, runner получает тот же context
и refreshId, исходная ошибка сохраняется. Test build подставляет synthetic user
и запрещает штатный helper runner вместо случайного запуска setup.
Мутации потери carrier на входе flight и runner обнаружены. Актуальный
singleflight receipt включает эти контроли и исторические контроли ядра
с их собственным patch hash; они не выдаются за повтор на новой ревизии.
Identity/elevated callers пока передают None. Переход к native helper помечает
context incomplete до появления проверенного IPC; 3.2/3.3 остаются открытыми.

Проверка carrier increment: 3179 passed, 5 failed — report-delivery,
report-recovery, stage-tool-recovery (2), watch-lifetime. Собственные проверки
прошли; EPERM rename и timeout сохраняются без изменения соседнего кода.

Мутационные проверки перенесены в `build.mjs`: фиксированные группы
singleflight/carrier/token, точный harness filter `--exact`, обязательные
baseline и restored check. Driver сохраняет flushed backup по исходному hash,
не перезаписывает неожиданную стороннюю правку, отличает assertion failure
от compilation/timeout и фиксирует собственный SHA-256 в receipt. Десять новых
fake-boundary tests проверяют восстановление, неподходящее падение, утечку
текста исключения, stale source и конфликт записи. Полный build/package driver
по-прежнему не завершён.

Проверка versioned negative driver: 3191 passed, 3 failed — stage-tool-recovery,
tool-retry (EPERM rename), watch-lifetime. Все 41 tests build driver прошли.

Все три группы нового driver исполнены на patch
`ef40a1855fb846786325109f953ec15117e3873fde7c7ef9fcd62f4f8d473510`:
шесть мутаций обнаружены, после каждой исходник восстановлен, завершающие
проверки проходят. `receipts/negative.json` содержит отдельные результаты
carrier, token и singleflight с UTC и driver hash. Полнота всей инструментации
этими шестью проверками не заявляется.

Token wire increment: Rust serializer перечисляет ровно 19 полей контракта,
сохраняет 64-bit LUID строками и attributes, неприменимые поля пишет null.
Шестой token test создаёт synthetic JSON snapshot, который driver проверяет
производственным Node `validateBoundaryToken`: типы/allowlist, согласованность
fallback, ModifiedId и применимость impersonation/AppContainer полей.
`receipts/token.json` содержит hash принятых bytes и шесть tests. Это проверка
формата и стабильности отдельного снимка; provenance и token-at-call не приняты.

Проверка token wire increment: 3198 passed, 5 failed — report-recovery,
stage-tool-recovery, tool-report-hold (2), watch-lifetime. Новые token checks
прошли; общий набор остаётся красным, включая EPERM rename тестового хранилища.

Token error increment: локальная ошибка разбора представлена `Malformed`,
отдельно от `Windows { api, code }`; код Windows для неё не выдумывается.
Malformed и denied не разрешают process fallback. Шесть native tests и две
мутации проходят на patch `37b14e42150d0d72ce0dfc20352230aa2eeccd3db5d77f103262bfba9bcf5938`;
receipt token сохраняет baseline, controls и restored check. Pipeline: 3198 passed,
5 failed — report-delivery, stage-tool-recovery (2), tool-retry (EPERM rename),
watch-lifetime. Build driver (41) и reader (39) прошли; общий набор не зелёный.

ACL call boundary increment: `around_acl` удерживает выбранный token handle
через единственный синхронный вызов, сохраняет его DWORD и повторно выбирает
effective token. Ошибка наблюдения не подменяет штатный результат; отключённый
observer не запрашивает токен. Четыре новые fake-API проверки довели token group
до 10 tests. Четыре мутации token group обнаружены, включая подмену DWORD и
игнорирование смены token после вызова; исходник восстановлен и проверен.
Это ещё не подключение к ACL sites и не emission intent/before/result; 4.2/4.3
остаются открытыми. Pipeline: 3202 passed, 1 failed — watch-lifetime timeout.

Retry carrier increment: optional context включён в RunnerTransportRequest,
передаётся в retry callback, observed identity refresh и setup request, включая
desktop request внутри существующего spawn_blocking. Старые identity entrypoints
делегируют observed-вариантам с None; публичное поведение сохранено. Fake runner
проверяет callId/attemptId, общую sticky health и неизменные launch параметры;
новая мутация удаления retry context обнаружена. Пять singleflight-group tests
и три carrier mutations прошли. Entry в backend пока создаёт context None:
полнота dispatch/spawn_blocking пути не заявляется. Pipeline: 3199 passed,
4 failed — report-delivery, tool-retry (2, EPERM rename), watch-lifetime.

Историческая граница записи, не принятая как конечный результат, и неисполненный объём:
`openspec/changes/implement-refresh-boundary-source/technical-barrier.md`.
