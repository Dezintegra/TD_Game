## ADDED Requirements

### Requirement: Codex token snapshots are reconciled durably
The supervisor SHALL interpret the supported Codex CLI cumulative thread snapshots consistently in the adapter and persistent task ledger. It SHALL count input plus output, with cached input counted once, across every completed turn and resumed run. It MUST NOT sum cumulative snapshots or infer a counter reset solely from a smaller value. Known token totals and consumption completeness SHALL survive restarts, stage changes and forgotten provider sessions.

#### Scenario: Multiple completed turns
- **WHEN** one thread reports input/output snapshots 1000/100 and 1600/140 in different completed turns
- **THEN** its known contribution is 1740, not 2840, and cached input is not added again

#### Scenario: Resume with a comparable snapshot
- **WHEN** a resumed thread previously persisted 1600/140 and now reports 2000/180
- **THEN** its task contribution becomes 2180 and the known run consumption is 440 regardless of whether stage-session memory was removed

#### Scenario: Smaller usage after resume
- **WHEN** a new observation reports 500/40 after persisted 1600/140 for the same thread
- **THEN** the ledger retains at least 1740 known tokens, marks consumption incomplete and reports current run usage as unknown without subtracting a negative amount or adding 540 as proven new spending

#### Scenario: Replayed observations and repeated finish
- **WHEN** an already recorded stream is processed again by finish or after restart with its original launch identity
- **THEN** known totals and completeness are unchanged and an older observation in that replay is not diagnosed as a new counter decrease

#### Scenario: Equal values in different turns
- **WHEN** two distinct turns of the same thread report the same cumulative snapshot
- **THEN** both observations are recognised without an extra token charge or a fabricated reset

#### Scenario: Failure after known consumption
- **WHEN** valid usage precedes a failed exit, invalid report or interrupted later turn
- **THEN** the known contribution remains persisted and any unreported tail is explicitly incomplete

#### Scenario: Unknown or malformed usage
- **WHEN** a born run lacks usable usage, session identity or safe nonnegative input/output counts
- **THEN** previous known totals remain and incompleteness is persisted instead of recording zero consumption

#### Scenario: Durable idempotency
- **WHEN** saving an observation fails and the same observation is retried
- **THEN** it can still be persisted exactly once and no ordinary budget-controlled launch proceeds on a falsely successful write

#### Scenario: Existing ledger format
- **WHEN** the old task-to-session numeric ledger is loaded
- **THEN** every recorded amount is preserved as a known lower bound, missing historical completeness is marked legacy-unknown, and later cumulative snapshots are not added to that amount as separate spending

#### Scenario: Budget after restart and forgotten sessions
- **WHEN** a task has reached the configured known token limit and the supervisor restarts, changes stages or forgets its resume session
- **THEN** the existing budget transition to decompose and its existing exceptions remain effective

#### Scenario: Incomplete budget below the limit
- **WHEN** a task has unknown consumption below the known limit and token enforcement is enabled
- **THEN** no ordinary stage is launched on an assumed remaining budget, the reason is exposed and no launch attempt is spent

#### Scenario: Disabled token limit
- **WHEN** enforcement is disabled for a task with incomplete consumption
- **THEN** known totals and unknown status remain recorded without a token-based launch block

#### Scenario: Independent new thread
- **WHEN** a new thread reports 300/20 for a task whose other thread contributes 1740
- **THEN** the known task total is 2060 and the old thread record remains after session forgetting
