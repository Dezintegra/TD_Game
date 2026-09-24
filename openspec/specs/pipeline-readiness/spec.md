# pipeline-readiness Specification

## Purpose

Проверять реальные локальные возможности Codex перед выдачей задач, сохраняя работу независимых этапов при отказе удалённого SSH и доступность стартовой пробы в штатной Windows-песочнице.

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

### Requirement: Windows Codex readiness probes use pipeline-local workspace

On Windows the supervisor SHALL create its Codex readiness probe workspace under the configured local pipeline directory inside the repository, after preparing the root sandbox. It SHALL verify actual Git, GitHub, child-process and SSH commands in that workspace before admitting work. It MUST NOT treat a successful probe in another login context as proof for the scheduled supervisor. It SHALL remove the probe script and an empty child workspace after the check, and SHALL retain the startup stop with a diagnostic if local access fails. Other platforms SHALL retain their existing temporary workspace location.

#### Scenario: Scheduled startup after reboot

- **WHEN** the scheduled Windows supervisor starts after reboot and its user Temp rejects Codex command execution but the pipeline-local workspace is accessible
- **THEN** the full readiness probe succeeds from the pipeline-local workspace and eligible work can resume.

#### Scenario: Pipeline-local workspace is unavailable

- **WHEN** the Windows supervisor cannot create or execute its pipeline-local readiness workspace
- **THEN** it reports the local failure and admits no new stages.

#### Scenario: Probe cleanup

- **WHEN** the readiness probe finishes or its command fails
- **THEN** the probe script and empty child workspace are removed without deleting the pipeline-local parent.
