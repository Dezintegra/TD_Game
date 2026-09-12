## MODIFIED Requirements

### Requirement: Explicit prerequisite metadata

The supervisor SHALL preserve optional `dependsOn` metadata containing complete task identifiers; absence SHALL mean no prerequisites. Optional `dependencyResults` SHALL contain objects with exactly `taskId`, `kind: "merged-pr"`, and a positive integer `pr`. Each `taskId` SHALL occur once and belong to `dependsOn`. Absence or an empty list SHALL preserve completion-only semantics. Card read/save and request-to-card creation SHALL preserve this contract, and the supervisor SHALL validate it before task admission regardless of the backlog storage implementation. Validation MUST NOT depend on the presence of a legacy file store or its schema. Unsupported kinds, malformed entries and references outside `dependsOn` MUST NOT silently become completion-only prerequisites. `links.related` MUST NOT supply prerequisites or expected results.

#### Scenario: Round trip

- **WHEN** a card is read and saved
- **THEN** its prerequisite identifiers remain unchanged
- **AND** its declared expected results remain unchanged

#### Scenario: Legacy card

- **WHEN** a card has only `dependsOn` or has no dependency metadata
- **THEN** its existing completion-only or dependency-free behavior is preserved

#### Scenario: Request carries expected result

- **WHEN** a valid request declares `dependsOn` and `dependencyResults`
- **THEN** the created card preserves both fields exactly

#### Scenario: Invalid result declaration

- **WHEN** a result uses an unsupported kind, a nonpositive or noninteger PR, an incomplete task identifier, a duplicate task identifier, extra fields, or a task outside `dependsOn`
- **THEN** it is reported as invalid and cannot permit a launch by dropping the result condition

#### Scenario: Trello contract after file-store removal

- **WHEN** the legacy file store and its schema are absent and Trello supplies cards or receives task requests
- **THEN** valid dependencyResults survive card read/save and request-to-card creation
- **AND** invalid declarations still prevent launches and are rejected in requests without relying on the removed schema

### Requirement: Gate task launches on completion

The supervisor MUST only launch a task when every prerequisite is confirmed in state `closed` and every declared expected result is satisfied. Missing, invalid, self-referencing or cyclic prerequisites SHALL block launching. Archived cards SHALL satisfy prerequisites only when confirmed in `closed`; archive membership alone SHALL prove neither completion nor a result.

For `merged-pr`, the predecessor's `links.pr` SHALL equal the declared PR, and GitHub evidence for that PR in the pipeline repository SHALL confirm `state: MERGED`, a nonempty valid `mergedAt`, and `baseRefName` equal to the configured main branch. An open PR, a PR closed without merge, completion of implementation, a different PR, an unconfirmed result or closure without the expected artifact MUST NOT satisfy this condition. Closure and merge are both required; merging before closure SHALL NOT release the task early.

#### Scenario: Waiting without spending attempts

- **WHEN** any prerequisite has not closed or any declared expected result is not satisfied
- **THEN** the task receives no start, continuation or attempt-limit failure action, its counters remain unchanged, and the cycle reports the blocking identifiers and unmet result conditions

#### Scenario: All prerequisites closed

- **WHEN** every prerequisite is closed and all declared expected results are confirmed, or no result conditions are declared
- **THEN** normal scheduling resumes on the next snapshot

#### Scenario: Blocked run and ready feature

- **WHEN** a run waits for a prerequisite or its expected result and a feature is ready
- **THEN** the blocked run does not prevent scheduling the feature

#### Scenario: Existing process

- **WHEN** a prerequisite or its expected result changes while a process is running
- **THEN** the supervisor does not interrupt the process or discard its report

#### Scenario: Closed predecessor without required merge

- **WHEN** a predecessor is closed but has no PR, names another PR, or its expected PR is open, closed without merge, or merged into another branch
- **THEN** the dependent task remains held and the diagnostic identifies the predecessor, expected PR and reason

#### Scenario: Merge is insufficient before closure

- **WHEN** the expected PR is confirmed merged but the predecessor remains in review, deploy or any state other than closed
- **THEN** the dependent task remains held

#### Scenario: Active stage frees its quota

- **WHEN** an implement task or another task needing a session has an unmet result condition and no live process or pending report
- **THEN** it keeps its stage and counters, receives no session, does not occupy engaged or exclusive capacity, and cannot enter a deployment batch

#### Scenario: Pending report is preserved

- **WHEN** a report already awaits transfer and the result condition is no longer confirmed
- **THEN** normal report transfer remains allowed and any subsequent session is gated on a new snapshot

#### Scenario: Archived predecessor

- **WHEN** a unique valid archived predecessor is confirmed closed, its PR matches the expectation and the merge is confirmed
- **THEN** it satisfies the same result condition as a nonarchived closed predecessor
- **AND** a missing, invalid or ambiguous archived record, including a duplicate across active and archived cards, cannot supply that proof

## ADDED Requirements

### Requirement: Result evidence is read without worker sessions

The supervisor SHALL gather expected-result evidence outside the pure scanner and provide it as an immutable cycle snapshot. Evidence SHALL be scoped to the repository, configured main branch and declared PR of the current snapshot. Missing evidence, command failure, timeout, malformed JSON or incomplete response SHALL mean an unconfirmed result, not success or a task failure. A later snapshot SHALL retry the check automatically. The read-only cycle command SHALL use the same evidence semantics as the live supervisor.

#### Scenario: GitHub unavailable

- **WHEN** a merge lookup fails or cannot establish all required fields
- **THEN** only tasks requiring that proof are held without attempts or failure transitions, unrelated work and report processing remain eligible, and the reason is visible in cycle notes

#### Scenario: One lookup serves several tasks

- **WHEN** several otherwise checkable dependencies require the same PR in a cycle
- **THEN** at most one bounded GitHub lookup supplies their common snapshot evidence
- **AND** a cycle with no result conditions performs no additional GitHub lookups

#### Scenario: Changed expectation and restart

- **WHEN** a card changes its expected PR or the supervisor restarts
- **THEN** scheduling uses evidence gathered for the current declarations; evidence for a previous PR cannot release the task
