# resilient-report-delivery Specification

## Purpose
Сохранять диагностические отчёты и изолировать ошибки их формата, не запрещая безопасное обновление приёмника.
## Requirements
### Requirement: Совместимый контракт свидетельств инцидента

Приёмник SHALL принимать evidence как непустую строку или непустой список непустых строк и сохранять каноническую строку. affectedStages SHALL допускать реальные этапы, включая postmortem. check.stage SHALL оставаться исходным returnTo, входить в affectedStages и исключать postmortem.

#### Scenario: Сбой инструмента затронул audit и postmortem

- **WHEN** завершённый разбор общей поломки содержит список свидетельств и affectedStages audit/postmortem с проверкой audit
- **THEN** отчёт принимается без потери фактов, а повтор эквивалентной декларации сохраняет идентичность инцидента

#### Scenario: Свидетельства повреждены

- **WHEN** evidence пуст или содержит нестроковые элементы
- **THEN** декларация отклоняется с диагностикой

### Requirement: Постоянный отказ сохраняется отдельно от повторяемого сбоя

До сохранения плана чистая ошибка структуры SHALL сохранять rejection с причиной и временем в исходном конверте. Отчёт SHALL NOT удаляться или считаться применённым. Его участники SHALL оставаться защищены от новой работы; независимые карточки SHALL продолжать планироваться. Scan SHALL называть причину и не повторять отклонённую доставку. Явный retry SHALL сохранять исходник и возвращать отчёт в доставку.

#### Scenario: Некорректный отчёт пережил перезапуск

- **WHEN** декларация отклонена, очередь перечитана и начат новый цикл
- **THEN** тот же reportId и исходник сохранены, повторной доставки и запуска участника нет, независимая работа разрешена

#### Scenario: Временный сбой или незавершённая запись

- **WHEN** Trello недоступен, обнаружен конфликт состояния, план частично применён либо запись rejection не удалась
- **THEN** ошибка не превращается в долговечный отказ, исходная очередь остаётся доступной для повтора

### Requirement: Сохранённые отчёты не задерживают исправление приёмника

Самообновление SHALL разрешать перезапуск с неприменёнными отчётами только при подтверждённом точном сохранении очереди на диске, отсутствии живых этапов и несохранённых результатов. После рестарта SHALL применяться прежние гарантии квитанций и однократности.

#### Scenario: Исправление ожидает ошибочный отчёт

- **WHEN** новый код готов, живых этапов нет и вся очередь подтверждена на диске
- **THEN** супервизор перезапускается с той же очередью, включая отклонённые записи

#### Scenario: Сохранность не подтверждена

- **WHEN** файл очереди недоступен, изменён, повреждён или есть несохранённый результат либо живой этап
- **THEN** рестарт удерживается с причиной

### Requirement: Administrative cleanup incident declarations use local recovery

The supervisor SHALL accept a successful pipeline-caused postmortem that declares an incident confined to `cleanup` with `check.stage` and the source `returnTo` equal to `cleanup` as local recovery when evidence, verification expectation, and resolved repair tasks are present. It SHALL preserve the diagnosis and repair links, SHALL NOT open a global `pipelineIncident`, and SHALL keep the source held until the repairs and ordinary cleanup admission conditions are satisfied.

#### Scenario: Preserved report for cleanup loop

- **WHEN** 0067's saved postmortem names the cleanup loop, `0339` and `0340` as repairs, and a cleanup verification expectation
- **THEN** the same report is accepted after explicit retry, its evidence and expectation are recorded, and 0067 waits for those repairs without a global incident.

#### Scenario: Incomplete cleanup declaration

- **WHEN** the declaration lacks valid evidence or an expectation, has no resolved repair tasks, or names additional affected stages
- **THEN** it remains rejected in the saved report queue with a diagnostic; no repair or cleanup is assumed complete.

#### Scenario: Unrelated incident declaration

- **WHEN** a postmortem declares an invalid incident for a session stage
- **THEN** ordinary incident validation still rejects the declaration and preserves the original report.
