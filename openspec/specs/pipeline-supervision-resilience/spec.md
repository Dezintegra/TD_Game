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

### Requirement: Exclusive continuation reserves a whole scheduler cycle
When no exclusive process is live, the scheduler SHALL select at most one
eligible local benchmark or deploy continuation, choosing priority then age,
and SHALL not issue ordinary continuations in that cycle. A foreign-hardware
benchmark is not a local exclusive. Held or dependency-blocked deploy work
does not reserve this cycle.

#### Scenario: Two idle local exclusives
- **WHEN** two eligible local-exclusive continuations exist and capacity is two or more
- **THEN** only the priority/age winner receives a continuation.

#### Scenario: Batch deploy competes with a local benchmark
- **WHEN** an eligible deploy batch and a local benchmark are idle
- **THEN** only the batch lead is continued, with its complete batch list.

### Requirement: Provider switches preserve accounting
The supervisor SHALL load and retain a valid Codex token ledger on startup and
orphan adoption regardless of the current selected provider.

#### Scenario: Claude provider adopts Codex orphan
- **WHEN** Claude is the current provider and orphan adoption runs
- **THEN** unrelated Codex ledger tasks remain in the persisted ledger.

### Requirement: Startup reads runtime state after lock ownership
The supervisor SHALL acquire the common startup/recovery lock guard and its
long-lived supervisor lock before constructing stateful runtime services or
reading stages and the Codex ledger. A failed claim SHALL not read or write
those runtime stores.

#### Scenario: Recovery preceded startup
- **WHEN** recovery applies and releases the common guard before startup claims ownership
- **THEN** startup constructs its supervisor from the ledger and stages present after ownership.

### Requirement: Prompt journal favors current operator context
The stage prompt SHALL retain newest complete journal entries within its
existing journal limit and SHALL visibly mark omitted earlier history.

#### Scenario: Fresh verdict follows an oversized journal
- **WHEN** older history exceeds the limit and a newest P1 review and owner response fit within it
- **THEN** both newest entries appear untruncated after an omission marker.

#### Scenario: Newest entry alone exceeds the limit
- **WHEN** the final journal line is longer than the available tail room
- **THEN** its bounded suffix remains visible after the omission marker.

### Requirement: Windows readiness includes sandbox warmup
The stage-model readiness test SHALL model configured Windows sandbox warmup
before asserting readiness commands.

#### Scenario: Warmup command precedes readiness command
- **WHEN** the Windows readiness test simulates a fresh sandbox
- **THEN** its mock accepts the warmup and subsequent readiness command.

### Requirement: Bounded reconciliation makes progress toward incident repairs

The supervisor SHALL exclude active incident sources and tasks with an undelivered delay journal before selecting PR reconciliation reads. It SHALL prioritize eligible incident repairs and their prerequisite tasks, using the same incident policy and archived dependency records as scheduling. Within each group it SHALL select never-checked current PRs first, then the oldest persisted check. Equal checks SHALL retain board order. The existing maximum of two reads per cycle and exclusion of live work, foreign owners and pending report participants SHALL remain.

#### Scenario: Incident sources precede an urgent repair

- **WHEN** incident sources and unrelated stale PRs precede a repair waiting for reconciliation
- **THEN** sources consume no reads and the repair is selected before unrelated work

#### Scenario: Repeated cycles advance beyond the beginning of the board

- **WHEN** more tasks need checking than fit in a cycle and successful checks are persisted between cycles
- **THEN** the next cycle selects the oldest or never-checked remaining tasks even after earlier checks become due again

#### Scenario: Repair reaches its early budget analysis

- **WHEN** an eligible repair has reached the early token threshold and its fresh reconciliation confirms an open PR
- **THEN** the next scan admits its budget analysis without requiring another PR check or treating the incident as resolved

#### Scenario: Protected repair is unavailable

- **WHEN** a repair is live, owned by another station, awaiting report delivery or has an undelivered delay journal
- **THEN** it consumes no reconciliation slot and its state remains unchanged
