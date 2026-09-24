## ADDED Requirements

### Requirement: Tool recovery retains verifiable merge work snapshots

For a stage assigned a Git worktree, infrastructure diagnosis and recovery SHALL retain versioned read-only work evidence bound to the task, launch, verified workspace and observation time. Evidence SHALL distinguish HEAD, branch, upstream, unpushed commits, present or proven absent MERGE_HEAD, index entries including conflict stages, and the identity and content fingerprints of staged, unstaged and untracked work. Failed, truncated, inconsistent or unsupported inspection SHALL be unknown, never equivalent to an empty or clean state. The first available snapshot and original report SHALL remain immutable; subsequent observations SHALL preserve their history in the existing report delivery store. Evidence collection MUST NOT reset, clean, stash, resolve or abort a merge, alter tracked work or disclose secret file contents.

#### Scenario: Conflict survives loss of command execution
- **WHEN** an assigned stage creates a conflicted merge and then loses command execution
- **THEN** available merge heads, index stages and work fingerprints are retained with the original launch and report, with unavailable portions explicitly unknown
- **AND** diagnosis and recovery do not discard conflict entries or modify working files

#### Scenario: Recovery inspection replaces neither history nor uncertainty
- **WHEN** a later inspection succeeds after an unavailable read or differs from the first recorded snapshot
- **THEN** both observations remain available with their identities and timestamps
- **AND** the later success does not retrospectively certify the unavailable state or erase the difference

#### Scenario: Absent merge head is distinguished from a failed read
- **WHEN** a merge-head query fails because the Git metadata cannot be read
- **THEN** merge state is unknown even if stdout is empty
- **AND** only a successful metadata inspection proving absence records no active merge

#### Scenario: Legacy envelope lacks conflict evidence
- **WHEN** a retained envelope predates the merge snapshot format
- **THEN** the original payload remains readable and preserved, and missing evidence is marked legacy or unknown without fabricated historical index contents

### Requirement: Worktree infrastructure retry verifies preserved effects before claim

Before claiming an infrastructure retry for a stage requiring a Git worktree, the supervisor SHALL require both fresh healthy tool diagnostics in the verified assigned context and a fresh complete inspection proving preservation of retained work. This SHALL extend the existing retry entitlement and report store, preserving all existing trust, budget, ownership, incident and one-time accounting constraints. Unknown, changed or mismatched workspace evidence SHALL retain the entitlement without spawning or consuming another continuation. A verified unchanged active merge SHALL be handed to the original stage for its prescribed handling, without a second merge or automatic abort by recovery. The replacement SHALL receive the original and current evidence and inspect work again before repeating effects. A known intervening operation SHALL require evidence of its identity and preservation of prior work; a clean status alone MUST NOT establish this.

#### Scenario: Healthy commands but unknown saved effects
- **WHEN** tool controls recover but the index, merge state or saved work cannot be verified
- **THEN** no replacement is claimed or spawned and the retained report and retry entitlement remain protected

#### Scenario: Same status hides changed conflict contents
- **WHEN** both observations show the same conflicted paths but an index stage or working-file fingerprint differs without an explained operation
- **THEN** the supervisor retains the retry with a mismatch diagnostic and does not overwrite the original evidence

#### Scenario: Preserved conflict is handed to the original stage
- **WHEN** fresh diagnostics are healthy and the complete snapshot proves that the assigned conflicted merge and other saved work are unchanged
- **THEN** the existing mechanism permits at most one replacement with both snapshots and explicit active-merge context
- **AND** repeated delivery or restart neither duplicates the replacement nor repeats continuation compensation

#### Scenario: Another worktree passed its controls
- **WHEN** controls succeed for a different workspace or unverified provider, environment or permission context
- **THEN** they do not authorize the affected assignment's replacement, even when host-side Git inspection succeeded

#### Scenario: Work changes before retry claim
- **WHEN** an external action changes the assigned branch, merge state or saved work between recovery and the final pre-claim inspection
- **THEN** the replacement remains held until the changed effects are explained and preservation is proven

#### Scenario: Repeated outage follows an earlier successful command
- **WHEN** a replacement or later stage loses tools after a successful operation and independent controls confirm another infrastructure stop
- **THEN** the existing mechanism retains that launch's original result and fresh work evidence, requires new recovery verification and settles only its own confirmed charge
- **AND** an ordinary failed test, policy denial or unsupported error claim does not acquire an infrastructure retry through work evidence alone
