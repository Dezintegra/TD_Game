# Handoff 0372 → 0370: техническая преграда

Статус: **technical-barrier; package-not-delivered; live-unproven**.
PR 287 содержит подготовку исходников и предусмотренный проектом альтернативный
результат. Он не поставляет исполняемый источник и не снимает инцидент 0366.

Сверка 2026-09-23 22:46:44 UTC: PR 286 MERGED, head
`e8c688290e2236b66c41f0576e6c3d949ca3ae81`, mergedAt
`2026-09-23T21:54:08Z`. Diff его design против принятого
`f7bca391bcdb7ff459b1c440ca02c18c93ce1e31` пуст. Основание первого допуска
сохраняется; источник не активирован.

Первый отправленный коммит `dab7286e` — prepare driver, 16 отрицательных/положительных
проверок подготовки, manifest и source receipt. `b239fcba` сохраняет точную
границу передачи и согласованный альтернативный объём tasks.

Проверенный source receipt:
`C:/src/dezintegra/TD_Game/.claude/worktrees/0372-realizovat-istochnik-prichinnoy-korrelya/supervisor/instrumentation/codex-refresh/receipts/source.json`.
SHA-256 `e5c680b5cc7248e914ef7746a7deb5445aa4712885fce7e092e492d23e723a13`;
UTC независимого чтения всех 6497 файлов `2026-09-23T22:44:09.139Z`.
Этот receipt сохраняется отправленным Git-коммитом. Исходные bytes внутри
`.matchlog/0372-refresh/source` не переживают гарантированно cleanup;
их наличие не является переносимым пакетом.

Полная фактура, профиль writable roots, ошибки, результаты проверок,
недоставленный состав и ответственный маршрут — в
[technical-barrier.md](technical-barrier.md). Конечное хранилище
`C:/src/dezintegra/TD_Game/.matchlog/refresh-source-deliveries/0372/<packageSha256>/`
не входит в writable roots сессии. Запись туда и независимая приёмка не состоялись.
Это ограничение установлено профилем, а не искусственной попыткой запрещённой записи.

BuildId, packageSha256, patch/binary hashes, build receipts и delivery receipt
**отсутствуют**. Schema/reader, Rust instrumentation, Windows/IPC negative controls
и source-coverage review не выполнены. Нельзя использовать source hash вместо
build/package identity. [activation-request.md](activation-request.md) описывает
недостающие входы будущего решения, не просит второй допуск сейчас.

`pnpm test:pipeline instrumentation/codex-refresh/prepare.test.mjs`: 16/16;
ESLint/Prettier успешны; OpenSpec strict validate успешен. Полный pipeline suite
имеет 4 падения в трёх неизменённых файлах (3081 passed), перечисленные в преграде.
CI при единственном чтении pending; его ожидание и review — следующий этап.

0372 может завершить передачу этого альтернативного результата без запуска
зависимой 0370. Её новый анализ обязан отдельно оценить пригодность преграды:
**sourceAvailable и причинная достаточность не подтверждены**. Чтобы получить
источник, ещё требуется завершить разработку первого допуска и обеспечить
перенос Windows-хозяином с последующим независимым чтением конечной копии.
Завершённая карточка или влитый PR сами по себе не разрешают активацию.

Collector, бюджет, ledger, locks, observer integration и live-validation остаются
у 0370. Нет обратной зависимости и новых заявок-дубликатов. ACL, privileges,
profile, runtime и игровые правила не изменялись; настоящий setup и live token
queries не выполнялись.
