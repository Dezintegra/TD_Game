## MODIFIED Requirements

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


