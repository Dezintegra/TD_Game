## ADDED Requirements

### Requirement: Explicit Windows execution settings
Codex execution on Windows SHALL select an explicit supported sandbox implementation and scope Git safe directories to the assigned workspace and main repository only.

#### Scenario: User config ignored
- **WHEN** Codex starts without personal configuration
- **THEN** its Windows sandbox remains enabled and Git trusts only the designated directories without global changes or wildcard exceptions

### Requirement: Startup proves command execution
The supervisor SHALL verify a real read-only Git command through the Codex execution adapter before assigning tasks.

#### Scenario: Probe succeeds
- **WHEN** the CLI reports a successful Git command with the expected output and successful turn and exit
- **THEN** the supervisor may start its first cycle

#### Scenario: Command unavailable
- **WHEN** the probe is denied, fails, times out or returns text without successful command evidence
- **THEN** no tasks are assigned and the failure is logged clearly

### Requirement: Visible policy refusals
The supervisor SHALL record declined Codex commands as denials and pause new stage starts after a policy refusal.

#### Scenario: Policy blocks a stage
- **WHEN** a command_execution event has declined status
- **THEN** the command and reason appear in the report diagnostics, the pause is persisted and subsequent stages are not started

### Requirement: GitHub authentication readiness
The supervisor SHALL pass existing GitHub authentication to Codex through child process environment only and verify authenticated GitHub API access before assigning tasks.

#### Scenario: Separate sandbox user
- **WHEN** the sandbox account cannot access the owner account credentials
- **THEN** the supervisor obtains the existing GitHub token without logging or persisting it and supplies GH_TOKEN to the child while excluding unrelated secret-named variables

#### Scenario: Invalid GitHub authentication
- **WHEN** the authenticated GitHub probe fails
- **THEN** the supervisor starts no tasks and reports the startup failure
