# task-completion Specification

## Purpose
Distinguish fulfilled task statements from decomposition and loss of relevance on the task board.
## Requirements
### Requirement: Distinct terminal outcomes

The supervisor SHALL use `completed` (Выполнено) only for fulfilled task statements and `closed` (Закрыто) for decomposition or loss of relevance. Both states SHALL be terminal, valid in storage and visible separately. Board setup SHALL create the completed list idempotently.

#### Scenario: Feature delivered

- **WHEN** a feature reaches cleanup with a verified merged PR and cleanup finishes
- **THEN** it transitions to completed, even if its worktree was already removed

#### Scenario: No evidence of merge

- **WHEN** cleanup has a PR whose merge cannot be confirmed
- **THEN** the task does not enter completed, even when no registry entry exists

#### Scenario: Administrative closure

- **WHEN** a feature is split or its subject is moot and cleanup finishes without a PR
- **THEN** it enters closed

#### Scenario: Run interpreted

- **WHEN** a run successfully finishes interpretation
- **THEN** it enters completed

#### Scenario: Note resolved or delegated

- **WHEN** triage finishes successfully
- **THEN** the note enters completed if resolved without new work requests, otherwise closed

#### Scenario: Historical closure

- **WHEN** the new list is introduced
- **THEN** old closed cards are not automatically declared completed

#### Scenario: Moot note

- **WHEN** triage confirms loss of relevance with a moot outcome and nonempty evidence
- **THEN** the note enters closed, and missing evidence blocks that transition

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

### Requirement: New completions appear first

The Trello backlog SHALL place a card at the top of the completed list when saving a transition into that list. It SHALL preserve the position of a card already in the completed list. It SHALL keep existing positioning rules for other lists.

#### Scenario: Newly fulfilled task

- **WHEN** a feature, run or note moves from its working list into completed
- **THEN** the existing card update also places it at the top of completed
- **AND** no separate positioning request is needed

#### Scenario: Already completed card

- **WHEN** a card already in completed is saved again, including with an old transition entry or a blocking flag
- **THEN** the save does not change its position

#### Scenario: Retry after comment failure

- **WHEN** moving into completed succeeds but writing the journal fails
- **THEN** a retry in the same adapter or with a refreshed snapshot preserves the position

#### Scenario: Retry after move failure

- **WHEN** the update moving a card into completed fails
- **THEN** retrying the transition still requests the top position

#### Scenario: Other lists

- **WHEN** a task is saved outside completed
- **THEN** existing positioning rules, including precedence for blocking work, remain unchanged

