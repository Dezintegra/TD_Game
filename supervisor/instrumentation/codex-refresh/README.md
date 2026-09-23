# Закреплённый источник refresh

Подготовка Codex 0.153.4 по проектам 0371/0372. Пока это только подготовка
исходников: патч, сборка, покрытие и live source availability не подтверждены.

`prepare.mjs` проверяет annotated tag, commit и tree из `source-manifest.json`
через GitHub API, сверяет каждый blob официального tarball с recursive Git tree
и экспортирует codex-rs и LICENSE в собственную `.matchlog/0372-refresh/source`.
Распаковка не вызывает системный tar или checkout hooks. Единственная исходная
ссылка `codex-rs/vendor/bubblewrap/LICENSE` материализуется копией проверенного
regular blob внутри inputs; receipt различает хеш ссылки и конечных bytes.
Ссылки наружу, цепочки ссылок, submodules и небезопасные Windows-пути запрещены.
Receipt содержит UTC, исходные Git blob IDs и SHA-256 каждого полученного файла.
Повтор поверх имеющейся области запрещён; существующие bytes не перезаписываются.

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
