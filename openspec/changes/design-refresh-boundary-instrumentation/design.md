## Context

Проработка 0371 по выбранному владельцем варианту B. База после fetch/merge: `5a6c051484e035c27b462384f0359a88a517ae8d`, Already up to date. `openspec list --json` и поиск по основным/открытым спецификациям не обнаружили такого проекта. Прочитаны CLAUDE.md целиком, config.yaml, `pipeline-supervision-resilience`, контракт 0370 на `8f32288cf0010496d74e920ea663a673cd62a51f` и переданная опись хозяина. Геймплей не затронут.

Проверенный файл описи: `C:/src/dezintegra/TD_Game/.claude/worktrees/0370-poluchit-razlichayuschie-svidetelstva-re/.matchlog/0370-refresh/host-static-inventory-20260923T2034Z.md`; SHA-256 `A594F13E5E23F557A0B82373C2DB86F12B0F1829E8679D1AF8EADBDCEB405315`; время наблюдений 2026-09-23 20:28–20:34 UTC. Прочитан и хеш проверен 23.09.2026; повторной описи и записи в дерево 0370 не было.

Опись на Windows 11 Pro 10.0.26200 называет закреплённый `.pipeline/codex-runtime/0.153.4/codex.exe`, SHA-256 `E5AA76D19C7C94E2E9EF9B707D590206A73AC0E97C8DDC8382181242494BEF75`, и соседний `codex-windows-sandbox-setup.exe`, SHA-256 `954045C272D0FDF475C2A04C014E50D1E1BCE0FCDA209EA0EB974FD064DBB736`. Это исторически проверенные файлы описи, не новое наблюдение их запуска. Helper назван кандидатом. Проверенный ранее CLI 0.155.1 не подменяет pinned runtime.

Вариант A уже отвергнут: проверенные event schemas не несут call/refresh ID и снимка effective token у ACL API. Увеличение окна или нулевые потери доставки этого не добавляют. Асинхронный запрос к уже завершившемуся/сменившему контекст потоку не доказывает токен операции. Выбор A/B повторно не запрашивается.

## Goals / Non-Goals

Результат — аудируемый проект конкретного поставщика данных: карта исходников, происхождение, причинные ключи, API/token semantics, правила записи, отрицательные проверки и граница последующего допуска. Текущая карточка доставляет документацию; реализация upstream-патча, сборка, подмена runtime и живой опыт требуют последующего отдельного разрешения по этому проекту. Их нет в исполняемых пунктах tasks.md.

Не создаём второй collector или механизм инцидентов. Ограничения proposal обязательны. Ничего в sim/shared/ai, игровом протоколе или UI не меняется; рассинхрон/реконнект, PROTOCOL_VERSION и golden не требуют изменений. Date/Math.random/float в состоянии sim не появляются.

## Decisions

### 1. Закреплённый источник и честные уровни происхождения

База будущего патча — официальный `openai/codex`, tag `rust-v0.153.4`, annotated object `042fb41b7c813ac7999105e886b2b7aa715b5081`, commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` (из проверенной описи). Ниже исходники повторно прочитаны через GitHub contents API с этим immutable ref. Полный upstream checkout не создавался. Строка версии не доказывает соответствие установленного бинарника исходникам.

| Граница | Закреплённый исходник / наблюдение | Требуемая будущая правка |
| --- | --- | --- |
| Tool invocation | [exec_command.rs](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs), `call_id`, `event_call_id`; [runtime](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/tools/runtimes/unified_exec.rs), `run(..., ctx: &ToolCtx)` | Явно перенести контекст конкретного leaf tool call, включая вложенный code-mode вызов, через все параметры до локального Windows backend. Не использовать только внешний batch ID |
| Async → blocking | [elevated.rs](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/windows-sandbox-rs/src/unified_exec/backends/elevated.rs), `RunnerTransportRequest`, `spawn_blocking`, callback refresh | Клонировать immutable diagnostic context в closure и запрос; thread-local родителя не считается переносом |
| Refresh и объединение | [setup.rs](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/windows-sandbox-rs/src/setup.rs), `run_setup_refresh_inner`, `run_setup_singleflight`, `run_setup_refresh_payload` | ID операции хранить в SetupFlight; записывать leader/join, spawn и result. Не добавлять ID в исходный ключ singleflight (сейчас сериализованный payload), иначе изменится объединение |
| Helper resolution | `setup.rs`, `find_setup_exe` и [helper_materialization.rs](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/windows-sandbox-rs/src/helper_materialization.rs) | Зафиксировать результат существующего resolver, включая fallback по имени; не заменять выбор соседним путём. Сохранить child process handle через spawn + wait вместо status для проверки идентичности |
| Helper entry и дочерняя работа | [setup_main/win.rs](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/windows-sandbox-rs/src/bin/setup_main/win.rs), `spawn_read_acl_helper`, `scope.spawn`, `ensure_allow_write_aces` | Передать контекст отдельному ReadAclsOnly helper и каждому рабочему потоку; отдельные helperInstanceId и parent edge. Основной helper может закончиться раньше дочернего |
| ACL API | [acl.rs](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/windows-sandbox-rs/src/acl.rs), вызовы `SetNamedSecurityInfoW` (в прочитанной ревизии строки 428, 561, 664, 737) | Обёртка непосредственно каждого доступного refresh ACL site, включая ошибки и cleanup/revoke; структурные before/result. Также инвентаризировать достижимые SetSecurityInfo и другие ACL sites перед реализацией, чтобы покрытие не свелось к одной строке ошибки |

Это карта мест расширения, не утверждение, что такие параметры/события уже существуют. Непокрытый путь должен дать `coverage-incomplete`, а не правдоподобный синтетический refresh. Remote executor и иные маршруты вне проверенного локального backend не принимаются этим источником.

Для будущей сборки manifest обязан назвать upstream commit, хеш патча, lockfile/toolchain/target/features, build recipe и артефакт сборки, SHA-256 CLI и каждого helper, версии схемы и coverage map. Проверяется связь артефактов с доверенным build receipt; подпись/версия/имя сами по себе недостаточны. Если воспроизводимость не доказана, так и назвать: instrumented build from pinned source, stock source equivalence unproven.

Перед разрешённым опытом хозяин читает точные файлы, realpath/file ID и хеши из существующего разрешённого контекста. После spawn родитель держит process handle и читает PID, GetProcessTimes creation FILETIME, QueryFullProcessImageNameW; helper сообщает собственные PID/creationTime/buildId. Сопоставляются manifest, resolver result и обе стороны handshake. Несовпадение либо отказ чтения исключают provenanceComplete. Проверить file ID/hash до/после; обнаруженная замена файла исключает вывод о байтах образа. Даже совпадение дискового хеша не доказывает отсутствие внешнего вмешательства в память — injection/debugger в стенде запрещены.

Сейчас не утверждаем, что helper фактически выбран или что новая сборка существует. Отвергнуты PATH-версия вместо pinned runtime, автопереход на 0.155.1, подмена штатного helper ради удобства и недоказанная эквивалентность stock/instrumented.

### 2. Причинный граф, а не временное совпадение

Будущая схема `refresh-boundary/v1` использует collectionId/launchId существующего collector 0370. CLI записывает mapping реального provider session/tool invocation к внутреннему opaque callId; произвольный вывод модели не источник mapping. ID ограничены длиной и алфавитом, не кодируют команду, путь или payload.

Внутри одного launch `callId` различает leaf calls, `attemptId` — повторы backend, `refreshId` — реальное выполнение refresh, `helperInstanceId` — конкретный spawn, `aclOpId` — конкретный API site/вызов. Refresh имеет одного leader и ноль или больше явно записанных joiner edges. Повтор после завершения singleflight получает новый refreshId. `no-refresh`/`joined-refresh` — явные исходы; helper не выдумывается для каждого вызова.

Контекст передаётся аргументами по цепи запросов, затем ограниченным диагностическим envelope отдельно от штатного payload. Envelope не участвует в ключе singleflight. Для ReadAclsOnly передаётся тот же refreshId и новый helperInstanceId с родителем. Никаких глобальных «последний call» или ambient thread-local через async/thread boundary. Связь collector invocation → CLI leaf call тоже записывается явно до dispatch, иначе incomplete.

Записи `helper-spawn`, `helper-begin/end`, `thread-begin/end`, `acl-before/result` строят проверяемый граф. Идентичность процесса — host + PID + creation FILETIME + helperInstanceId; потока — эта идентичность процесса + TID + thread creation FILETIME + threadInstanceId. FILETIME и счётчики хранятся десятичными строками без потери 64-битной точности. threadInstanceId назначается один раз при входе instrumented worker. ACL before/result одной операции обязаны совпадать по потоку, targetRef и контексту.

UTC служит ссылкой для человека; порядок — per-writer sequence и явные parent edges, плюс QPC ticks/frequency для интервалов на одном хозяине. Между процессами нельзя выводить причинность из сортировки UTC. Потеря joiner/spawn/terminal record оставляет graph incomplete. Нулевое число ACL-вызовов допустимо только с явным branch/no-op record и полным coverage; это не свидетельство токена несуществующего вызова.

### 3. Effective token непосредственно у системной границы

Наблюдение выполняется внутри того же native thread, после штатной подготовки аргументов и непосредственно вокруг ACL API, без await, callback или переключения impersonation самим прибором. Это user-mode boundary observation, не атомарный kernel security trace.

План API: GetCurrentProcessId/GetCurrentThreadId, GetProcessTimes/GetThreadTimes; `OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, FALSE, ...)`. Только документированное `ERROR_NO_TOKEN` разрешает `OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, ...)`. Access denied, anonymous token и прочие ошибки НЕ означают отсутствие impersonation. OpenAsSelf фиксирован FALSE; нет повторного запроса с более сильным контекстом, AdjustTokenPrivileges, SetThreadToken, RevertToSelf или TOKEN_DUPLICATE. Все handles закрываются. При невозможности запросить нужные поля — точные API/error/time и incomplete.

С выбранного token handle GetTokenInformation читает allowlist: TokenStatistics (TokenId, AuthenticationId, ModifiedId, TokenType), TokenUser, TokenGroups с attributes (включая deny-only), TokenRestrictedSids, TokenPrivileges с attributes, TokenIntegrityLevel, TokenElevationType/TokenElevation, TokenImpersonationLevel только для impersonation, TokenIsAppContainer и при применимости TokenAppContainerSid/TokenCapabilities. TokenSource не запрашивается, поскольку требует другого права. Не читать пароли, credentials, full environment или secret stores. SID сохраняются как необходимые security identifiers без разрешения в имена учётных записей; данные не отправляются в телеметрию.

Снимок содержит `selection=thread|process-after-no-token`, ошибки выбора, token identity и все успешные поля. Нельзя подставить токен хозяина, CLI или PowerShell. Повторный выбор effective token и проверка TokenId/ModifiedId после API обнаруживают изменения; чтение большого снимка обрамляется проверкой ModifiedId, чтобы не принять смесь состояний. При несовпадении before/after запись `token-unstable`. Отсутствие несовпадения не доказывает невозможность краткой сторонней смены токена. Перед разрешением приёмки нужен статический обзор закреплённого helper на сторонние token-mutators/impersonation и явно ограниченный стенд без такого вмешательства. Если стабильность контекста нельзя обосновать, наблюдение не засчитывается как token-at-call; после аудита требуется более сильный источник, а не ослабление 0370.

`SetNamedSecurityInfoW` возвращает DWORD: сохраняем именно его сразу после вызова до иных API, не GetLastError вместо него. Запись содержит apiName, sourceSite, SE_OBJECT_TYPE, SECURITY_INFORMATION, targetRef, хеш требуемой DACL и ссылки на before/after owner/DACL с сохранением порядка ACE. Target связывается с разрешённым collector target по realpath, volume/file ID и reparse evidence; raw path за пределами allowlist не пишется. Изменение target identity или неизвестный descriptor даёт incomplete/непригодное сравнение. Запрос READ_CONTROL/attributes может отказать — права не расширяются. Read-only оценка WRITE_DAC остаётся задачей observer 0370; этот источник не заменяет её проверкой «есть одна allow ACE» или пробной записью ACL.

Чтение token/context и запись журналов добавляют задержку. Сохраняются интервалы token-query, ACL call и emission. Это позволяет описать overhead, но не доказывает timing штатного бинарника. Две сессии будущего контроля должны использовать одну и ту же instrumented сборку.

Документальные основания: [OpenThreadToken](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openthreadtoken), [GetTokenInformation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation), [TOKEN_STATISTICS](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_statistics), [GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes), [SetNamedSecurityInfoW](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setnamedsecurityinfow). Страницы прочитаны 23.09.2026; доступность API по документации не доказывает успешный запрос под фактическим token.

### 4. Запись, потери и пределы

Минимальный транспорт — отдельный диагностический канал существующего collector, не stdout команды/модели и не общий sandbox log. Хозяин до launch резервирует уникальный bundle и канал. Предлагается anonymous pipe с ограниченным наследованием write handle только нужному child через Windows handle list; в child передаются числовой handle и opaque IDs, не секреты или права. Для дочернего ReadAclsOnly — отдельный writer/handshake и явная parent edge. Нельзя наследовать произвольные handles или менять ACL каталога ради канала. Невозможность создать канал в текущих правах — not-run до пробы. Нативная реализация передачи handles подлежит отдельной проверке; здесь её нет.

Фрейм: length + schemaVersion + writerId + seq + kind + bounded allowlist body + checksum. Поля общих записей: collectionId, launchId, monotonic ticks/frequency, UTC, IDs графа, status и structured error. Неизвестные поля не попадают в output; полные argv/payload, логины и произвольный exception text запрещены. Максимум фрейма 256 КиБ; превышение обязательным token/ACL snapshot — incomplete, не усечение с успешной полнотой.

Collector дописывает очищенные primary records в append-only journal, подтверждая durable flush перед первой tool-командой и после критических границ. Checksum ловит повреждение; SHA-256/seal фиксирует байты, но не заменяет происхождение writer. В instrumented helper перед ACL в bounded memory готовится before record, после сохраняются direct result и after snapshot; нет блокирующего дискового flush между последним token snapshot и ACL call. До первого ACL сохраняется operation-intent с aclOpId, поэтому crash до before/result оставляет незакрытый intent. Не считать intent фактом совершённого API.

В процессе — ограниченная очередь 1 МиБ и sequence, выдаваемый до попытки enqueue. При overflow/write failure выставляется sticky incomplete; writer не делает неограниченные повторы. Collector проверяет начальный handshake, непрерывность seq, checksum, число записей и terminal seal каждого зарегистрированного writer. Разрыв в конце, отсутствие writer или seal, оборванный фрейм, timeout ожидания дочернего helper — incomplete даже при нуле reported drops. Максимальный целый префикс сохраняется; complete не восстанавливается перезапуском/дополнением задним числом.

Сохраняются лимиты 0370: не более двух сессий, четырёх отдельных вызовов на сессию (всего восемь), двух минут на сессию и десяти минут на всё окно вместе с подготовкой и flush. Дополнительный предел проекта: 10 МиБ совокупных очищенных записей, включая 64 КиБ резерва под terminal diagnostics; admission следующего фрейма проверяет оставшийся объём. Это предел предлагаемой приёмки, не разрешение запуска.

Первая потеря корреляции, обязательного token field, ошибка записи или предел времени/объёма запрещает новые diagnostic tool invocations; существующий collector отменяет только собственные пробы по маршруту 0370, ждёт выхода/flush и сохраняет partial. При недоказанном завершении — unresolved, не успешный release. Наблюдатель не прекращает произвольно чужой helper/супервизор и не меняет return code уже выполненного ACL API. Запись не лечится изменением прав. Если закрывающая запись тоже потеряна, отсутствие seal само доказывает неполноту.

Отвергнуты общий файл без writer sequence, буфер только в памяти до exit, сбор полного debug log с очисткой потом, неограниченный IPC и retry. Общесистемный ETW дополнительно не нужен для выбранной explicit causal chain.

### 5. Отрицательные проверки будущей реализации

Сейчас это тестовый проект, без запуска. Проверять нужно производственные serializer/decoder и реальные точки расширения с подменой только ОС/IPC, а не генератор заведомо идеальных событий. Каждый контроль начинает с пригодной синтетической последовательности, портит один факт и ожидает конкретный incomplete reason. Синтетика никогда не помечается host evidence.

| Контроль | Ожидаемый отказ/результат |
| --- | --- |
| Stock CLI/helper, чужой hash/build receipt, другой selected path, замена image между наблюдениями | provenance-incomplete, запрет допуска |
| Нет leaf-call mapping; совпало только время/parent PID; refreshId повторно использован | correlation-incomplete |
| Два call join одного flight; новый flight после конца | Одна операция и две явные edges; следующая операция имеет новый ID; удалённая edge обнаруживается |
| Context потерян в spawn_blocking, worker или дочернем ReadAclsOnly | coverage/correlation-incomplete, не подстановка ID родителя |
| Повтор PID или TID с другой creationTime; before/result разных потоков | identity-mismatch |
| OpenThreadToken denied при доступном primary token | token-unavailable, fallback не вызывается; ERROR_NO_TOKEN отдельно разрешает process token |
| Изменён TokenId/ModifiedId, обязательное поле недоступно, снимок нестабилен | token-unstable/unavailable |
| DWORD ACL API = 5, GetLastError затем изменён | В записи сохраняется 5; код наблюдателя не подменяет результат |
| Удалены середина, первый/последний record, seal, child writer; duplicate seq; truncated frame; неизвестная версия | integrity/completeness false, сохранён читаемый префикс |
| Недоступный sink, overflow, timeout, >10 МиБ, ошибка flush | Нет следующего tool call; partial; отсутствует успешный seal и бесконечный retry |
| Secret-canary в argv/payload/error/лишнем поле | Canary отсутствует во всех serialized bytes; произвольный текст не читается для логирования |
| Target realpath/file ID/DACL drift; незарегистрированный ACL site | target/coverage-incomplete, сравнение не засчитано |
| Только успешный command result или valid JSON без syscall evidence | Нельзя заявить token-at-call, источник принят или причинный ремонт |

Дополнительно source-coverage review перечисляет каждый путь от реального ToolCtx до API, ветви без refresh и все дочерние процессы. Мутационный контроль удаляет передачу контекста на одной реальной границе: соответствующая проверка обязана упасть. Для IPC — crash writer до первого события и после ACL result, неработающий consumer, конкурирующие writers, истечение deadline; для токена — подмена только Windows API boundary. Проверки не запускают настоящий setup и не меняют ACL.

Когда будет разрешена реализация, нужно отдельно закрепить upstream harness/Windows target и конкретные тестовые команды по тому checkout. Сейчас Cargo checkout и патча нет; выдумывать запускаемую Cargo-команду и выдавать её за проверку нельзя. Интеграционные проверки 0370 используют `pnpm install --frozen-lockfile --prefer-offline`, затем поддерживаемый `pnpm test:pipeline` с его конкретными файлами `refresh-evidence.test.mjs`, `windows-refresh-observer.test.mjs`, `refresh-diagnostics-contract.test.mjs`, когда они существуют в её ветке. Это последующая работа 0370, не пункты этой карточки. Полный verify, игровой build, матчевые тесты и арена не требуются.

### 6. Передача без ложного разблокирования

После отдельного аудита implement этой карточки только оформляет документальную поставку и PR, сверяет источник и прикладывает таблицу «доказано / спроектировано / ещё не проверено». В ней нельзя писать `sourceAvailable=true`. Это не адресная правка дельты 0370 и не завершение её открытых задач.

Последующие допуски последовательны; аудит проекта не разрешает автоматически ни один из них:

1. **Поручение на разработку, сборку и проверки без активации.** Основание — отправленный проект с точным SHA и принятый отдельный аудит. Поручение явно задаёт разрешённый объём подготовки патча, сборки и отрицательных проверок раздела 5 на подменённых ОС/IPC-границах, без настоящего setup и изменения ACL. Точный патч, build manifest/receipt, source-coverage review и результаты этих проверок — результаты порученной разработки, а не условия получения такого поручения. Этот допуск не разрешает подмену рабочего runtime, запрос живого токена или запуск эксперимента.
2. **Допуск к активации и живому опыту.** Рассматривается отдельно после разработки: нужны точный патч, build manifest и подтверждённое происхождение сборки по build receipt, source-coverage review, результаты отрицательных проверок и текущие полномочия Windows-хозяина. Явное поручение закрепляет конкретную сборку, разрешённую активацию, границы опыта и лимиты 0370. Проверка фактически выбранного helper и его process identity выполняется в разрешённом окне до принятия свидетельств; несовпадение или недоступность сохраняют incomplete, а не разрешают обход.

Такой порядок устраняет цикл «разрешение на разработку требует результатов ещё не разрешённой разработки». Вариант единого допуска отвергнут: он либо создаёт этот цикл, либо позволяет ошибочно принять разрешение на сборку за разрешение живого опыта. Текущая карточка остаётся документальной и не исполняет ни один из двух допусков. Реализацию поставщика следует явно поручить до продолжения зависимых live acceptance; не создавать в этом design обратную зависимость на 0370 и не запускать её collector самостоятельно.

При последующем разрешённом использовании существующий 0370 collector остаётся единственным владельцем launch/budget/ledger/lock. Он проверяет provenance, декодирует новый поток через свой observer и сохраняет три независимых вердикта integrity/completeness/causalSufficiency. Источник B не меняет budget gate, ownership transfer и incident admission. Live primary evidence по-прежнему сохраняется новым файлом в `.matchlog/0370-refresh/` дерева 0370 штатным хозяином: абсолютный путь, SHA-256, UTC и ссылки на первичные записи. Это будущее внешнее действие; текущая проработка туда не пишет.

## Risks / Trade-offs

- Даже inline token query не атомарен с kernel access check → контекст и ограничения фиксируются; неизвестная конкурентная смена не допускает token-at-call. Прибор не обещает доказательство против произвольного вмешательства.
- Передача diagnostic context может случайно изменить singleflight/payload → отдельный envelope и контроль неизменности штатного ключа; не сериализовать ID в permissions payload.
- Дочерний ReadAclsOnly может пережить родителя → отдельный writer, ограниченный drain и незакрытая ветвь как incomplete; не менять lifecycle helper ради наблюдаемости.
- Instrumented binary/timing отличаются от stock → scope вывода явно ограничен новой сборкой; успех не ремонтирует исторический отказ 0011.
- Доступ к transient token и transport не доказан → отрицательный результат допустим как остановка допуска, не как выполненная предпосылка 0370.

## Migration Plan

Сейчас поставка только документов, без миграции данных и runtime. Откат документального PR не трогает логи/инциденты. Будущая схема опциональна и явно версионирована; legacy stdout/helper log не повышаются до v1. Патч и эксперимент не включаются автоматически после merge. Включение только отдельным согласованным назначением; обратный переход прекращает будущий сбор и сохраняет уже полученные материалы, штатные бинарники не перезаписываются этим изменением.

## Open Questions

Повторного продуктового выбора A/B нет. Непроверенные факты будущей приёмки: соответствие stock binary исходникам, build provenance нового патча, фактически выбранный image и TOKEN_QUERY в момент операции. Единственный источник разрешения технических вопросов о коде B — указанный immutable upstream tree; способ получения без нарушения ограничений — read-only GitHub contents/tree API по SHA, без build/exec. Именно так составлена карта выше. Фактический transient token по статическим данным получить нельзя; его получение относится к будущему отдельно разрешённому опыту.

Официальная [Windows sandbox documentation](https://learn.chatgpt.com/docs/windows/windows-sandbox) прочитана как контекст, но не устанавливает причинный механизм или пригодность token-query на данном хозяине. Ошибочные исходные URL `bin/setup_main.rs` и `accctrl/...SetNamedSecurityInfoW` исправлены по дереву/документации; это ошибки адреса, не отказы разрешений. Git сообщил Permission denied для пользовательского ignore; команды завершились успешно, обхода не было.
