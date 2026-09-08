## ADDED Requirements

### Requirement: Identify owner before process control

The launcher and watcher SHALL verify that the lock PID belongs to the
supervisor entry for the requested project before reporting live or stopping it.

#### Scenario: PID reused by Docker

- **WHEN** the lock PID belongs to Docker after reboot
- **THEN** launch is allowed and stop sends no signal to Docker.

#### Scenario: PID reused by another Node script

- **WHEN** the lock PID belongs to Node running another entry or project
- **THEN** it is not reported as the requested supervisor.

#### Scenario: Identity unavailable

- **WHEN** the process query fails, times out or lacks a command line
- **THEN** state is unknown and launch and stop fail with a diagnostic without spawning or killing.

#### Scenario: Confirmed supervisor

- **WHEN** the process command identifies the expected supervisor entry
- **THEN** the watcher reports it live and another launch does not spawn a duplicate.

#### Scenario: Owner changes before stop

- **WHEN** a second state query before stopping no longer confirms the same supervisor PID
- **THEN** no stop signal is sent.
