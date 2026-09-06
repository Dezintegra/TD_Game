## ADDED Requirements

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
