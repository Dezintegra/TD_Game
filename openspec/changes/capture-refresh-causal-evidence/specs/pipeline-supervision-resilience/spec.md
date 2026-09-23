## ADDED Requirements

### Requirement: Refresh diagnostics preserve context before tool execution

The existing tool diagnostic mechanism SHALL support an explicitly selected Windows refresh investigation mode that durably records a versioned, non-secret launch manifest before allowing the first diagnostic tool invocation. The manifest SHALL identify the diagnostic and source task, host, launch, requested provider invocation, workspace and target paths, source/configuration fingerprints, observation plan and finite execution budget. Observed process, effective profile, helper and target-security evidence SHALL be distinguished from requested configuration and bound to the same launch before its first command where observable. Unavailable fields SHALL carry an explicit reason and observation time, never an inferred value. Failure to persist the initial manifest SHALL prevent the diagnostic launch. This mode MUST NOT silently replace or weaken ordinary outage confirmation.

#### Scenario: First command cannot be created
- **WHEN** refresh fails before the first requested read process is created
- **THEN** the pre-command manifest remains readable and the recorded attempt is linked to its launch, actual available host observations and failure evidence
- **AND** no child PID, exit code or successful command is invented

#### Scenario: Initial storage is unavailable
- **WHEN** durable creation of the investigation manifest fails
- **THEN** no diagnostic session starts and the storage failure is reported without overwriting an earlier record

#### Scenario: Requested profile differs from observed profile
- **WHEN** observed execution metadata differs from the requested profile, helper or target path
- **THEN** both values and their sources are retained and causal acceptance fails until the discrepancy is explained by evidence

### Requirement: Refresh sequences retain one-session execution provenance

The investigation SHALL correlate a bounded ordered sequence of fixed read and read-only Git operations with provider session identity, launch identity, invocation identities, ordered tool events and observed refresh events. It SHALL preserve each completed observation incrementally, including errors, timeout, interruption and missing results, without relying on an agent's final narrative. Separate launches or resumed processes MUST NOT be represented as one uninterrupted process. A command invocation MUST NOT be assumed to prove that a refresh occurred. Original records SHALL remain immutable; verified host supplements SHALL be appended with absolute paths, SHA-256, timestamps and primary-record locations.

#### Scenario: Later refresh fails after successful read and Git
- **WHEN** a single diagnostic session successfully reads a file and runs Git, then a subsequent invocation fails during refresh
- **THEN** the successes and failure retain the same verified session identity, their distinct invocation identities and available refresh process and target observations
- **AND** earlier successful commands do not erase or disprove the later failure

#### Scenario: Separate sessions are mixed
- **WHEN** a proposed sequence combines successful results from different session identities or cannot correlate refresh with a tool invocation
- **THEN** the sequence is rejected as evidence of continuous same-session refresh behavior and its raw observations remain available

#### Scenario: Collection is interrupted
- **WHEN** the process exits or exceeds its budget before all planned operations complete
- **THEN** already persisted observations remain recoverable, missing operations remain explicit, and replay does not automatically launch new probes or overwrite that run

### Requirement: Causal refresh evidence has an explicit completeness and comparison gate

The evidence checker SHALL separately report integrity, capture completeness and causal sufficiency. It SHALL verify launch and process identity including creation time, actual profile and helper identity/version, target real path and available security context including refresh-token relevance to ACL access, temporal ordering, primary record hashes and the declared control's comparability. A missing indispensable observation SHALL prevent a complete verdict. A contemporary causal result SHALL require either evidence supporting a repair while addressing competing explanations, or a concrete discriminating experiment justified by contemporary primary observations, with named hypotheses, a controlled variable, invariants, differing predicted outcomes, finite budget and decision rule. An isolated success, a generic list of unknowns, current ACLs substituted for historical ACLs, or test fixtures presented as live evidence MUST NOT satisfy this gate.

#### Scenario: Evidence file has been changed
- **WHEN** a primary file no longer matches its recorded SHA-256 or an observation refers to a different process creation time
- **THEN** integrity fails and no complete or causally sufficient result is produced

#### Scenario: All commands pass but competing causes remain
- **WHEN** commands succeed and the material merely lists absent token/helper/ACL observations
- **THEN** causal sufficiency is false, regardless of a healthy availability verdict

#### Scenario: Contemporary observations justify a bounded discriminating experiment
- **WHEN** verified same-session observations and a suitable control establish the relevant identities and isolate a remaining pair of hypotheses with different predicted outcomes under a specified permitted experiment
- **THEN** the handoff includes the primary references, controlled variable, invariants, predictions, observation method, budget and rejection conditions
- **AND** it reports an experiment justified, not a cause repaired or an incident verified

### Requirement: Host refresh observation preserves existing security and incident boundaries

Unavailable executor observations SHALL be collected only by the ordinary authorized Windows host through a documented read-only observation route using the same evidence contract. Neither the executor nor that route SHALL change ACLs, ownership, permission profiles or privileges as a proposed repair, impersonate a user, bypass a denial or replay the source audit. Supervisor ownership transfer SHALL be permitted only for an explicitly authorized bounded diagnostic window operated by the Windows host after the tooling is prepared, checked and pushed at a pinned source revision. The executor MUST NOT stop its supervisor. Evidence SHALL exclude secret stores, credentials and full environments. Successful collection SHALL NOT settle an outage hold, alter incident state, grant a retry or substitute for the source stage's incidentVerification. Existing report retention, accounting and incident mechanisms SHALL remain the sole owners of those effects.

The diagnostic owner SHALL confirm the previous owner's exit and acquire the existing startup/recovery guard and supervisor lock before reading runtime stores. It SHALL use the existing budget admission and launch accounting functions with the current shared ledger, persist each launch before spawn and its observed usage before the next launch or normal ownership release. It MUST NOT use a separate ledger, empty accounting callbacks or a stale task/configuration snapshot to bypass admission. Unresolved persistence failure SHALL prevent normal release and further probes; interrupted accounting SHALL remain recoverable under the original launch identity without replaying probes. Return to the ordinary supervisor SHALL preserve usage, retained reports, pauses and incident state.

#### Scenario: Another owner still holds the lock
- **WHEN** the production host route encounters a live or indeterminate owner or cannot acquire the common guard
- **THEN** it refuses collection before runtime reads, ledger writes or model spawn and does not kill the owner or remove its lock

#### Scenario: Budget refuses a diagnostic launch
- **WHEN** the production composition loads the shared ledger after ownership and existing admission rejects the assigned task and stage
- **THEN** no diagnostic process starts, the bundle records not-run, and neither limits nor usage are reset

#### Scenario: Usage cannot be persisted
- **WHEN** a diagnostic process has returned but saving its usage fails
- **THEN** the owner retains the result and pending launch identity, starts no next probe, reports the exact storage failure and does not advertise safe release or completed collection
- **AND** retrying persistence under ownership uses the same launch identity without double charging or rerunning the probe

#### Scenario: Host window is interrupted
- **WHEN** cancellation arrives after a probe started or the diagnostic owner exits unexpectedly
- **THEN** graceful cancellation stops only its own probes and persists their partial results and accounting before releasing its lock
- **AND** an abrupt exit leaves the durable pending launch and primary results for existing accounting recovery; a restarted collector does not replay the collection or report unobserved usage as zero

#### Scenario: Ordinary supervision returns after collection
- **WHEN** the host has confirmed probe exit, persisted usage and diagnostic-owner exit
- **THEN** the ordinary supervisor reacquires the existing locks and reads the updated ledger with unrelated records and retained reports intact
- **AND** the authorized handoff does not change the source audit or authorize another incident verification attempt

#### Scenario: Executor cannot inspect refresh token
- **WHEN** the executor cannot read the relevant process security metadata
- **THEN** it records the limitation and requests only the missing observation from the ordinary host through the existing prerequisite workflow
- **AND** it does not retry with elevated privileges or label the host's own token as the refresh token

#### Scenario: Diagnostic evidence is sufficient
- **WHEN** the completed collection supports a repair hypothesis or a concrete experiment
- **THEN** the evidence is handed to the existing repair task without issuing a source-stage retry, changing incidentVerification or declaring the source audit restored
