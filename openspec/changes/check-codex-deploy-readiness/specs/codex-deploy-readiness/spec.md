## ADDED Requirements

### Requirement: SSH readiness before assignment
The Codex supervisor SHALL prove SSH connectivity to TD_DEPLOY_HOST (default dezintegra) from its execution environment before assigning tasks, in addition to Git and GitHub checks. The probe SHALL use noninteractive authentication, a bounded connection timeout and strict host-key checking without changing the server or credentials.

#### Scenario: Successful connection
- **WHEN** a completed SSH command to the configured target returns exit code zero and the expected remote marker, and all existing checks succeed
- **THEN** startup may continue

#### Scenario: Missing SSH environment
- **WHEN** SSH fails to resolve the target, authenticate, verify its host key or execute the probe
- **THEN** readiness fails with the command error and no task is assigned

#### Scenario: Missing evidence
- **WHEN** the agent returns success text without the successful SSH command evidence
- **THEN** readiness fails even if Git and GitHub checks succeeded
