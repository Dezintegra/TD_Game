# Coverage: подготовка, не инструментированный источник

Статус: **source-prepared; runtime-coverage-unimplemented**.

Проверена доставка исходных bytes Codex 0.153.4 по source-manifest/receipts/source.json.
Проверки prepare.test.mjs (16) охватывают закреплённые идентификаторы,
ограничения Windows-путей, повреждение/пропуск/лишние файлы архива,
PAX path traversal, checksum/truncation и reparse/escape на файловой границе.
Эти тесты не являются отрицательными проверками Windows/IPC instrumentation.

| Требуемая производственная граница                                | Состояние                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------- |
| leaf call → ToolCtx → request → elevated/spawn_blocking           | Не инструментирована, mutation controls отсутствуют     |
| SetupFlight leader/joiner/refresh identity                        | Не инструментирована                                    |
| helper resolver/image/child handshake                             | Не инструментирована, выбранный image не наблюдался     |
| ReadAclsOnly и scope.spawn/thread lifetime                        | Не инструментированы                                    |
| acl.rs и setup_main/win.rs: SetNamedSecurityInfoW/SetSecurityInfo | Патч отсутствует, достижимость всех ветвей не проверена |
| effective token и mutators                                        | Ни review mutators, ни token query не выполнены         |
| writer/pipe/seq/seal/loss и Node reader                           | Не реализованы                                          |
| build/reproduce/package/delivery                                  | Не выполнены                                            |

Статический обзор шести upstream build.rs описан в README и source receipt.
Он устанавливает отсутствие setup launch в этих файлах, но не полноту
call graph, не безопасность транзитивных build scripts и не source availability.
`release-lock.patch` и его receipt подтверждают только подготовку согласованного
lockfile; инструментирующий патч по-прежнему отсутствует. Поиск дополнительно
выявил SetSecurityInfo в `windows-sandbox-rs/src/desktop.rs:420` на закреплённом
SHA: достижимость и контроль этой ветви ещё предстоит установить. Отсутствие
её в первоначальном перечне не разрешает считать покрытие полным.

Историческая граница записи, не принятая как конечный результат, и неисполненный объём:
`openspec/changes/implement-refresh-boundary-source/technical-barrier.md`.
