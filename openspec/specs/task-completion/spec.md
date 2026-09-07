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


