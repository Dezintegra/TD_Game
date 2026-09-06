## ADDED Requirements

### Requirement: Accepted stage reports survive supervisor restart

The supervisor SHALL persist each accepted stage report with a supervisor-owned identity unique to its launch, its full payload, denials, cost and assigned batch before releasing the completed stage for scheduling. Persistence SHALL operate while paused. Workers MUST NOT write this store; stdout remains the report transport. A storage failure MUST NOT be treated as successful acceptance or an empty queue.

#### Scenario: Pause then completion then restart
- **WHEN** pause is enabled, implement returns an accepted done report, and the supervisor restarts after persistence
- **THEN** the same report and launch context remain pending and the board remains unchanged while paused
- **AND** removing pause permits delivery without another session or continuation charge

#### Scenario: Persistence fails
- **WHEN** storing an accepted report fails
- **THEN** the supervisor retains the in-memory result for retry, reports the storage error and blocks scheduling rather than treating the stage as needing continuation

### Requirement: Pending reports are restored before recovery and scheduling

After acquiring its startup and supervisor locks, the supervisor SHALL restore the durable report queue before orphan recovery and planning. Pending reports SHALL exclude their task and assigned batch members from new sessions, continuations and competing mutations until delivery is settled, including after a partial board write. They MUST NOT reserve live-process concurrency slots for unrelated work. Invalid or unreadable persisted state MUST NOT be silently replaced by an empty queue.

#### Scenario: Stale live descriptor accompanies a saved report
- **WHEN** restart sees a pending report and a live descriptor for the same completed launch
- **THEN** recovery uses the pending result without reporting it lost, launching a continuation or compensating its usage as a lost launch

#### Scenario: Partially delivered batch
- **WHEN** a restored deploy report has already moved some batch members but has unfinished delivery operations
- **THEN** none of its batch members receives a competing stage launch or transition, while independent eligible work can use free slots

#### Scenario: Corrupted store
- **WHEN** startup cannot parse or read an existing queue or finds an unsupported version
- **THEN** it preserves the file, names the failure and does not start scheduling

### Requirement: Retried report delivery preserves single effects

Before its first external mutation, report delivery SHALL persist a stable plan of the transition, accounting, journal, requests, amendments and batch effects. Retry SHALL reconcile supervisor-owned operation identities with the recipient before reissuing uncertain writes. The same report MUST NOT cause duplicate transitions, cost increments, counter changes, created tasks or journal parts. A task returning to the same stage in a later launch SHALL be distinguishable from an old pending report.

#### Scenario: Board write failed before taking effect
- **WHEN** delivery fails before a board operation is applied and the supervisor restarts
- **THEN** the report and plan survive and retry completes the original operation once without another stage session

#### Scenario: Card moved but journal failed
- **WHEN** the card transition succeeds and a journal part fails before report acknowledgement
- **THEN** retry recognizes the applied transition and delivers only missing journal parts without recalculating the report against the new stage

#### Scenario: Remote success precedes local progress
- **WHEN** a board effect succeeds but the process stops before saving its local progress
- **THEN** restart recognizes that effect by its operation identity and does not apply it twice

#### Scenario: Requests amendments and batch fail partway
- **WHEN** delivery creates a request, posts an amendment or updates a batch member and then fails
- **THEN** retry reconciles each completed effect and completes the remainder without duplicate cards, comments or accounting

#### Scenario: Indeterminate network result
- **WHEN** an operation response is lost and recipient inspection cannot reliably determine whether it succeeded
- **THEN** delivery remains pending with a diagnostic and does not blindly repeat a creating operation or issue a continuation

#### Scenario: Same stage belongs to a different launch
- **WHEN** a restored report encounters incompatible task state from another launch without its operation receipt
- **THEN** it is retained with a conflict diagnostic and does not overwrite the newer state

### Requirement: Report acknowledgement follows complete delivery

The supervisor SHALL remove a persisted report only after all planned effects have been confirmed and completed-session cleanup has succeeded. This rule SHALL include reports routed to halt by acceptance checks. A failure of local acknowledgement SHALL retain retryable state; repeating acknowledgement MUST NOT repeat board effects.

#### Scenario: Crash after delivery before queue removal
- **WHEN** all board effects are confirmed and the supervisor stops before deleting the pending report
- **THEN** restart completes session cleanup and queue removal without another transition or journal entry

#### Scenario: Rejected trust verdict
- **WHEN** report trust checks route the task to halt and that delivery fails partway
- **THEN** the report is retained and its halt transition and diagnostic journal are completed once by the same retry protocol
