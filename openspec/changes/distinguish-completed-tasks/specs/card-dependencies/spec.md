## MODIFIED Requirements

### Requirement: Gate task launches on completion

The supervisor MUST only launch a task when every prerequisite is confirmed in state `completed`. Missing, invalid, self-referencing or cyclic prerequisites SHALL block launching. Archived cards SHALL satisfy prerequisites only when confirmed in `completed`.

#### Scenario: Waiting without spending attempts

- **WHEN** any prerequisite has not completed
- **THEN** the task receives no start, continuation or attempt-limit failure action, its counters remain unchanged, and the cycle reports the blocking identifiers

#### Scenario: All prerequisites completed

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

