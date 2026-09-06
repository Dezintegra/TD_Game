# pipeline-supervision-resilience Specification

## Purpose
TBD - created by archiving change repair-pipeline-blockers. Update Purpose after archive.
## Requirements
### Requirement: Live work controls scheduler exclusion
The supervisor SHALL reserve a concurrency slot and deploy exclusivity only for
a task with a live tracked stage process. A held task rejected solely because
its token accounting is incomplete SHALL not prevent new work; a live deploy
SHALL still prevent parallel work regardless of its accounting status.

#### Scenario: Held legacy deploy has no live process
- **WHEN** a deploy task is held for `legacy-unknown` accounting and has no live tracked process
- **THEN** the scheduler selects eligible work up to the available concurrency limit.

#### Scenario: Live deploy has incomplete accounting
- **WHEN** a deploy task has a live tracked process and incomplete accounting
- **THEN** the scheduler selects no parallel task.

### Requirement: Provider switches preserve accounting
The supervisor SHALL load and retain a valid Codex token ledger on startup and
orphan adoption regardless of the current selected provider.

#### Scenario: Claude provider adopts Codex orphan
- **WHEN** Claude is the current provider and orphan adoption runs
- **THEN** unrelated Codex ledger tasks remain in the persisted ledger.

### Requirement: Prompt journal favors current operator context
The stage prompt SHALL retain newest complete journal entries within its
existing journal limit and SHALL visibly mark omitted earlier history.

#### Scenario: Fresh verdict follows an oversized journal
- **WHEN** older history exceeds the limit and a newest P1 review and owner response fit within it
- **THEN** both newest entries appear untruncated after an omission marker.

### Requirement: Windows readiness includes sandbox warmup
The stage-model readiness test SHALL model configured Windows sandbox warmup
before asserting readiness commands.

#### Scenario: Warmup command precedes readiness command
- **WHEN** the Windows readiness test simulates a fresh sandbox
- **THEN** its mock accepts the warmup and subsequent readiness command.

