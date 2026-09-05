## ADDED Requirements

### Requirement: Consistent SSH configuration

The pipeline SHALL use the optional absolute `TD_DEPLOY_SSH_CONFIG` path for readiness, remote commands and deployment SSH/SCP without exposing private key contents.

#### Scenario: Explicit config with spaces

- **WHEN** the environment supplies an absolute configuration path containing spaces
- **THEN** SSH and SCP receive the complete path as one argument after `-F`

#### Scenario: Default environment

- **WHEN** no explicit configuration is supplied
- **THEN** OpenSSH uses its standard configuration for both providers

#### Scenario: Invalid explicit configuration

- **WHEN** the configured path is relative or the file cannot be read
- **THEN** the operation fails without silently using another identity

### Requirement: Verified readiness

Codex readiness SHALL require a successful actual remote command through the same configured SSH client in addition to Git, GitHub, dry-run push and Node child process checks.

#### Scenario: Text without execution

- **WHEN** an agent claims successful access without successful command execution
- **THEN** startup remains blocked
