## ADDED Requirements

### Requirement: Explicit closure explanation

The supervisor SHALL publish a comment headed «Причина закрытия» before moving a task into closed. The explanation MUST name the concrete reason for stopping the original work, include evidence for moot outcomes, and identify actual successor tasks for delegated or split work. Cleanup details alone MUST NOT count as a closure reason.

#### Scenario: Subject removed before cleanup

- **WHEN** design returns moot with a nonempty summary and evidence
- **THEN** the supervisor persists that explanation through storage and includes it in the final closure comment after cleanup

#### Scenario: Work delegated or split

- **WHEN** triage delegates work or decompose splits it
- **THEN** the closure comment explains the decision and lists the actual created task identifiers with links to their cards on Trello

#### Scenario: Reason missing

- **WHEN** a closing report lacks a nonempty summary, or cleanup cannot recover its original reason
- **THEN** the supervisor refuses closure and reports the missing explanation

#### Scenario: Comment publication fails

- **WHEN** any part of the closure comment fails to publish
- **THEN** the card remains in its previous list

#### Scenario: Retry after partial publication or failed move

- **WHEN** closure is retried after some or all comment parts were saved
- **THEN** previously published identical parts are not duplicated and the card moves only after all parts are present
- **AND** retrying the closing report reuses its previously created successor cards

#### Scenario: Historical cards

- **WHEN** existing closed cards receive retrospective explanations
- **THEN** each explanation cites its historical basis, names concrete successor cards when applicable, explicitly identifies missing evidence, and leaves existing comments, descriptions and lists unchanged
