# pipeline-readiness Specification

## Purpose
TBD - created by archiving change isolate-ssh-readiness. Update Purpose after archive.
## Requirements
### Requirement: Remote deploy failure does not stop local pipeline work

The supervisor SHALL distinguish verified local Codex prerequisites from remote SSH readiness. If local prerequisites succeed but SSH fails or is unproven, it SHALL keep running non-deploy tasks, SHALL hold new deploy sessions without charging an attempt, and SHALL log the remote reason. A local prerequisite failure SHALL retain the startup stop.

#### Scenario: Deploy host times out

- **WHEN** Git, GitHub, push dry-run and child-process commands succeed in Codex but SSH times out
- **THEN** non-deploy sessions remain eligible and deploy sessions remain held.

#### Scenario: Local child process fails

- **WHEN** SSH is unavailable and the local child-process command also fails or was never run
- **THEN** the supervisor does not declare local readiness and does not admit new sessions.

### Requirement: Deploy resumes only after fresh remote proof

The supervisor SHALL retry remote reachability while serving local work and SHALL release the deploy hold only after a successful SSH command in a fresh Codex probe. A failed retry SHALL keep the hold and name its reason without pausing unrelated work.

#### Scenario: SSH recovers

- **WHEN** a later direct SSH check and Codex SSH check both return the expected remote marker
- **THEN** deploy tasks become eligible on the next scan.
