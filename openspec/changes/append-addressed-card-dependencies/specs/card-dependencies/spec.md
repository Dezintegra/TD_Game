## ADDED Requirements

### Requirement: Stage reports can address dependency additions

The supervisor SHALL accept optional `dependencyUpdates` in an otherwise accepted stage report as an array of objects containing exactly `taskId`, `dependsOn`, `dependencyResults`, and a nonempty string `reason`. Each object SHALL address one existing, uniquely identified, valid, nonarchived task other than the report source. `closed` targets SHALL be rejected; `failed` SHALL remain an eligible target without changing its state. The supervisor SHALL validate addition metadata and the merged candidate using `dependencyFormatProblem` from `dependencies.mjs`, reject dependency cycles using its existing cycle validator, and reject conflicting results for the same predecessor. Missing or empty `dependencyUpdates` SHALL preserve existing report behavior and add no storage calls. Executors MUST NOT write cards directly; their reason SHALL identify the assigned work or recorded decision authorizing the addition, not invent a product dependency.

#### Scenario: Valid addressed instruction

- **WHEN** an accepted report names a unique failed task with valid prerequisite IDs, result objects and a reason
- **THEN** the supervisor plans the addressed addition without creating a task, replacing comments, or returning the target to work

#### Scenario: Invalid instruction or recipient

- **WHEN** the field is not an array, an entry has missing or extra fields, empty additions, duplicate target entries, malformed IDs, invalid result metadata, a self-reference, a cycle, or a missing, ambiguous, invalid, archived, closed or source-task recipient
- **THEN** no dependency additions from that report are written during validation, and the report is not successfully transferred; diagnostics identify the entry and cause

#### Scenario: Invalid enclosing report

- **WHEN** the report is rejected by identity, stage, outcome or trust validation
- **THEN** its dependencyUpdates cannot change any target

### Requirement: Dependency additions preserve current card data

The supervisor SHALL resolve targets without collapsing duplicate IDs, read authoritative current card data before merging, and preserve existing dependency order while appending new IDs and results. An identical existing result SHALL be a no-op; a different result for that predecessor MUST NOT be overwritten. Both dependency fields SHALL be persisted in one metadata write. Human text, unrelated metadata including unknown keys, title, labels, list, position, membership and task state SHALL be preserved, except a temporary exclusive claim owned and released by this operation. The operation SHALL serialize with normal pipeline claims and other addressed writers; it MUST NOT steal or release another claim. Only independently confirmed target data SHALL replace the local snapshot. Remaining precomputed actions for the target SHALL be invalidated before attempting a metadata write and also upon confirming a no-op. Invalidation SHALL survive write uncertainty, failed confirmation, exceptions and claim-release failure until fresh scheduling, independently of report-transfer success.

Every normal Trello task start SHALL reread authoritative target data after acquiring its claim and before persisting task changes, preparing a worktree or launching a process. It SHALL check the freshness of the action's source data and rerun the existing `pendingDependencies` admission rules on the fresh task and dependency graph with the current cycle's scoped result evidence. Changed source data, unmet conditions or unavailable or invalid fresh data MUST NOT permit the old action to write or launch; it SHALL defer to fresh scheduling without spending attempts or changing task state. Only a new claim acquired by that invocation SHALL be released on deferral. A permitted start SHALL derive its task changes from fresh data and preserve unrelated metadata and human text. This guard SHALL apply across independent supervisor snapshots even when the starting station has no dependency update report.

#### Scenario: Fresh additions survive

- **WHEN** another dependency, result, human text or unrelated metadata was saved after the cycle snapshot and before this operation acquires the target
- **THEN** the operation merges with that current data and preserves those additions and fields

#### Scenario: Target is busy

- **WHEN** the target is already claimed by a stage or another dependency writer
- **THEN** no metadata is written and the claim remains untouched; transfer reports a retryable failure

#### Scenario: Existing result conflicts

- **WHEN** an addition names a different PR for a predecessor already having a result condition
- **THEN** the operation fails with the target and conflicting condition named and preserves the saved condition

#### Scenario: Later action used old snapshot

- **WHEN** a cycle had already selected a start or state write for a target whose dependencies were just updated
- **THEN** that action is deferred until a fresh scan and cannot overwrite the new metadata or launch using the old prerequisites

#### Scenario: Another station claims after the dependency writer releases

- **WHEN** station B selects a start from its own IO snapshot, station A then claims the target, saves and confirms a new prerequisite and releases its claim, and B subsequently acquires the target
- **THEN** B rereads the target after acquisition, detects changed source data, reruns the unchanged dependency gate and defers the old action without saving its old claimed task, preparing a worktree, launching or spending attempts
- **AND** the new prerequisite and other current data remain saved after B releases only its newly acquired claim; the next fresh scan applies the new condition

#### Scenario: Fresh start remains admissible

- **WHEN** the post-claim read confirms unchanged source data and the existing dependency gate confirms all prerequisites and declared results
- **THEN** normal startup proceeds from fresh data under the held claim, preserving unrelated metadata and human text

#### Scenario: Start freshness or admission cannot be established

- **WHEN** the post-claim read fails or is invalid, or the fresh dependency gate finds an unmet condition or a PR without matching cycle evidence
- **THEN** no task transition, worktree preparation or process launch occurs; counters remain unchanged and the diagnostic identifies the reason for deferral
- **AND** only a newly acquired claim is released, with any release failure explicitly reported

### Requirement: Dependency writes require independent confirmation

Successful transfer SHALL require independent storage rereading and validation of the saved target ID, complete requested additions, previously existing dependencies and results, and preserved unrelated data. A successful write response or the in-memory snapshot MUST NOT count as confirmation. Read failure, write failure, malformed confirmation, missing additions, lost prior data or failure to release an owned temporary claim SHALL prevent success. Target operations SHALL finish before persisting the report source transition or removing its pending report. Failure SHALL return an explicit unsuccessful transfer with target and reason, preserving the source stage and report for retry. Multiple targets need not be globally atomic: already confirmed additions SHALL survive a later failure, and replay SHALL revalidate current data without duplicate dependencies or weaker conditions.

#### Scenario: Storage acknowledges but loses a field

- **WHEN** the write returns success but an independent read lacks an expected result or an existing dependency
- **THEN** transfer fails, does not save the source transition or remove its report, and names the mismatching target data

#### Scenario: Read or write unavailable

- **WHEN** initial read, write or confirmation fails or throws
- **THEN** transfer fails explicitly, preserves the report for retry and attempts to release only its own temporary claim

#### Scenario: Write persists but confirmation fails

- **WHEN** PUT persists the requested dependency but the confirming GET fails, and the same execution has precomputed start and metadata-write actions for the target
- **THEN** transfer fails and preserves the source stage and pending report, while both later actions are deferred until a fresh scan even after the temporary claim is released
- **AND** the unconfirmed candidate is not published as fresh snapshot data and the saved addition is not overwritten by an old action

#### Scenario: Write result is uncertain

- **WHEN** the PUT response is lost or the write throws after it may have reached storage
- **THEN** target invalidation remains in effect despite the unsuccessful transfer; later precomputed target actions cannot write or launch, and replay independently reads storage before deciding whether any write is needed

#### Scenario: Replay after partial completion

- **WHEN** one target was updated before another target or source persistence failed and the same report is retried
- **THEN** fresh reads recognize identical existing additions without another metadata write, retain newer dependencies, and allow transfer only after all targets are confirmed

#### Scenario: No changes to admission semantics

- **WHEN** a dependency addition has been confirmed
- **THEN** future scans use the unchanged existing completion and merged-pr validators; recording a merged-pr expectation does not itself prove that PR merged or permit a launch
