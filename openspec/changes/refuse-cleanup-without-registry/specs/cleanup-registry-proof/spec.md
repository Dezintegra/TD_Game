## ADDED Requirements

### Requirement: Missing registry is not cleanup evidence

The supervisor MUST NOT complete or close a cleanup task when its registry entry is missing. It MUST preserve resources and report that the registry must be restored; unavailable PR state MUST remain retryable.

#### Scenario: Merged PR with missing entry
- **WHEN** the PR is merged and the registry entry is missing, including when branches remain
- **THEN** cleanup stops with a diagnostic and the task does not become completed

#### Scenario: No PR with missing entry
- **WHEN** a task without a PR has no registry entry
- **THEN** cleanup stops without closing the task or deleting resources

#### Scenario: PR unavailable
- **WHEN** a linked PR state is unknown
- **THEN** cleanup waits without completing or deleting resources

#### Scenario: Registered resources
- **WHEN** a valid registry entry exists and the existing safety checks pass
- **THEN** normal cleanup remains available and completion requires successful resource removal
