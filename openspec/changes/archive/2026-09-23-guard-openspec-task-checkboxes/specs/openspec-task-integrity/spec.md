## ADDED Requirements

### Requirement: Numbered implementation steps remain visible to OpenSpec

The pipeline SHALL keep every numbered implementation step in an OpenSpec `tasks.md` as an unchecked checkbox until its stated work and verification are complete. It MUST NOT turn an unfinished step into ordinary prose or another Markdown list form to obtain an `all_done` status.

#### Scenario: Unfinished step is restated as prose

- **WHEN** a change contains an unfinished numbered step such as `2.1` written without a checkbox
- **THEN** design and audit identify the missing checkbox, and implementation or review does not treat that step as complete

#### Scenario: Step is actually complete

- **WHEN** a numbered step has its deliverable and stated verification recorded in the change
- **THEN** implementation may mark its checkbox complete in the same atomic commit

### Requirement: Artifact status is not delivery evidence

The pipeline SHALL interpret `openspec status` as the state of planning artifacts, not as proof that implementation, tests, build, delivery, or an alternate technical outcome satisfy the task. Before a `done` report, implementation and review SHALL compare the original task scope, the entire `tasks.md`, and the actual artifacts or confirmed barrier evidence.

#### Scenario: OpenSpec reports all_done without a package

- **WHEN** `openspec status` reports `all_done` but required deliverables remain absent
- **THEN** the pipeline keeps the task unfinished and names the missing deliverables

#### Scenario: Alternate technical outcome

- **WHEN** a task permits an alternate result for a technical barrier
- **THEN** the pipeline accepts it only when the barrier is confirmed against all authorized routes and the unfulfilled original scope remains explicit
