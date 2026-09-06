# card-dependencies Specification

## Purpose

Prevent premature task launches by requiring explicit predecessor completion without spending attempts while waiting.
## Requirements
### Requirement: Explicit prerequisite metadata

The supervisor SHALL preserve optional `dependsOn` metadata containing complete task identifiers; absence SHALL mean no prerequisites.

#### Scenario: Round trip

- **WHEN** a card is read and saved
- **THEN** its prerequisite identifiers remain unchanged

### Requirement: Gate task launches on completion

The supervisor MUST only launch a task when every prerequisite is confirmed in state `closed`. Missing, invalid, self-referencing or cyclic prerequisites SHALL block launching. Archived cards SHALL satisfy prerequisites only when confirmed in `closed`.

#### Scenario: Waiting without spending attempts

- **WHEN** any prerequisite has not closed
- **THEN** the task receives no start, continuation or attempt-limit failure action, its counters remain unchanged, and the cycle reports the blocking identifiers

#### Scenario: All prerequisites closed

- **WHEN** every prerequisite is closed
- **THEN** normal scheduling resumes on the next snapshot

#### Scenario: Blocked run and ready feature

- **WHEN** a run waits for a prerequisite and a feature is ready
- **THEN** the blocked run does not prevent scheduling the feature

#### Scenario: Existing process

- **WHEN** a prerequisite changes while a process is running
- **THEN** the supervisor does not interrupt the process or discard its report

### Requirement: Explicit decomposition lineage

The supervisor SHALL persist a nonempty unique `splitInto` list of actual child task identifiers together with closing a successfully split parent. The list MUST survive card and archived-card round trips. Unrelated links and the `decomposed` scheduling label MUST NOT imply child membership.

#### Scenario: Split report creates parts

- **WHEN** a split report successfully creates its parts and closes the parent
- **THEN** the saved parent names exactly those parts in `splitInto`

#### Scenario: Child creation fails

- **WHEN** a child cannot be created
- **THEN** the parent is not saved as closed with an incomplete successful split

### Requirement: Completion includes all decomposition descendants

For `dependsOn` and `recovery.fixedBy`, the supervisor MUST recompute completion from every current snapshot, requiring the referenced parent and all descendants named through `splitInto` to be confirmed closed. Missing, invalid, ambiguous, cyclic or malformed descendant metadata SHALL block completion. A shared descendant without a cycle SHALL be allowed. An expected merged PR SHALL remain an additional requirement for its original dependency edge. Existing running stages SHALL not be interrupted.

#### Scenario: Recovery waits after decomposition

- **WHEN** task 41 waits for repair 127 and 127 closes by splitting into unfinished 243 and 244
- **THEN** task 41 is not returned from failure and the diagnostic names the unfinished parts through 127

#### Scenario: Nested split and final completion

- **WHEN** one part closes by splitting again
- **THEN** consumers keep waiting for its unfinished descendants and become eligible only after every part closes

#### Scenario: Ordinary dependency and unrelated link

- **WHEN** a closed predecessor has an unfinished split child and an unrelated linked note
- **THEN** the split child blocks task launch without spending attempts, while the unrelated note does not

#### Scenario: Archived parent retains lineage

- **WHEN** a split parent is archived in closed state but a named child is missing or open
- **THEN** neither archival nor a cached closed ID permits the consumer to run or return

#### Scenario: Changed snapshot

- **WHEN** a previously closed child is reopened before a waiting consumer receives a process
- **THEN** the consumer is held again on the next snapshot

#### Scenario: Explicit PR result

- **WHEN** all split parts close but the expected PR of the referenced predecessor is not confirmed merged
- **THEN** the consumer still waits for the PR evidence

