## ADDED Requirements

### Requirement: Recovery none regression proves its cause and complete effects

The report-recovery regression suite SHALL retain a no-injected-failure scenario through the supervisor, durable queue and Trello adapter with an isolated local recipient reopened after pause and restart. A failure SHALL expose its original reason and boundary context sufficient to distinguish fixture lifecycle or storage failures from delivery failures. A correction of this scenario SHALL be supported by diagnostic reproduction or a concrete causal code chain and a regression exercising the established condition. The suite MUST NOT hide failures with automatic test retries or weaken delivery assertions to obtain a passing run.

#### Scenario: Delivery succeeds after pause and restart
- **WHEN** implement completes while paused with initial spentUsd 4 and report cost 3, the accepted report is persisted, and supervisor and local recipient are reopened before pause is removed
- **THEN** pause causes no recipient mutations and the first delivery after removing pause returns done, moves the task to pr, records spentUsd 7 and resets continuations to 0
- **AND** the test verifies one transition PUT, one complete expected journal comment, an empty pending queue and no new session for the completed implement launch

#### Scenario: Another restart follows acknowledgement
- **WHEN** supervisor, queue and local recipient are reopened again after successful delivery
- **THEN** the regression verifies unchanged recipient state and accounting, no pending report or transfer-report action and no planned relaunch of the completed implement stage
- **AND** the stage spawn count remains one

#### Scenario: None unexpectedly returns failed
- **WHEN** the no-injected-failure delivery returns failed
- **THEN** the test fails on that first result and preserves its original why together with the scenario phase, queue progress and recipient calls/effects available at failure
- **AND** a later passing execution is not accepted as evidence of a correction

#### Scenario: Established cause is guarded
- **WHEN** a fixture or delivery correction is validated
- **THEN** a controlled regression exercises the established causal condition and fails with the previous behavior at that boundary but passes with the correction
- **AND** the saved investigation identifies the revision, cause, responsible layer and diagnostic reproduction or causal code chain, while the no-injected-failure and partial-failure delivery checks retain their assertions
