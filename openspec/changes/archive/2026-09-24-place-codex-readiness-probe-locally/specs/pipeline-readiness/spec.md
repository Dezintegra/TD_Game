## ADDED Requirements

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
