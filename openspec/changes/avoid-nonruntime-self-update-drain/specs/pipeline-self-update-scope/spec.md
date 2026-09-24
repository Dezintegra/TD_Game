## ADDED Requirements

### Requirement: Self-update drains only for changes relevant to the running supervisor

The supervisor SHALL continue admitting eligible work without draining when every committed change since its loaded `supervisor/` tree is in the explicitly classified non-runtime set: `README.md`, `permission-diagnostics.md`, `skills/*.md`, `*.test.mjs`, or `configure-watchdog-power.ps1`. It SHALL keep checking and fast-forwarding new remote changes while in that state. A changed runtime or unknown path, or an unavailable or inconsistent tree difference, SHALL retain the existing safe drain and restart behavior.

#### Scenario: Documentation and scheduler helper change while a stage runs

- **WHEN** only `README.md` and `configure-watchdog-power.ps1` changed after startup and one stage is live
- **THEN** the supervisor continues scheduling eligible work without waiting for that stage to finish.

#### Scenario: Further runtime change after a documentation-only update

- **WHEN** the supervisor has skipped a restart for a documentation change and later fast-forwards a commit changing `lib/self-update.mjs`
- **THEN** it waits for a safe quiet moment and restarts before issuing new work with stale runtime code.

#### Scenario: Unknown or unavailable difference

- **WHEN** tree hashes differ and the changed paths cannot be read reliably or contain an unknown path
- **THEN** the supervisor uses the existing drain and restart path.

#### Scenario: Runtime file renamed into documentation

- **WHEN** a runtime file is removed and a document is added in the same tree update
- **THEN** both paths are considered and the removal still requires a restart.
