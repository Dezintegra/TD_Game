## ADDED Requirements

### Requirement: Instrumented refresh source design separates provenance from activation

An instrumented Windows refresh source design SHALL identify its immutable CLI/helper source revision, the observed stock binary inventory, the future build provenance checks, and the checks binding the actually selected helper image to its process identity. It SHALL distinguish observed facts, planned instrumentation and unverified runtime properties. Approval or delivery of a design MUST NOT authorize building, replacing runtime, querying live tokens or running an experiment unless those actions are separately authorized. A design-only result MUST NOT be represented as an available causal source, a completed capture or incident recovery.

#### Scenario: Version matches but selected helper is unknown
- **WHEN** an inventory provides matching version text and an adjacent helper hash without observing the helper selected for a refresh
- **THEN** the design retains that helper as a candidate and requires selected-image and process provenance verification before accepting future evidence

#### Scenario: Design is delivered without an instrumented build
- **WHEN** the project and its independent audit are complete but no separately authorized build or live validation exists
- **THEN** delivery is reported as design-only, source availability remains unproven and dependent capture acceptance remains unsatisfied

### Requirement: Instrumented refresh source design defines a causal boundary graph

The design SHALL specify explicit propagation of collection, launch, leaf-call, attempt, refresh, helper-instance and ACL-operation identities from the actual tool dispatch to each relevant native ACL call. It SHALL cover singleflight leaders and joiners without changing the original coalescing key, blocking tasks, worker threads, child helpers and branches with no refresh. Its acceptance contract SHALL bind process PID and creation time, executing TID and thread lifetime to the observed operation, and reject correlation based only on names, parent PID, timing or model prose. It SHALL require coverage review and negative tests for a missing propagation edge, an unobserved writer and reused identities.

#### Scenario: Two tool calls share one refresh
- **WHEN** singleflight coalesces two invocations
- **THEN** the design represents one refresh with explicit leader and joiner edges and requires rejection when either required edge is lost
- **AND** diagnostic identifiers do not alter the existing singleflight key

#### Scenario: ACL work runs after the parent helper exits
- **WHEN** a refresh spawns a child read-ACL helper or runs ACL work on another thread
- **THEN** the design preserves explicit child and thread identities, requires their terminal evidence and marks missing records incomplete instead of assigning the parent's identity to the operation

#### Scenario: Numeric process or thread identity is reused
- **WHEN** records reuse a PID or TID with a different creation time or disagree on the before/result execution identity
- **THEN** the acceptance contract rejects the join and retains the original records for investigation

### Requirement: Instrumented refresh source design specifies effective-token evidence and its limits

The design SHALL specify read-only observation on the executing native thread immediately around each covered ACL API boundary, the exact token selection rule, required access rights, bounded security fields and direct API result. A process-token fallback SHALL be allowed only after ERROR_NO_TOKEN from the thread-token query; another failure MUST NOT be treated as absence of impersonation. The design SHALL forbid token substitution, privilege changes, impersonation changes by the observer and ACL writes performed merely to test access. It SHALL detect unstable snapshots and state the limit of user-mode observation: unknown concurrent security-context mutation MUST NOT qualify as proven token-at-call. Instrumented-build findings MUST NOT automatically establish stock-build behavior.

#### Scenario: Thread token is inaccessible
- **WHEN** OpenThreadToken returns access denied while the primary process token would be readable
- **THEN** the planned checker reports token evidence unavailable and the observer does not substitute the primary token or retry with stronger rights

#### Scenario: No impersonation token exists
- **WHEN** the thread query returns ERROR_NO_TOKEN
- **THEN** the plan permits a TOKEN_QUERY-only process-token query and records the fallback reason and its observation interval

#### Scenario: Token stability cannot be established
- **WHEN** token identity or ModifiedId changes, a required field cannot be read, or concurrent context mutation remains uncontrolled
- **THEN** the evidence does not qualify as token-at-call and the missing or unstable fact remains explicit

#### Scenario: ACL API returns an error code
- **WHEN** SetNamedSecurityInfoW returns a nonzero DWORD and subsequent observer APIs change last-error state
- **THEN** the planned record preserves the original DWORD with its ACL-operation identity rather than substituting GetLastError

### Requirement: Instrumented refresh source design makes loss and bounded acceptance explicit

The design SHALL define a versioned allowlist schema, bounded transport and queues, per-writer sequences, initial and terminal records, durable prefix preservation, primary-file hashes and UTC references. It SHALL require rejection of unknown schema versions, missing or duplicate edges/records, corrupt or truncated frames, missing terminal seals and unavailable required provenance or token fields. Secrets, full argv, payloads and personal settings MUST NOT be collected for logging. Loss, write failure or any observation limit SHALL prevent further diagnostic invocations and preserve a partial result without automatic replay or broader permissions. The acceptance plan SHALL preserve the existing collector's ownership, budget accounting and incident boundaries, at most two sessions, four invocations per session, two minutes per session and ten minutes overall, and SHALL bound sanitized records to ten MiB. Synthetic tests and isolated command success MUST NOT establish live causal sufficiency.

#### Scenario: Final record is lost without a reported drop
- **WHEN** a registered writer ends without a verified terminal seal
- **THEN** the design requires incomplete evidence even if the writer's reported drop count is zero

#### Scenario: Storage or observation budget is exhausted
- **WHEN** the planned observer encounters a write failure, queue overflow, time limit or aggregate record-size limit
- **THEN** it schedules no further diagnostic invocations, preserves the readable prefix as partial and uses only the existing collector's handling of its own processes and accounting

#### Scenario: Synthetic control contains forbidden data
- **WHEN** a serializer control supplies a secret canary in payload, argv, error text or an unknown field
- **THEN** the acceptance plan requires its absence from every serialized record and never presents that synthetic run as host evidence
