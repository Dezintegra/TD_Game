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

The supervisor MUST only launch a task when every prerequisite is confirmed in state `completed`. Missing, invalid, self-referencing or cyclic prerequisites SHALL block launching. Archived cards SHALL satisfy prerequisites under the same rules. A closed parent with explicit `splitInto` SHALL delegate completion to all its descendants; ordinary closed cards SHALL NOT satisfy a prerequisite.

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

- **WHEN** a prerequisite is closed after decomposition or loss of relevance
- **THEN** dependent launches remain blocked until fulfillment is confirmed in completed

### Requirement: Explicit decomposition lineage

The supervisor SHALL persist a nonempty unique `splitInto` list of actual child task identifiers together with closing a successfully split parent. The list MUST survive card and archived-card round trips. Unrelated links and the `decomposed` scheduling label MUST NOT imply child membership.

#### Scenario: Split report creates parts

- **WHEN** a split report successfully creates its parts and closes the parent
- **THEN** the saved parent names exactly those parts in `splitInto`

#### Scenario: Child creation fails

- **WHEN** a child cannot be created
- **THEN** the parent is not saved as closed with an incomplete successful split

### Requirement: Completion includes all decomposition descendants

For `dependsOn` and `recovery.fixedBy`, the supervisor MUST recompute completion from every current snapshot, requiring every leaf to be confirmed completed and every parent named through `splitInto` to be completed or closed with all its descendants completed. Missing, invalid, ambiguous, cyclic or malformed descendant metadata SHALL block completion. A shared descendant without a cycle SHALL be allowed. An expected merged PR SHALL remain an additional requirement for its original dependency edge. Existing running stages SHALL not be interrupted.

#### Scenario: Recovery waits after decomposition

- **WHEN** task 41 waits for repair 127 and 127 closes by splitting into unfinished 243 and 244
- **THEN** task 41 is not returned from failure and the diagnostic names the unfinished parts through 127

#### Scenario: Nested split and final completion

- **WHEN** one part closes by splitting again
- **THEN** consumers keep waiting for its unfinished descendants and become eligible only after every leaf completes

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

- **WHEN** all split leaves complete but the expected PR of the referenced predecessor is not confirmed merged
- **THEN** the consumer still waits for the PR evidence

### Requirement: Addressed additions under an idle same-station failed claim

The supervisor SHALL permit an ordinary saved `dependencyUpdates` report to add dependencies to a `failed` target already claimed by its own station only when the target has exactly the current Trello member, the card's machine owner matches the station, and no live stage or other pending report owns the target. It SHALL re-read authoritative card data and revalidate the merged dependencies before writing, preserve the existing claim and task state, confirm the write independently, and keep the source report retryable until confirmation. Missing activity evidence, another station's claim, a live stage, or a different task state SHALL retain the busy refusal without a target write.

#### Scenario: Failed target held by the same idle station

- **WHEN** 0241's saved report adds a prerequisite to failed 0238, whose only member and owner are the idle current station
- **THEN** the addition is confirmed without removing or replacing 0238's claim, and the original report is delivered once.

#### Scenario: Active or foreign claim

- **WHEN** the target has a live stage, another pending report, a different owner or member, or cannot be proved idle
- **THEN** the target remains unchanged and the source report stays available for retry with a busy diagnostic.

#### Scenario: Confirmation fails

- **WHEN** the metadata PUT may have succeeded but readback fails
- **THEN** the source report remains in the queue, later actions use fresh target data, and a retry confirms the prior write without duplicating it.

