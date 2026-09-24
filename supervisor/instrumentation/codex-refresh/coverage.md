# Coverage: подготовка, не инструментированный источник

Статус: **wire-only; runtime-coverage-unimplemented**.

Проверена доставка исходных bytes Codex 0.153.4 по source-manifest/receipts/source.json.
Проверки prepare.test.mjs (16) охватывают закреплённые идентификаторы,
ограничения Windows-путей, повреждение/пропуск/лишние файлы архива,
PAX path traversal, checksum/truncation и reparse/escape на файловой границе.
Эти тесты не являются отрицательными проверками Windows/IPC instrumentation.

| Требуемая производственная граница                                | Состояние                                                                                    |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| leaf call → ToolCtx → request → elevated/spawn_blocking           | Не инструментирована, mutation controls отсутствуют                                          |
| SetupFlight leader/joiner/refresh identity                        | Не инструментирована                                                                         |
| helper resolver/image/child handshake                             | Не инструментирована, выбранный image не наблюдался                                          |
| ReadAclsOnly и scope.spawn/thread lifetime                        | Не инструментированы                                                                         |
| acl.rs и setup_main/win.rs: SetNamedSecurityInfoW/SetSecurityInfo | Патч отсутствует, достижимость всех ветвей не проверена                                      |
| effective token и mutators                                        | Ни review mutators, ни token query не выполнены                                              |
| writer/pipe/seq/seal/loss и Node reader                           | Node: 30 synthetic controls; Rust writer: 9 wire tests и cargo check, receipts/wire.json; pipe и причинная приёмка не реализованы |
| build/reproduce/package/delivery                                  | Не выполнены                                                                                 |

Статический обзор шести upstream build.rs описан в README и source receipt.
Он устанавливает отсутствие setup launch в этих файлах, но не полноту
call graph, не безопасность транзитивных build scripts и не source availability.
`release-lock.patch` и его receipt подтверждают только подготовку согласованного
lockfile; refresh-boundary.patch покрывает только wire writer. Поиск дополнительно
выявил SetSecurityInfo в `windows-sandbox-rs/src/desktop.rs:420` на закреплённом
SHA: достижимость и контроль этой ветви ещё предстоит установить. Отсутствие
её в первоначальном перечне не разрешает считать покрытие полным.

Повтор 2026-09-24 выявил старую редакцию patch при более новом тестируемом source.
Patch пересоздан, manifest согласован; driver теперь требует обратное применение
patch к проверяемым исходникам до Cargo. Новый receipt относится к hash
`8aebbad888d9a47cb9b31cf87ad2191131250c0c8d98dc7af8f9069fc1046672`.
Он не подтверждает сборку из чистого экспорта или производственные Windows/IPC sites.

Историческая граница записи, не принятая как конечный результат, и неисполненный объём:
`openspec/changes/implement-refresh-boundary-source/technical-barrier.md`.
