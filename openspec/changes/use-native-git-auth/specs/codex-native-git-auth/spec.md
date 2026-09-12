## ADDED Requirements

### Requirement: Native GitHub authorization
Codex Git commands SHALL authenticate to GitHub using process-local HTTP configuration without a shell credential helper. Credentials SHALL remain in the child environment only; they SHALL NOT appear in command arguments, prompts, configuration files or diagnostic output. Git trust SHALL remain limited to the main and assigned worktrees.

#### Scenario: Windows shell unavailable
- **WHEN** MSYS sh.exe cannot start but native Git and GitHub are available
- **THEN** Git authentication does not require sh.exe

#### Scenario: Concurrent worktrees
- **WHEN** two Codex stages use different worktrees
- **THEN** their Git configuration is independent and the shared input environment is unchanged

### Requirement: Verify Git push readiness
Before assignment the Codex supervisor SHALL require a successful git push --dry-run to the configured remote in addition to Git, GitHub and SSH checks.

#### Scenario: Push cannot authenticate
- **WHEN** GitHub API authentication succeeds but dry-run Git push fails
- **THEN** readiness fails before assigning any task and preserves the command error

#### Scenario: Push succeeds
- **WHEN** dry-run push and the other checks complete successfully
- **THEN** startup can continue and the remote refs remain unchanged by the probe
