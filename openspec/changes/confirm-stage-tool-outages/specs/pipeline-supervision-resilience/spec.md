## ADDED Requirements

### Requirement: In-stage tool outages require independent confirmation

Before applying a failed report or charging another continuation for an unsuccessful completed live stage, the supervisor SHALL perform bounded independent diagnostics of required tool capabilities in the assigned provider, workspace, environment and permission context. Diagnostics SHALL distinguish confirmed-unavailable, healthy and inconclusive results using supervisor-selected control operations and structured execution evidence. Error prose, an agent claim, a task-local EPERM, test failure, missing tool events, zero permission denials or an earlier successful command MUST NOT independently establish or exclude an outage. A confirmed result SHALL require an observed failed control operation for a required capability; absent or malformed diagnostic evidence SHALL be inconclusive. Healthy or inconclusive diagnostics SHALL preserve ordinary report admission and task-failure handling, without granting an infrastructure retry. Successful stage reports SHALL retain their normal delivery path.

#### Scenario: Tool loss follows successful commands
- **WHEN** fetch and merge succeeded, later command execution fails, the session exits 0 with a failed report and no permission denials, and a control operation independently reproduces unavailability
- **THEN** the supervisor classifies the stop as infrastructure-confirmed before any failed transition or continuation exhaustion action

#### Scenario: Ordinary test failure or unconfirmed complaint
- **WHEN** a test fails or an agent reports EPERM but the required control operations succeed
- **THEN** the original result follows ordinary handling without infrastructure pause, refund or retry entitlement

#### Scenario: No diagnostic events
- **WHEN** diagnostics produce no verifiable execution evidence, regardless of what the agent claims
- **THEN** the verdict is inconclusive and does not certify a machine outage or grant an infrastructure retry

#### Scenario: Child process or deploy SSH fails
- **WHEN** a fixed child-process control or the assigned deploy host connection control produces structured failure in the stage context
- **THEN** the required capability is confirmed unavailable without parsing its error message
- **AND** an SSH failure outside a stage requiring that connection does not establish that stage's outage

### Requirement: Confirmed infrastructure stops retain the original stage result

The supervisor SHALL durably retain a confirmed stop in the report delivery store using the original launch identity, immutable report or explicit absence of a report, raw-result reference, diagnostic evidence, assigned batch, worktree, branch and revision context. Git evidence SHALL distinguish a known unpushed tail from unknown state when inspection is unavailable. The result SHALL be held before release for scheduling or terminal board effects. Existing machine pause SHALL stop new launches while allowing running stages to finish and persist results. Work and unpushed commits MUST NOT be removed, reset or treated as delivered work. Storage errors SHALL retain the in-memory result, block scheduling and report the error.

#### Scenario: Pause completion and restart
- **WHEN** a confirmed outage is persisted and the supervisor restarts while paused
- **THEN** the same launch, report, diagnostics, work and batch remain held with no terminal transition, lost-orphan compensation or competing launch

#### Scenario: Git cannot inspect the branch
- **WHEN** commands cannot report HEAD or remote ancestry during an outage
- **THEN** Git state is retained as unknown with available earlier revision evidence, and no cleanup or successful-delivery assumption follows

### Requirement: Infrastructure retry is settled once after recovery

After manual pause removal the supervisor SHALL require fresh successful diagnostics in the retained context before granting one retry of the same stage. A failed or inconclusive recovery probe SHALL retain the hold and reassert pause. Settlement SHALL use the report store's durable plan and recipient receipts, preserve actual usage and all unrelated attempt counters, and refund only the continuation actually charged to the affected launch, at most once. Initial launches SHALL receive no refund. The retry entitlement SHALL survive restart, bypass continuation exhaustion for its single replacement launch, and not charge that replacement as an additional continuation. Claiming the entitlement SHALL bind a new launch identity durably before spawning and SHALL prevent duplicate retries after an uncertain spawn or restart. Report trust, token-budget and ownership constraints SHALL still apply. The retry prompt SHALL contain the original result and work evidence and require inspection before repeating effects.

#### Scenario: Recovery and repeated delivery
- **WHEN** tools recover, pause is removed, and settlement is interrupted after a recipient write but before local acknowledgement
- **THEN** replay completes only missing effects, grants one replacement launch, preserves real usage, and does not repeat refunds or journal entries

#### Scenario: Initial launch and unrelated attempts
- **WHEN** a confirmed outage affected an initial launch while old attempts exist
- **THEN** those attempts remain unchanged and exactly one uncharged replacement launch is available

#### Scenario: Recovery not proved
- **WHEN** pause is removed but recovery diagnostics fail or lack evidence
- **THEN** no retry starts, the original result remains held and pause is reasserted

#### Scenario: Continuations exhausted while capacity is occupied
- **WHEN** ordinary continuations are exhausted and all process slots are occupied
- **THEN** an ordinary stage without an infrastructure hold or retry entitlement follows the existing exhaustion failure path regardless of occupied capacity
- **AND** a confirmed infrastructure-held stage remains held without exhaustion failure; after recovery its single replacement waits for capacity and exclusivity, starts once without another continuation charge, and consumes the entitlement

#### Scenario: Restart after retry spawn
- **WHEN** the replacement process started and the supervisor restarts before acknowledging the retry handoff
- **THEN** its persisted launch identity is adopted or reconciled and a second replacement is not spawned

### Requirement: Deploy outage recovery preserves the assigned batch

An infrastructure hold on deploy SHALL cover the original trusted lead, all assigned members and deployment revision. The failed report's deployed/excluded lists MUST NOT cause terminal batch effects while held. Recovery SHALL use the same batch and retained deployment evidence and SHALL inspect the remote revision and prior effects before any deployment command is repeated. Uncertain external state SHALL keep the batch held with a diagnostic. Already admitted successful reports and their partially delivered effects SHALL continue through normal report delivery, not a new deployment. Infrastructure diagnostics SHALL not reserve a fake live-stage slot or kill unrelated live work.

#### Scenario: SSH loss after possible publication
- **WHEN** deploy loses SSH after a command may have published the revision and diagnostics confirm connection failure
- **THEN** every assigned member stays protected and recovery verifies remote state before deciding which work remains
- **AND** an unavailable or ambiguous remote result retains the hold without blind redeployment or cleanup

#### Scenario: Successful deploy report is partially transferred
- **WHEN** a successful deploy report has pending member journal operations
- **THEN** delivery resumes from its receipts without running deploy again or merging new members into that batch

#### Scenario: Healthy tools do not establish the deployment effect
- **WHEN** deploy diagnostics are healthy and a retry entitlement exists but the remote revision and prior effects have not been verified
- **THEN** the assigned batch remains held and no replacement deploy process is spawned

#### Scenario: Infrastructure replacement retains its assignment despite new arrivals
- **WHEN** a confirmed deploy outage recovers, remote effects are verified, and a new higher-priority deploy task has arrived during the hold
- **THEN** the replacement receives the original trusted lead, every assigned member and retained deployment revision without rebuilding the batch, including after supervisor restart or when resuming without a report
- **AND** the new task waits for the next batch; an unknown original assignment keeps the replacement held

#### Scenario: Ordinary continuation still rebuilds its batch
- **WHEN** an interrupted deploy is continued without an infrastructure hold or retry entitlement
- **THEN** its batch is recalculated at session issuance under the existing eligibility and lead-selection rules
