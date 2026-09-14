## ADDED Requirements

### Requirement: Stale review and workspace state is reconciled from evidence

The supervisor MUST include review in bounded merged-PR reconciliation. It MUST preserve game release obligations and ownership records, and MUST validate the actual directory and branch before launching a stage requiring a worktree. A missing directory MUST NOT be treated as an ordinary model launch failure or repaired by silently replacing existing work with an empty branch. Service-only classification MAY include the historic pipeline directory and root package changes proven to affect only supervisor script entries.

#### Scenario: Historical service PR is already merged

- **WHEN** a review card references a merged service PR and its worktree directory is absent
- **THEN** reconciliation moves the card to cleanup without launching review or recreating the directory
- **AND** the ownership record remains available for safe cleanup

#### Scenario: Mixed or unconfirmed package changes

- **WHEN** a merged PR changes package dependencies, game scripts, or an unavailable package document
- **THEN** reconciliation preserves normal game release obligations

#### Scenario: Missing directory for unfinished work

- **WHEN** a worktree stage has a stale registry path
- **THEN** the supervisor validates an existing checkout or restores only a proven existing branch
- **AND** without such evidence it reports the local workspace problem without consuming a model continuation

#### Scenario: Budget hold outlives a service merge

- **WHEN** a card is in token-limit and fresh evidence proves its PR is merged and service-only
- **THEN** the supervisor SHALL permit only administrative cleanup without creating a model process or changing usage and limits
- **AND** an open, unknown or game-affecting PR SHALL retain its budget hold

### Requirement: Cycle status reports actual process creation

The supervisor MUST distinguish planned actions, completed service actions, skipped actions, failures and actually spawned processes. A process that was created before a later persistence failure MUST still be counted. Reusing a recorded launch without creating a process MUST NOT increment the count. Local action and repair exceptions MUST NOT prevent independent actions from being considered.

#### Scenario: All proposed launches fail

- **WHEN** the planner proposes stages but no child process is created
- **THEN** the cycle summary reports zero launches and the failures, without claiming work was issued

#### Scenario: Card persistence fails after spawn

- **WHEN** a child process is created but its subsequent card write fails
- **THEN** the summary reports one launch and the persistence failure
