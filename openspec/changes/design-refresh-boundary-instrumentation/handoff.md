# Передача проекта источника refresh: 0371 → 0372

## Результат и основание

Статус поставки: **design-only; source availability unproven**. Подготовлен
документальный контракт выбранного варианта B. Инструментированная сборка,
фактически выбранный helper, доступ TOKEN_QUERY и полнота живого свидетельства
этой поставкой не подтверждены. Причинная приёмка 0370 остаётся невыполненной.

Основание: отправленный проект на SHA
`f7bca391bcdb7ff459b1c440ca02c18c93ce1e31` и принятый повторный аудит
`587f6019572b5100ac426446f14ac2ac` из журнала назначения. Аудит подтвердил
устранение цикла допуска; новых корректировок проекта не потребовал.
Исполняемый объём текущего этапа — только пункт 1.1 [tasks.md](tasks.md).
Время статической сверки implement: 2026-09-23, опорная отметка часов
`2026-09-23 21:32:41 UTC`. Это не время наблюдения refresh.

## Сверенные источники

- [Проект](design.md), [дельта требований](specs/pipeline-supervision-resilience/spec.md)
  и [опись источников](sources.md) задают контракт; номера разделов ниже относятся
  к Decisions в design.md.
- Immutable upstream: `openai/codex`, annotated object
  `042fb41b7c813ac7999105e886b2b7aa715b5081` разрешён GitHub API в commit
  `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` для `rust-v0.153.4`.
  Семь файлов карты раздела 1 повторно получены read-only contents API по этому SHA.
- [Tool handler](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs)
  содержит call_id/event_call_id;
  [runtime](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/tools/runtimes/unified_exec.rs)
  принимает ToolCtx;
  [elevated backend](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/windows-sandbox-rs/src/unified_exec/backends/elevated.rs)
  содержит RunnerTransportRequest и spawn_blocking.
- [setup.rs](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/windows-sandbox-rs/src/setup.rs)
  подтверждает SetupFlight, singleflight по b64 payload, resolver и Command::status;
  [helper_materialization.rs](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/windows-sandbox-rs/src/helper_materialization.rs)
  входит в карту происхождения helper. Это существующие точки расширения,
  а не уже реализованная передача диагностического контекста.
- [setup_main/win.rs](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/windows-sandbox-rs/src/bin/setup_main/win.rs)
  подтверждает spawn_read_acl_helper и scope.spawn;
  [acl.rs](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/windows-sandbox-rs/src/acl.rs)
  содержит SetNamedSecurityInfoW на строках 428, 561, 664, 737. В win.rs также
  есть вызов на строке 391: будущий source-coverage review обязан проверить
  достижимость всех sites, а не ограничиться четырьмя вызовами acl.rs.
- Повторно открыты Microsoft Learn:
  [OpenThreadToken](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openthreadtoken)
  подтверждает выбор контекста при OpenAsSelf=FALSE и возможность отказа;
  [SetNamedSecurityInfoW](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setnamedsecurityinfow)
  возвращает код ошибки непосредственно. Доступность запросов на хозяине
  из этих справок не следует.
- Прочитана существующая опись хозяина:
  `C:/src/dezintegra/TD_Game/.claude/worktrees/0370-poluchit-razlichayuschie-svidetelstva-re/.matchlog/0370-refresh/host-static-inventory-20260923T2034Z.md`.
  Повторный SHA-256 совпал:
  `A594F13E5E23F557A0B82373C2DB86F12B0F1829E8679D1AF8EADBDCEB405315`.
  Наблюдения описи относятся к 2026-09-23 20:28–20:34 UTC. Хеши stock CLI
  и соседнего helper остаются данными этой описи; новый запуск не наблюдался.
- Контракт 0370 закреплён на
  `8f32288cf0010496d74e920ea663a673cd62a51f`, путь
  `openspec/changes/capture-refresh-causal-evidence/design.md`, PR 283.
  Он сохраняет владельца collector и причинной приёмки; не является влитым main.

## Покрытие четырёх требований

«Проверено статически» означает чтение исходников/документации и сверку проекта.
«Спроектировано» означает согласованный будущий контракт, а не работающий прибор.
«Требует реализации/живой проверки» не закрывается успешной проверкой Markdown.

| Требование дельты | Проверено статически | Спроектировано | Требует реализации/живой проверки |
| --- | --- | --- | --- |
| Instrumented refresh source design separates provenance from activation | Immutable source и опись с совпавшим хешем; helper остаётся кандидатом | Разделы 1, 6: manifest/receipt, resolver и handshake, два последовательных допуска | Патч, сборка и её происхождение; selected image и PID+creationTime в разрешённом окне |
| Instrumented refresh source design defines a causal boundary graph | ToolCtx, singleflight, spawn_blocking, workers и ReadAclsOnly существуют | Разделы 1, 2, 5: collection/launch/call/attempt/refresh/helper/ACL IDs, lifetime и coverage review | Передача на каждой реальной границе и отрицательные контроли её потери; живая цепь до ACL |
| Instrumented refresh source design specifies effective-token evidence and its limits | Нативные ACL sites и документированная семантика API | Разделы 3, 5: TOKEN_QUERY-only, точный выбор токена, bounded fields, direct DWORD, предел user-mode наблюдения | OS-boundary тесты, обзор mutators, стабильность контекста и доступ к токену непосредственно у вызова |
| Instrumented refresh source design makes loss and bounded acceptance explicit | Проект сохраняет контракт collector 0370 и отделяет синтетику от host evidence | Разделы 4–6: versioned allowlist, bounded IPC, sequence/seal, partial, лимиты и остановка новых invocations | Производственные serializer/decoder и fault tests; полнота и causalSufficiency реального bundle |

## Покрытие всех 12 сценариев

Все отрицательные контроли ниже **спроектированы, но не исполнялись** на этом
этапе. Они требуют будущей реализации; живая пригодность источника проверяется
отдельно после допуска. Основания статической сверки приведены выше.

| № | Сценарий дельты | Раздел design / основание | Спроектированный контроль и ожидаемый результат | Оставшаяся проверка |
| --- | --- | --- | --- | --- |
| 1 | Version matches but selected helper is unknown | 1, 5; опись и resolver | Подменить selected path/hash/receipt либо image между наблюдениями → provenance-incomplete; версия не спасает допуск | Реализовать проверку и подтвердить выбранный image через process handle и handshake |
| 2 | Design is delivered without an instrumented build | 6; журнал принятого аудита | Документальная поставка без сборки остаётся design-only; успешная команда/valid JSON без syscall evidence не дают принятого источника | Сейчас граница сохранена этим handoff; исполняемый admission проверяет 0372 |
| 3 | Two tool calls share one refresh | 2, 5; SetupFlight | Два call дают leader/joiner одного refresh; удалить любую edge → correlation-incomplete. Следующий flight получает новый ID; исходный ключ объединения неизменен | Проверить реальные точки передачи и мутацией удалить edge |
| 4 | ACL work runs after the parent helper exits | 1, 2, 4, 5; ReadAclsOnly и workers | Потерять child/worker context, writer или terminal → coverage/correlation-incomplete; identity родителя не подставляется | Проверить дочерний lifetime, отдельный writer и bounded drain, включая crash |
| 5 | Numeric process or thread identity is reused | 2, 5 | Повтор PID/TID с другой creationTime или другой поток before/result → identity-mismatch; исходные записи сохраняются | Проверить lifetime join и точность FILETIME без потери 64 бит |
| 6 | Thread token is inaccessible | 3, 5; OpenThreadToken | Access denied при доступном primary token → token-unavailable, fallback не вызывается; усиление прав запрещено | OS-boundary контроль и отдельно фактическая доступность в разрешённом окне |
| 7 | No impersonation token exists | 3, 5 | Только ERROR_NO_TOKEN допускает process token с TOKEN_QUERY и записью причины/интервала; иная ошибка отвергается | Парные тесты разрешённого fallback и его запрета, затем наблюдение реального выбора |
| 8 | Token stability cannot be established | 3, 5 | Изменение TokenId/ModifiedId, missing field или неконтролируемая смена контекста → unstable/unavailable, без token-at-call | Проверить snapshot и mutators; совпадение before/after само по себе не доказывает атомарность |
| 9 | ACL API returns an error code | 3, 5; ACL sites и API reference | DWORD=5 и последующая смена last-error → в записи остаётся 5 с aclOpId | OS-boundary тест сохранения результата и живая запись covered API |
| 10 | Final record is lost without a reported drop | 4, 5 | Удалить terminal seal при drops=0 → incomplete; также missing initial/middle/child, duplicate seq, corrupt/truncated frame, unknown version не принимаются | Производственный decoder должен сохранить читаемый префикс и обнаружить каждый дефект |
| 11 | Storage or observation budget is exhausted | 4–6; контракт 0370 | Sink/flush failure, overflow или лимит времени/объёма → partial и ноль новых diagnostic invocations; нет replay и успешного release без доказанного выхода | Fault tests композиции с существующим collector/учётом, затем соблюдение лимитов окна |
| 12 | Synthetic control contains forbidden data | 4, 5 | Canary в payload/argv/error/unknown field отсутствует во всех serialized bytes; синтетика не становится host evidence | Проверить производственный allowlist serializer, а не генератор идеальных событий |

Source-coverage review дополнительно охватывает no-refresh/no-op ветви,
mapping collector invocation → leaf call (включая code-mode), targetRef/realpath/
file ID/DACL drift и все достижимые ACL sites. Потеря любой из этих обязательных
связей сохраняет incomplete. UTC не заменяет parent edges и per-writer sequence.

## Два последовательных допуска

1. **Разработка, сборка и проверки без активации.** Следующему исполнителю 0372
   передаются отправленный проект с точным SHA и принятый аудит. Отдельное
   поручение определяет подготовку патча, сборки и отрицательных проверок
   раздела 5 с подменой ОС/IPC. Патч, build manifest/receipt, coverage review и
   результаты тестов являются результатами этой разработки, а не предусловиями
   разрешения создать их. Конкретные команды upstream harness/Windows target
   закрепляются после появления checkout и патча. Настоящий setup, изменение
   ACL, замена рабочего runtime, live token query и опыт этим допуском не разрешены.
2. **Активация и живой опыт.** Отдельно после разработки проверяются точный патч,
   manifest/receipt с подтверждённым происхождением сборки, source-coverage review,
   отрицательные тесты и текущие полномочия хозяина. Явное поручение закрепляет
   сборку, активацию и окно 0370. Фактически выбранный helper и его process identity
   сверяются в этом разрешённом окне до принятия свидетельств. Несовпадение или
   недоступность дают incomplete и точную преграду, без изменения прав.

Публикация/вливание этого PR не выполняет ни один допуск автоматически.
Проверка отсутствия цикла: для первого допуска нужны проект и аудит; результаты
разработки требуются только для второго. Выбор B уже сделан, повторять A/B не надо.
Продолжение существует в карточке
`0372-realizovat-istochnik-prichinnoy-korrelya`; дублирующая заявка не нужна.

## Передача результата 0370 и ограничения

`0370-poluchit-razlichayuschie-svidetelstva-re` остаётся единственным владельцем
collector, launch/budget/ledger/lock route, observer integration и конечных
вердиктов integrity/completeness/causalSufficiency. Здесь её checker и открытые
tasks не меняются; обратная зависимость на 0370 и условие влить PR 283 не вводятся.
Документальное завершение 0371 не заменяет обязательный результат 0372 для 0370.

Будущий разрешённый сбор ограничен двумя сессиями, четырьмя вызовами на сессию,
двумя минутами на сессию и десятью минутами на всё окно, включая подготовку/flush.
Предел очищенных записей — 10 МиБ, включая резерв 64 КиБ; фрейм — 256 КиБ,
очередь writer — 1 МиБ. Потеря связи, обязательного поля, отказ записи или предел
останавливают новые диагностические вызовы через существующий collector.
Чужие процессы и супервизор источник сам не останавливает.

Первичные живые материалы впоследствии сохраняет штатный хозяин новым файлом
в `.matchlog/0370-refresh/` дерева 0370 с абсолютным путём, SHA-256, UTC и ссылками
на исходные записи. Требуется связать конкретный tool call → refresh → helper/
thread → ACL/токен с итогами чтения и Git, либо назвать точную подтверждённую
преграду. На этом этапе в дерево 0370 ничего не записывалось. Не запускались
модели, helper/setup, tracing, debugger, token query или живые подписки; не
менялись ACL/profile/привилегии, runtime, бюджет и состояние супервизора.
Секреты, полный argv/payload и личные настройки не собирались.

Даже полное свидетельство instrumented build не доказывает поведение stock
binary и не ремонтирует инцидент 0011. Ремонт и регрессии остаются 0366,
incidentVerification — исходному audit.
