# Закреплённый источник refresh

Частичная реализация Codex 0.153.4 по проектам 0371/0372: подготовка исходников,
wire reader и отключённый Rust writer. Производственные границы, воспроизводимая
сборка CLI/helpers, полный пакет и live source availability пока не подтверждены.

`prepare.mjs` проверяет annotated tag, commit и tree из `source-manifest.json`
через GitHub API, сверяет каждый blob официального tarball с recursive Git tree
и экспортирует codex-rs и LICENSE в собственную `.matchlog/0372-refresh/source`.
Распаковка не вызывает системный tar или checkout hooks. Единственная исходная
ссылка `codex-rs/vendor/bubblewrap/LICENSE` материализуется копией проверенного
regular blob внутри inputs; receipt различает хеш ссылки и конечных bytes.
Ссылки наружу, цепочки ссылок, submodules и небезопасные Windows-пути запрещены.
Receipt содержит UTC, исходные Git blob IDs и SHA-256 каждого полученного файла.
Повтор поверх имеющейся области запрещён; существующие bytes не перезаписываются.

`release-lock.patch` отдельно согласует версии 149 внутренних пакетов upstream
с workspace version 0.153.4. Registry/git зависимости не меняются.
`release-lock.mjs` проверяет точные исходный/результирующий SHA-256 и все прочие
bytes; результат фактической проверки — `receipts/release-lock.json`.
Патч применяется относительно корня экспортированного source, до сборки
с `--locked`. Исходный source receipt остаётся описанием непатченного экспорта.
`refresh-boundary.patch` применяется после `release-lock.patch` и добавляет
wire writer; его отдельный hash закреплён в manifest.

### Wire reader (частичная реализация)

`schema.json` задаёт строгий allowlist `refresh-boundary/v1`.
`supervisor/lib/refresh-boundary-source.mjs` кодирует и читает отдельный bounded
snapshot: uint32 LE длина UTF-8 JSON, JSON, 32 bytes SHA-256 JSON. JSON компактный,
без дублированных ключей и избыточных escape; порядок ключей свободный. Размер всего
frame не больше 256 КиБ. В journal не больше 10 МиБ; последние 64 КиБ доступны
только loss/seal. Вызывающий transport также обязан ограничивать входной буфер.

Каждый writer начинает с handshake/seq=1; seal подтверждает число предшествующих
frames, их последний seq и SHA-256 полных wire bytes этого writer. Независимые
writers передаются через expectedWriterIds, collectionId/launchId — через параметры
collector. Reader сохраняет только проверенный префикс, не публикует неизвестные
поля или исходный текст ошибок. Encoder не читает лишние поля даже через getters.
Это не Rust serializer и не проверка производственных Windows/IPC-границ.

`integrity` и `completeness` пока относятся только к wire transport. Проверка
происхождения, причинного графа и token-at-call остаётся пунктом 5.1:
`sourceAvailable`, `causalSufficiency` и `allowNextInvocation` всегда false.
Ни синтетика, ни handshake с origin=instrumented не открывают допуск.

Подготовка не запускает build scripts, CLI, setup или command runner. Git dependency refs
в receipt — опись lockfile, не подтверждение скачивания этих зависимостей.

Просмотрены все шесть upstream `build.rs`: cli задаёт macOS linker flag;
windows-sandbox-rs задаёт embedding manifest; skills перечисляет samples;
code-mode-protocol компилирует protobuf vendored protoc; bwrap компилирует C
только для Linux; linux-sandbox объявляет Cargo rerun input. В них нет запуска
setup/helper. Это статический обзор самих upstream scripts, не аудит ещё
неполученных транзитивных build dependencies и не результат сборки.

Первый Git fetch завершился Schannel `SEC_E_NO_CREDENTIALS (0x8009030E)`.
GitHub API доставил тот же закреплённый source без смены TLS backend,
ACL, профиля или привилегий. Этот отказ Git не доказывает недоступность source.

Долговременная передача и отдельный допуск к активации выполняются по Decisions 6
`implement-refresh-boundary-source`. Путь внутри worktree не считается поставкой.

Текущий результат: `development-incomplete; package-not-delivered`.
Ревью отвергло завершение по ограничению writable roots до подготовки пакета.
В `openspec/changes/implement-refresh-boundary-source/technical-barrier.md` сохранена
историческая граница; она не доказывает отказ уполномоченного Windows-хозяина.
Полный патч и binaries отсутствуют. `coverage.md` явно отличает проверенную подготовку
от невыполненного обзора производственных границ. Разрешение на активацию не выдано.

### Rust wire writer и частичный driver

`build.mjs` пока поддерживает только `check --group wire`: сверяет source inputs,
patch/recipe hashes и обратное применение patch к тестируемому source, выполняет
Cargo check, сверяет точный harness list и запускает девять Rust tests.
Старый fixture удаляется перед запуском, свежие bytes проверяет Node reader.
Результат сохранён в `receipts/wire.json`; synthetic fixture не доказывает
производственную корреляцию. Пункт 2.2 полного build/package/delivery driver открыт.

`DiagnosticContext` передаётся явно и разделяет sticky health между clones.
При `None` event/clock closures не вызываются. Writer ограничивает frame и queue,
выдаёт seq до сериализации, проверяет handshake/seal и сохраняет failure status.
Настоящий pipe, общий collection limit, dispatch, helper, token и ACL wrappers
остаются открытыми пунктами 3.2–5.1; runtime не активирован.

Проверенные примитивы `admitPackageIndex`, `verifyPackage`, `deliverPackage`
и `verifyDelivery` работают с явной описью bytes. Тесты подменяют filesystem
полностью: они не обращаются к постоянному хранилищу. Проверка конечной копии
не читает исходный пакет, отвергает лишние/пропущенные файлы, symlink/reparse,
повреждение размера/hash и ошибки flush. Эти функции пока не подключены
к CLI: окончательный состав пакета, admission receipts и build/reproduce
остаются в пункте 2.2. Два синтетических файла теста не являются пакетом 0372.
