## ADDED Requirements

### Requirement: Reject permanent transfer failures without global starvation

The supervisor SHALL distinguish report-content rejection from transient storage failure. It SHALL preserve the full rejected report and reason before removing the report from its pending queue. It SHALL route the originating working task to postmortem, and a rejected postmortem to failed, without changing a predecessor or inventing completion.

#### Scenario: Invalid dependency while draining

- **WHEN** a blocked report names an invalid prerequisite and the supervisor is draining for self-update
- **THEN** the full report and validation reason are delivered to the originating task, that task moves to postmortem, and the report leaves the queue
- **AND** with no remaining reports or running stages self-update can restart

#### Scenario: Storage cannot save the rejection

- **WHEN** persisting the rejection or its journal fails
- **THEN** the report remains pending and is retried without changing the report into a successful result

#### Scenario: Partial persistence is retried

- **WHEN** the rejection transition was persisted but journal delivery was interrupted
- **THEN** the next transfer completes the outstanding journal delivery without repeating the transition, cost accounting, or already delivered journal parts

#### Scenario: Rejected postmortem

- **WHEN** postmortem supplies a report with a permanent content error
- **THEN** its full report is preserved and the task moves to failed without recursively starting another postmortem

#### Scenario: Large report

- **WHEN** the rejected report exceeds the card-description or single-comment text limit
- **THEN** the full JSON is delivered in journal parts before the transition, without storing the full report in the card description
- **AND** joining parts preserves long JSON strings without introducing line breaks inside them

#### Scenario: Repeated claim release

- **WHEN** removing the supervisor's assignment fails but a fresh card read confirms its member is already absent
- **THEN** release succeeds so an already applied report can leave the queue
- **AND** a failed read or a still assigned member preserves the original failure

#### Scenario: Source stage already changed

- **WHEN** a rejected report refers to an earlier stage than the current task
- **THEN** the rejection is preserved without rolling the task back to that stage

### Requirement: Identify pending work during self-update

Self-update waiting diagnostics SHALL identify the task and stage of pending reports and describe draining as waiting for current work to finish.

#### Scenario: One pending report

- **WHEN** self-update waits on report 0027 at triage
- **THEN** its wait message includes 0027 and triage alongside the pending count
