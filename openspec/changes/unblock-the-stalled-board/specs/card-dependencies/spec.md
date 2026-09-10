## ADDED Requirements

### Requirement: Закрытие предшественника разрешает ожидание

Ребро ожидания, названное в `dependsOn` или `recovery.fixedBy` и ведущее
в карточку состояния `closed`, супервизор SHALL снимать с ждущей карточки.
Снятие SHALL планироваться по снимку доски, а не только в момент закрытия:
так разбирается и уже накопившийся затор, и переживается обрыв на середине.

Закрытие дроблением с непустым `splitInto` SHALL составлять исключение: такое
ребро SHALL сохраняться. Там работа не отпала, а переехала в части, и передача
доказательства частям уже действует рекурсивно; снятие ребра пустило бы задачу
вперёд её собственной незаконченной предпосылки.

Двусмысленный идентификатор SHALL отменять снятие: не зная, какая из карточек
имелась в виду, ребро снимать нельзя.

Вместе с ребром SHALL сниматься запись ожидаемого влитого PR для того же
предшественника — иначе проверка формата объявит карточку негодной. Сохранённое
основание ожидания `blockedContext` SHALL оставаться нетронутым: оно
и после снятия верно говорит, чего задача ждала.

Каждое снятие SHALL сопровождаться комментарием на ждущей карточке, содержащим
два обоснования: **почему ожидаемая задача закрыта** — дословной причиной
закрытия из закрываемой карточки — и **почему ожидание больше не нужно** —
названием разрешённого ребра и его судьбы. Комментарий SHALL нести тег
источника `supervisor`. Повтор разрешения уже снятого ребра SHALL NOT
дублировать комментарий и SHALL NOT менять карточку.

Разрешение SHALL быть частичным: неудача на одной ждущей карточке SHALL NOT
отменять разрешение на остальных и SHALL NOT препятствовать закрытию
предшественника. Неразрешённое ребро SHALL называться в журнале цикла
и SHALL повторяться следующим оборотом. Ждущая карточка, оставшаяся без единого
ребра, SHALL выходить из `blocked` обычным механизмом разблокировки; её
счётчики, положение, владелец и артефакты SHALL сохраняться.

#### Scenario: Предмет снят, ждущие освобождены

- **WHEN** предшественник закрыт с причиной «предмет снят» и на него ссылались десять карточек
- **THEN** ребро снято у всех десяти, каждая получила комментарий с причиной закрытия и основанием снятия, и ни одна не осталась ждать закрытую карточку

#### Scenario: Закрытие дроблением ожидание сохраняет

- **WHEN** предшественник закрыт с непустым `splitInto`
- **THEN** ребро остаётся на месте, а ждущая карточка продолжает ждать невыполненных частей

#### Scenario: Номер занят дважды

- **WHEN** идентификатор предшественника принадлежит двум карточкам сразу
- **THEN** ребро не снимается, потому что неизвестно, какая из карточек имелась в виду

#### Scenario: Повторный оборот не дублирует записи

- **WHEN** разрешение ребра уже выполнено и снимок не изменился
- **THEN** новых комментариев и правок карточек не появляется

#### Scenario: Одна ждущая карточка недоступна

- **WHEN** сохранение одной из ждущих карточек не удалось
- **THEN** остальные разрешены, предшественник остаётся закрытым, неразрешённое ребро названо в журнале и повторяется следующим оборотом

#### Scenario: Снятие последнего ребра возвращает задачу в очередь

- **WHEN** у карточки в `blocked` снято единственное ребро ожидания
- **THEN** она возвращается в очередь обычной разблокировкой с сохранением счётчиков, положения и артефактов

### Requirement: Действующие ожидания закрытых карточек разрешаются при включении

Включение правила SHALL разрешить уже существующие рёбра, ведущие в карточки,
закрытые до включения. Обоснование SHALL называть причину закрытия
предшественника, взятую из его карточки, а при её отсутствии — прямо сообщать,
что причина не сохранилась. Разрешение SHALL идти порциями и SHALL NOT требовать
одного оборота на всю доску.

#### Scenario: Затор разбирается без человека

- **WHEN** на доске есть карточки, ждущие давно закрытых предшественников
- **THEN** ближайшие обороты снимают эти рёбра с обоснованием и возвращают освободившиеся задачи в очередь

## MODIFIED Requirements

### Requirement: Gate task launches on completion

The supervisor MUST only launch a task when every prerequisite is confirmed in
state `completed`. Missing, invalid, self-referencing or cyclic prerequisites
SHALL block launching. Archived cards SHALL satisfy prerequisites under the same
rules. A closed parent with explicit `splitInto` SHALL delegate completion to all
its descendants; ordinary closed cards SHALL NOT satisfy a prerequisite.

Эта мерка SHALL применяться только к рёбрам, которые ещё существуют. Закрытие
предшественника SHALL разрешать ребро по требованию «Закрытие предшественника
разрешает ожидание»; до разрешения мерка держит запуск, после разрешения ребра
нет и держать нечего. Ожидание обычного закрытого предшественника SHALL NOT
сохраняться дольше, чем нужно оркестратору на разрешение ребра.

#### Scenario: Waiting without spending attempts

- **WHEN** any prerequisite has not completed
- **THEN** the task receives no start, continuation or attempt-limit failure action, its counters remain unchanged, and the cycle reports the blocking identifiers

#### Scenario: All prerequisites closed

- **WHEN** every prerequisite is completed
- **THEN** normal scheduling resumes on the next snapshot

#### Scenario: Blocked run and ready feature

- **WHEN** a run waits for a prerequisite and a feature is ready
- **THEN** the blocked run does not prevent scheduling the feature

#### Scenario: Existing process

- **WHEN** a prerequisite changes while a process is running
- **THEN** the supervisor does not interrupt the process or discard its report

#### Scenario: Closed without fulfillment

- **WHEN** a prerequisite is closed after loss of relevance and its edge is not yet resolved
- **THEN** dependent launches remain blocked until the edge is resolved, and resolution follows on the next cycle without waiting for a human
