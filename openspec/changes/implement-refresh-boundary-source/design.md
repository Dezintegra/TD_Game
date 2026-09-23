## Context

Назначение 0372, этап design, 2026-09-24. База после повторного `git -C . fetch origin` / `git -C . merge origin/main`: `92ecb13efa8f5d76042ace398a70b8e573d7dbee`, fast-forward, собственного merge-коммита нет. Прочитаны CLAUDE.md целиком, config.yaml, основная pipeline-supervision-resilience, открытые изменения и опись карточек. PR 286 проверен через `gh pr view`: MERGED, head `e8c688290e2236b66c41f0576e6c3d949ca3ae81`, mergedAt `2026-09-23T21:54:08Z`. Его design совпадает с принятой редакцией `f7bca391bcdb7ff459b1c440ca02c18c93ce1e31`.

Нормативный технический предшественник — [design 0371](../design-refresh-boundary-instrumentation/design.md), особенно Decisions 1–6, и [handoff](../design-refresh-boundary-instrumentation/handoff.md). Ни один пункт ниже не ослабляет их. Содержание PR 283 прочитано по `8f32288cf0010496d74e920ea663a673cd62a51f`: `refresh-evidence.mjs` уже разделяет сохранение событий и конечную приёмку; schema 1 имеет узкий allowlist. В main этого модуля пока нет. Передавать новые подробные записи через его старый `pick(event)` означало бы потерять поля; интеграцию с новым источником выполняет observer 0370 с явными primary references, а не этот PR посредством копирования collector.

Read-only GitHub contents API по upstream SHA `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` подтвердил карту 0371 и дополнительно Cargo manifests: пакет `codex-cli`, bin `codex`; пакет `codex-core`; пакет `codex-windows-sandbox`, lib `codex_windows_sandbox`, bins `codex-windows-sandbox-setup` и `codex-command-runner`. `codex-rs/rust-toolchain.toml` задаёт Rust `1.95.0`. Полный checkout, сборка и тесты на design не выполнялись.

Справка [OpenAI Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox) открыта 24.09.2026 как общий контекст; она не доказывает устройство закреплённого бинарника или доступность token-query на хозяине. Для реализации используются immutable исходники и контракт 0371, не рекомендации переключить профиль или повторить setup.

## Goals / Non-Goals

Цель — проверенная переносимая поставка источника B для 0.153.4 в сохраняющемся хранилище либо точная подтверждённая техническая преграда. Второй допуск и живые первичные факты относятся к последующему маршруту 0370 и не являются условиями завершения 0372. Исполняемый первый объём уже разрешён владельцем: получить upstream, создать патч, собрать и испытать на подменённых ОС/IPC-границах. Это последующая реализация после аудита данного изменения, а не действия текущего design.

Non-goals перечислены в proposal. Геймплей не меняется: рассинхрон/реконнект, golden и PROTOCOL_VERSION неприменимы. Код не добавляется в sim; запреты Math.random, Date.now и float в состоянии мира сохраняются. Rust-инструментация служебная и не становится зависимостью игровых пакетов.

## Decisions

### 1. Поставка патча, а не встраивание всего Codex в TD_Game

В `supervisor/instrumentation/codex-refresh/` хранятся `source-manifest.json`, `refresh-boundary.patch`, `build-recipe.json`, `prepare.mjs`, `build.mjs`, `README.md`, `coverage.md` и очищенные receipts в `receipts/`. JSON содержит реальные измеренные значения после implement, не правдоподобные placeholders. Рабочие generated source/build/test материалы до передачи находятся в собственной `.matchlog/0372-refresh/`: upstream checkout, два независимых build roots, project-local caches, negative-control outputs, packaged executables. Никакой записи в `.pipeline/codex-runtime`, дерево 0371 или дерево 0370 по первому допуску.

Upstream origin — официальный `openai/codex`, tag `rust-v0.153.4`, annotated object `042fb41b7c813ac7999105e886b2b7aa715b5081`, peeled commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`. `prepare.mjs` проверяет объект/commit и SHA-256 полученных байтов, фиксирует Git tree, исходные hashes изменяемых файлов, Cargo.lock/rust-toolchain/build.rs и применяет точный patch без fuzz. Архив распаковывается только в проверенный собственный workspace без path traversal/reparse escape. Полная опись inputs включает git-зависимости Cargo и доступные pinned dependency digests. Нельзя подменить ref на latest при сетевом отказе.

Manifest различает sourceCommit, patchSha256, recipeSha256, schemaVersion и coverageSha256. BuildId вычисляется из канонических входов, а не из хеша собственного executable: исключаем циклическое включение binary hash в него самого. Receipt отдельно связывает buildId с итоговыми executable hashes, размером, absolute path, UTC, версиями compiler/linker/SDK, target/features/profile и кодами/результатами команд. Закреплённый target этой поставки — `x86_64-pc-windows-msvc`; его совместимость с host inventory подтверждается до активации. Исходный LICENSE и условия распространения сохраняются в пакете.

Изолированная сборка не читает личные настройки Codex, не создаёт CODEX_HOME и не запускает собранный setup. Кэши Rust/Cargo и временные файлы направляются внутрь workspace через child environment build driver, без изменения пользовательского окружения. Не устанавливать системный SDK или Rust молча: при отсутствии доступного инструментария зафиксировать точную версию/ошибку и разрешённый способ получения в пределах первого допуска; неподдерживаемая установка вне дерева — отдельная техническая преграда, не повод менять права.

Два чистых build roots с одинаковыми входами должны дать одинаковые hashes CLI и всех helpers. Recipe фиксирует пути/remap и настройки воспроизводимости linker, проверенные на фактическом toolchain. Расхождение сохраняется с обоими receipts и не называется воспроизводимостью; до второго допуска оно должно быть устранено либо контракт отдельно пересмотрен. Равные новые binaries всё ещё не доказывают эквивалентность stock release. Статус поставки — instrumented build from pinned source, stock source equivalence unproven.

Альтернатива «fork/submodule всего upstream» отклонена: усложняет обычные игровые установки и не помогает происхождению конкретного артефакта. Одной скачанной готовой release-сборки недостаточно: отсутствуют необходимые probes. Бинарники не добавляются в Git. Конечное хранилище и проверка переноса заданы в решении 6; receipt только с путём внутри удаляемого дерева не принимается как поставка. Подтверждённый отказ переноса оформляется альтернативным результатом technical-barrier, а не бесконечным ожиданием 0370.

### 2. Явный контекст на каждом производственном переходе

Optional diagnostic context отсутствует по умолчанию; без него не запрашиваются дополнительные токены и не открывается диагностический канал. В диагностической сборке carrier содержит только opaque IDs, schema/build identity и ограниченную ссылку на выделенный transport. Нет глобального last-call и переноса через ambient thread-local.

| Путь upstream относительно codex-rs | Что меняется и как проверяется |
| --- | --- |
| `core/src/tools/handlers/unified_exec/exec_command.rs`, `core/src/tools/runtimes/unified_exec.rs` | Mapping реального session/tool invocation к leaf call; отдельные IDs вложенных code-mode calls, attemptId на каждую backend-попытку; событие до dispatch. Тесты вызывают производственный dispatch с fake executor, не модель. |
| Промежуточные unified_exec/request/sandboxing типы, найденные трассировкой | Carrier явным параметром до Windows backend, клон при async/blocking переходе. Список точных файлов заносится в coverage и patch manifest; потерянный carrier даёт incomplete. |
| `windows-sandbox-rs/src/unified_exec/backends/elevated.rs` | RunnerTransportRequest и spawn_blocking closure несут тот же context; альтернативные remote/непокрытые backend не объявляются наблюдаемыми. |
| `windows-sandbox-rs/src/setup.rs` | SetupFlight владеет refreshId и leader edge; joiner пишет собственную edge. Повтор после удаления flight получает новый ID. Исходный b64 key и payload не содержат diagnostic IDs. Проверяется один fake spawn при двух concurrent joiners. |
| `windows-sandbox-rs/src/helper_materialization.rs` и resolver в setup.rs | Наблюдается реальный результат find_setup_exe, включая fallback. `status` заменяется эквивалентными spawn/wait с сохранением handle; выбор executable не переписывается. |
| `windows-sandbox-rs/src/bin/setup_main/win.rs` | Новый helperInstanceId, parent edge, явный carrier для spawn_read_acl_helper и каждого scope.spawn; thread lifetime и writer lifetime самостоятельны. |
| `windows-sandbox-rs/src/acl.rs`, `setup_main/win.rs` и прочие достижимые sites | Явный aclOpId на каждую попытку API; intent/before/result, no-op и error branches. Прямой код результата сохраняется до observer calls. |

Проверенные дополнительные sites: `acl.rs:802` вызывает SetSecurityInfo для null device; `setup_main/win.rs:377` — handle-based SetSecurityInfo, `:391` — named fallback. Это не утверждение, что все они достижимы из refresh: review обязан показать call path/branch condition для включения либо доказательство недостижимости. Аналогично проверяются cleanup/revoke, initial/provision-only и ReadAclsOnly mutex skip. Ни найденное имя API, ни четыре исходные строки SetNamedSecurityInfoW сами по себе не дают полного coverage.

Идентичности: process = host + PID + creation FILETIME + helperInstanceId; thread = process + TID + thread creation FILETIME + threadInstanceId. 64-bit FILETIME/sequence/QPC хранятся строками. ACL before/result одного aclOpId обязаны совпадать по refresh/helper/thread/target. UTC — ссылка для человека, QPC — длительности на одном хозяине; порядок и причинность задаются seq/edges. Явный no-refresh/no-op требует завершённого covered branch, не просто отсутствия событий.

При активированном позднее источнике parent держит child handle и сопоставляет GetProcessTimes, QueryFullProcessImageNameW с handshake child PID/creationTime/buildId. Manifest проверяется против resolver path, realpath/file ID/hash до и после spawn. Замена файла, отказ чтения или неожиданный child не повышаются до complete. Runtime selected-image records не заполняются из build receipt: до окна это разные уровни знания.

### 3. Системная граница токена и ACL

Нативный wrapper ставится у реального API site, после штатной подготовки DACL/аргументов. Последовательность: заранее записанный operation-intent → target/before descriptor evidence → подготовка bounded before record → stable token snapshot → прямой ACL API → немедленно сохранить DWORD → повторный выбор effective token и after snapshot → emit before/result с интервалами. Между последним token query и API нет await, callback, flush или смены impersonation прибором. Intent без result не доказывает исполнение.

Выбор токена в том же thread: OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, FALSE). Только ERROR_NO_TOKEN ведёт к OpenProcessToken с TOKEN_QUERY. Access denied/anonymous/прочие ошибки остаются token-unavailable; нет OpenAsSelf TRUE, TOKEN_DUPLICATE, AdjustTokenPrivileges, SetThreadToken или RevertToSelf со стороны observer. Все handles закрываются через RAII, в том числе на ошибках. Не читается TokenSource.

Allowlist GetTokenInformation точно следует 0371: TokenStatistics (TokenId, AuthenticationId, ModifiedId, TokenType), TokenUser, TokenGroups с attributes/deny-only, TokenRestrictedSids, TokenPrivileges с attributes, TokenIntegrityLevel, TokenElevationType/TokenElevation, применимые TokenImpersonationLevel, TokenIsAppContainer, TokenAppContainerSid/TokenCapabilities. SID не разрешаются в имена. Неприменимость поля отмечается структурно и проверяется по типу; отказ обязательного поля не выдаётся за пустой список. ModifiedId проверяется до/после многополевого снимка, TokenId/ModifiedId и selection — также после API.

TargetRef разрешается только через allowlisted collector targets; сохраняются realpath, volume/file ID, reparse evidence, owner/DACL refs, ACE order, hash запрошенной DACL, SE_OBJECT_TYPE и SECURITY_INFORMATION. Для kernel-object sites coverage обязан различать тип объекта и допустимую identity, не выдавать его за файл. Недоступный target/descriptor либо drift сохраняются как incomplete; READ_CONTROL не приобретается изменением ACL. WRITE_DAC access assessment остаётся observer 0370, источник его не заменяет пробной записью или одной allow ACE.

Wrapper не меняет штатный ACL DWORD, даже если не удалось наблюдение. Ошибка наблюдения идёт отдельным sticky status, а collector прекращает следующие invocations. Успех штатного API при неизвестном токене не является token-at-call. Совпадение снимков не исключает краткую внешнюю смену: coverage review инвентаризирует token mutators/impersonation, а условия окна исключают debugger/injection и неконтролируемое вмешательство. Необоснованная стабильность оставляет causalSufficiency неизвестной; более сильный источник потребует нового аудита, а не скрытой уступки.

### 4. Wire contract и библиотека без второго collector

`refresh-boundary/v1` не равна REFRESH_SCHEMA=1 из 0370. Новые frame/writer поля сохраняются отдельными очищенными primary records, а `refresh-boundary-source.mjs` экспортирует decoder, проверку provenance/coverage/graph и структурированный status для observer. Библиотека сама не запускает модели, helper, не получает locks и не пишет общий ledger. Adapter 0370 связывает invocationId с реальным leaf mapping и прикладывает references к старому evidence bundle; этот PR поставляет контракт/fixtures без правок чужой ветки.

Канал — выделенный diagnostic pipe, не stdout/stderr модели/команды. Передача write handle только нужному child через Windows handle allowlist; payload permissions и ключ singleflight неизменны. Separate writer у каждого процесса/ReadAclsOnly child, ограниченное число writers по фактическому графу и лимиту памяти. Native spawn adapter сохраняет исходные flags, cwd, stdio и отсутствие UAC; новый процесс скрыт. При невозможности доказать ограниченное наследование не переходить на общий файл с ослабленной ACL. Сначала проверяются все spawn options и lifetime на fake Windows boundary.

Frame содержит length, schemaVersion, writerId, seq, kind, allowlisted body, checksum. IDs ограничены длиной/алфавитом; переполнение поля запрещает complete. Handshake связывает writer с ожидаемым parent/child, а end seal подтверждает count/final seq/hash. Seq назначается до enqueue, 1 МиБ queue на writer, 256 КиБ frame; суммарно 10 МиБ sanitized data, включая 64 КиБ terminal reserve. Parser проверяет длину до allocation и неизвестную версию до приёма body. Неизвестные поля не записываются; секретные данные нельзя сначала прочитать «для очистки потом».

Collector резервирует durable bundle до launch, подтверждает готовность sink до первой tool-команды и критические flush по контракту 0371. До ACL intent должен быть принят; если transport потерян, операция не становится доказанной, но прибор не меняет её штатный return code. Нет блокирующего disk flush между token snapshot и syscall. Отдельный health status передаётся adapter: sticky incomplete предотвращает следующий invocation. Недоступен и health channel — отсутствие handshake/seal/deadline само запрещает complete. Reader сохраняет maximal valid prefix; поздняя дозапись или retry не исправляют исходный sealed verdict.

Совместимость не проверяется импортом невлитого collector. Контрактные fixtures содержат primary refs и mapping для его будущего adapter; окончательная композиция с locks/budget выполняется в 0370. Её лимиты (2 сессии × 4 вызова, 2 минуты/сессию, 10 минут на окно с подготовкой/flush) не увеличиваются. Зависимость разработки от завершения 0370 не вводится; готовность её collector является техническим условием будущего окна, которое координируется после передачи исходного источника.

### 5. Проверки именно патча и воспроизводимая сборка

Первые шаги вводят отключённые модули/контракт с проходящими тестами. Следующие подключают реальные callsites атомарно с их проверками; до полного покрытия manifest явно partial. Не допускается публиковать полноценный sourceAvailable на промежуточном шаге. Тесты импортируют производственные Rust функции и Node decoder. Подмена — только Windows API, spawn/IPC, clocks и файловый sink. Test build не может вызвать настоящий setup, ACL mutator или live token query: невыставленная fake boundary прерывает тест, а не использует ОС по умолчанию.

Планируемые имена Rust tests имеют общий фильтр `refresh_boundary`; они размещаются в реальных модулях lib, helper bin и core. После checkout проверяется наличие каждого теста через harness list, затем считается фактически выполненное ненулевое число. Известные package/bin имена подтверждены Cargo manifests; тесты этого патча пока не существуют. Driver фиксирует точные команды, cwd, feature set и список тестов в receipt, чтобы зелёный пустой фильтр не прошёл.

| Группа | Отрицательный контроль / ожидаемый результат |
| --- | --- |
| Provenance | Stock/чужой buildId/hash, другой resolver path, file replacement, неизвестная версия → provenance-incomplete/admission false. |
| Dispatch/singleflight | Потерять leaf mapping или carrier на каждом реальном переходе; удалить join edge; reuse refreshId → correlation-incomplete. Контроль: один spawn на shared flight, новый ID следующего. |
| Identity/lifetime | PID/TID reuse, другой before/result thread, child после parent, crash до handshake → identity-mismatch либо incomplete; parent identity не подставляется. |
| Token/API | Denied не вызывает primary fallback; ERROR_NO_TOKEN вызывает; missing field, unstable snapshot, смена TokenId/ModifiedId → unavailable/unstable. DWORD 5 переживает изменение last error. |
| Target/coverage | Reparse/file ID/DACL drift, missing ACL site/no-op branch, неизвестный mutator → target/coverage-incomplete. |
| Delivery | Удалить first/middle/last/seal/child record, duplicate seq, corrupt checksum, truncation, unknown schema, writers concurrently → точная неполнота, читаемый prefix. |
| Storage/bounds | Sink/flush denied, crash после ACL, overflow, oversized required field, deadline/10 МиБ → sticky partial, stop signal, ноль следующего invocation в fake consumer, без бесконечного retry. |
| Privacy | Canary в argv/payload/exception/extra field → отсутствует во всех wire/primary/receipt bytes; синтетика обозначена synthetic. |
| Dormant source | Diagnostic context отсутствует → ноль дополнительных token queries/pipe opens; исходные ключ singleflight и результат API неизменны. |

Source-coverage review связывает каждый site и переход с конкретным test name. Мутационные контроли удаляют передачу carrier на производственной границе и обходят wrapper: соответствующие тесты обязаны упасть, затем неизменённый patch снова проходит. Простое изменение готовой идеальной fixture не заменяет эту проверку.

Исполняемые Cargo рецепты ниже задаются в build driver после закрепления checkout; driver запускает их с cwd `codex-rs`, Cargo/Rust caches внутри workspace, `--locked` и точным target. Эти команды не запускаются на design:

```powershell
cargo test --locked --target x86_64-pc-windows-msvc -p codex-core --lib refresh_boundary
cargo test --locked --target x86_64-pc-windows-msvc -p codex-windows-sandbox --lib refresh_boundary
cargo test --locked --target x86_64-pc-windows-msvc -p codex-windows-sandbox --bin codex-windows-sandbox-setup refresh_boundary
cargo build --locked --release --target x86_64-pc-windows-msvc -p codex-cli --bin codex
cargo build --locked --release --target x86_64-pc-windows-msvc -p codex-windows-sandbox --bins
```

Recipe проверяет все три ожидаемых executable. Перед первым build просмотр upstream build scripts обязателен: они компилируют ресурсы, не должны активировать sandbox или диагностический опыт. Полный upstream test suite не нужен. Cargo -p tests с фильтром никогда не заменяются запуском setup executable.

Для Node-части: `pnpm install --frozen-lockfile --prefer-offline`, затем `pnpm test:pipeline lib/refresh-boundary-source.test.mjs instrumentation/codex-refresh/prepare.test.mjs instrumentation/codex-refresh/build.test.mjs`. Создаваемая тонкая `.matchlog/0372-refresh/run.mjs` вызывает версионированный driver только режимами prepare/check/negative/build/reproduce/package/deliver/verify-delivery; не содержит произвольного shell eval или host activation. Это штатная покрытая форма `node .matchlog/0372-refresh/run.mjs <режим>` из stage-settings, не обход отказа Cargo или файловой границы sandbox. При реальном запрете вложенного действия исполнение останавливается с точной ошибкой; не расширять allowlist или profile ради успеха. Каждая операция выдаёт receipt; отсутствие receipt/тестов — не успех. Полный verify, игровые сборки/матчи, арена не планируются.

### 6. Передача пакета и завершение 0372 до живого окна

**Уже разрешено:** разработать патч, получить upstream, собрать кандидата и проверить fake boundaries. Основание — назначение владельца 2026-09-24 и принятый аудит 0371. Текущий design только исправляет план после аудита. Реализация не запускает настоящее setup, live token query или collector.

**Граница завершения:** 0372 передаёт проверенный переносимый пакет либо точную подтверждённую техническую преграду. После успешной передачи её implement может вернуть done с PR в обычный маршрут review/merge; завершение карточки не требует второго допуска, готовности adapter/collector 0370, активации или live-validation. Отсутствие разрешения на живое окно не является технической преградой и не вызывает question в 0372. Ожидание зависимой 0370 отвергнуто: она сама ждёт завершения 0372, и такое условие создало бы цикл даже без обратного ребра.

**Хранилище:** `C:/src/dezintegra/TD_Game/.matchlog/refresh-source-deliveries/0372/<packageSha256>/`. Это отдельный каталог свидетельств основного проекта вне всех удаляемых task worktrees, не runtime и не служебная `.pipeline`. Владельцем сохранения является штатный Windows-хозяин; каталог не удаляется при cleanup дерева 0372 и сохраняется до явного решения владельца после приёмки 0370. Отчёт с абсолютными путями и хешами передаёт супервизор обычным журналом; исполнитель не пишет в доску или чужое дерево.

**Состав:** настоящий patch; CLI `codex.exe`, helpers `codex-windows-sandbox-setup.exe` и `codex-command-runner.exe`; source manifest и закреплённая опись inputs; recipe/schema; оба build receipts; source-coverage review; negative-test и mutation-control receipts с результатами каждого контроля; reader/проверяющая оснастка и её зависимости для автономной проверки; LICENSE; handoff и описание условий будущей активации. Исходные абсолютные build paths в receipts остаются историческими. Package index отдельно сопоставляет каждому файлу относительное имя, размер и SHA-256; digest канонического индекса задаёт packageSha256 без самохеширования. Delivery receipt добавляет конечные абсолютные пути и UTC. Ссылок на единственные bytes в task workspace недостаточно.

**Исполняемый маршрут переноса:** расширить существующий build driver режимами `deliver` и `verify-delivery`, доступными через `node .matchlog/0372-refresh/run.mjs deliver --destination C:/src/dezintegra/TD_Game/.matchlog/refresh-source-deliveries/0372`. Перенос выполняет исполнитель 0372 только при разрешённой записи в этот точный каталог. Если sandbox назначенного этапа этого не разрешает, он не вызывает эскалацию и не пытается писать через Git, иной процесс или другое хранилище: сохраняет точное ограничение как technical-barrier. Разрешённый внешний исполнитель переноса — штатный Windows-хозяин с обычным доступом к указанному каталогу, по уже данному поручению передать пакет; он может выполнить ту же команду без запуска Codex/helper. Его работа не требует запуска или разблокирования collector 0370. Автономная сессия не запускает сама процесс вне своей границы доступа.

Driver до записи проверяет realpath всех существующих родителей, отсутствие reparse/symlink escape, нахождение назначения вне task worktrees и отсутствие перезаписи чужого пакета. Копирует только файлы package index в новый staging-каталог под целевым корнем, проверяет запись/flush, повторно открывает конечные файлы, сверяет размер и SHA-256, затем публикует каталог по digest без перезаписи. Идентичный повтор допустим лишь после проверки всех имеющихся bytes; конфликт, усечённая копия, недоступность или flush failure — transfer-incomplete. Выбор другого пути, изменение ACL или повышение прав ради успеха запрещены.

**Независимое подтверждение:** отдельный вызов `node .matchlog/0372-refresh/run.mjs verify-delivery --destination C:/src/dezintegra/TD_Game/.matchlog/refresh-source-deliveries/0372 --index .matchlog/0372-refresh/package-index.json` запускает новый процесс проверки, не доверяет успеху copy и использует исходный index только как ожидаемую опись. Все проверяемые bytes читаются из конечного хранилища, без fallback в исходный workspace. Проверка требует полный состав, совпадение hashes/размеров и возможность проверки пакета без checkout/caches 0372; конечные артефакты не должны быть ссылками на дерево 0372. Receipt содержит packageSha256, UTC копирования и независимой проверки, абсолютные конечные пути, SHA-256 каждого файла и результат доступности под указанным контекстом хозяина. Проверка не исполняет доставленные CLI/helpers. В fake-fs контролях исходный workspace после copy становится недоступен: verify остаётся успешным только при самостоятельной полной копии.

Package на шаге 5.2 включает подготовленные driver документы передачи и условий активации без заявления о состоявшемся переносе. После переноса финальный handoff и очищенная копия delivery receipt фиксируются в PR на шаге 6.2, ссылаясь на неизменный package index; они не переписывают уже хешированные bytes и не входят в собственный packageSha256. Ответственный за перенос и проверку — исполнитель 0372 в разрешённой области либо штатный Windows-хозяин; получение receipt от хозяина не считается доказательством без сверки конечных файлов доступным read-only маршрутом. Успешная поставка имеет статус `package-delivered; live-unproven`.

**Альтернативный результат:** при реально установленной невозможности получения source/toolchain, сборки, проверок или переноса сохранить `technical-barrier.md` в отправленном PR. Указать attempted boundary, точный API/command/error либо запрещающий пункт профиля, UTC, доступные receipt hashes, отсутствующие части пакета, конечный путь, влияние на пригодность и доступный следующий способ с ответственным. Не отмечать невыполненные пункты как сделанные: при подтверждённой преграде согласовать tasks с этим предусмотренным назначением конечным результатом, явно указав, что не выполнено и почему. Такой результат допускает завершение 0372 по альтернативному критерию, но не утверждает доставку пакета или снятие блокировки/инцидента 0370/0366; дальнейший анализ принадлежит 0370. Недостаток ещё не выполненной доступной работы не является преградой.

**Дальнейшая ответственность 0370:** после завершения 0372 её владелец сверяет финальный diff 0371/PR 286 и package hashes, готовность observer/collector, бюджет/ledger/locks и контекст Windows-хозяина. Затем предъявляет конкретную сборку для отдельного второго допуска; `activation-request.md` в пакете — вход для этого решения, не уже выданное разрешение и не вопрос, удерживающий 0372. Только её collector активирует одобренный buildId в ограниченном окне, проверяет фактический resolver/image/process-handshake и token-at-call, связывает первичные записи с read/Git outcomes. Полномочия, лимиты, остановка при loss и возврат runtime остаются по 0370/0371. Live records, их hashes/UTC и раздельные integrity/completeness/causalSufficiency — результат 0370; добавлять их обязательными tasks/live-validation этого изменения нельзя. Успех сборки, передачи или команды не доказывает ремонт.

## Risks / Trade-offs

### Уточнение подготовки после фактического Cargo preflight

В revise 2026-09-23 23:30:29 UTC закреплённый Rust/Cargo 1.95.0 выполнил
`cargo check --locked --target x86_64-pc-windows-msvc -p codex-windows-sandbox --lib`
и завершился 101 до компиляции: Cargo требует обновления lockfile.
Исходный Cargo.toml задаёт workspace version 0.153.4, Cargo.lock содержит
codex-core и codex-windows-sandbox версии 0.0.0. Это пробел рецепта подготовки,
а не доказанная невозможность сборки или разрешение обновить зависимости.

Гипотеза: требуется только согласование версий внутренних workspace-пакетов.
Разрешён один offline resolution посредством `cargo update --offline --workspace`
под Rust 1.95.0 через локальный driver `.matchlog/0372-refresh/check-lock.mjs`.
Driver сохраняет исходный lock и результат отдельно внутри той же рабочей
области и восстанавливает исходный lock после команды. Лимит — 60 секунд,
без компиляции или запуска runtime. До включения результата в точный патч
сравнить все package source/version/checksum и зависимости: допустимы только
переходы внутренних workspace-пакетов с 0.0.0 на 0.153.4. Любое изменение
внешней зависимости останавливает этот способ и требует нового разбора;
не подменять им закреплённый набор. Дальнейшие сборки по-прежнему только
`--locked`; исходный и patched lockfile имеют отдельные SHA-256 в receipt.

Cargo libgit2/Schannel ранее отказал с SEC_E_NO_CREDENTIALS. Штатный
git-fetch-with-cli получил Git refs, но registry HTTPS Cargo дал тот же сбой.
Node HTTPS получил все 1218 registry-архивов из Cargo.lock, каждый проверен
по закреплённому checksum перед локальной распаковкой. Cache/vendor/temp/target
находятся только в `.matchlog/0372-refresh/`. Это техническая подготовка,
не изменение TLS/ACL/profile и не готовый воспроизводимый build driver.
Его production-тесты и финальные receipts остаются незавершёнными.

- Разработка задевает большой upstream Rust graph → маленькие собираемые patch increments, закреплённый toolchain, отдельные receipts; не подключать незавершённый источник в runtime.
- User-mode snapshot не атомарен с kernel check → явная граница знания, mutator review, unstable/incomplete при сомнении; не обещать stock equivalence.
- Новый IPC меняет timing и lifecycle → сохранить штатные spawn/join решения, измерять интервалы query/API/emission, сравнивать только одинаковые instrumented builds.
- Helper/ReadAclsOnly завершается асинхронно → отдельные writers и terminal evidence; пропавший child не восполняется PID родителя.
- Долгая сборка/недоступный SDK → ограниченный запуск driver с receipt и resumable workspace; время сверх плана не оправдывает фиктивное завершение. Сначала техническая преграда с фактом, без обхода sandbox.
- 0370 schema теряет неизвестные поля → отдельный primary format и явный контракт adapter; не менять его молча в источнике.

## Migration Plan

Первый PR не включает источник в обычный runtime, не меняет конфигурацию, ledger или инциденты. Старые stdout/helper logs остаются неполными для новой причинной приёмки; автоматического повышения версии нет. Новая схема отвергается при неизвестной версии, патч можно снять без миграции игрового состояния.

После разрешённого окна хозяин завершает только собственные пробы и подтверждает flush/usage/lock release по 0370, восстанавливает исходный runtime selection и прежние паузы. При неопределённом выходе release не объявляется успешным. Evidence и build package сохраняются до проверенного переноса и приёмки; cleanup не должен уничтожить единственные bytes, на которые ссылается receipt. Сам источник не управляет уборкой или супервизором.

## Open Questions

Продуктового вопроса для design и первого допуска нет. Неизвестны фактическая собираемость/воспроизводимость в разрешённой рабочей области, полное покрытие upstream graph, native handle transport и token stability на хозяине; первые три устанавливает реализация, последний — позднее окно. Сейчас не заявляются sourceAvailable, live completeness или ремонт. Второй допуск запрашивает последующий маршрут 0370 с конкретным проверенным пакетом; завершение 0372 его не ждёт.
