## ADDED Requirements

### Requirement: Refresh source implementation binds a pinned build to selected executables

The refresh instrumentation delivery SHALL pin Codex CLI/helper 0.153.4 to upstream commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` and retain source, patch, lockfile, toolchain, target, features, recipe, schema and coverage identities with SHA-256 and UTC build receipts. It SHALL verify the candidate CLI and every helper against the receipt and, during separately authorized activation, bind the actual resolver result and loaded process image to parent-held process identity and child handshake. Version text or an adjacent executable MUST NOT establish selected-image provenance. Rebuild equality and equivalence to the stock release SHALL be reported separately; unknown or mismatched provenance MUST NOT qualify as an accepted source.

#### Scenario: A clean rebuild produces different bytes
- **WHEN** two clean builds from the same declared inputs produce different executable hashes
- **THEN** the receipt preserves both results, reproducibility is unproven and activation readiness is withheld until the discrepancy is resolved or the contract is explicitly revised

#### Scenario: Selected helper differs from the approved candidate
- **WHEN** resolver output, file identity/hash, process image, creation time or helper handshake disagrees with the approved manifest
- **THEN** provenance is incomplete, the mismatch is retained and the source does not select a replacement helper or broaden permissions to pass

### Requirement: Refresh source implementation propagates causal identities through production boundaries

The source SHALL map a real provider session and leaf tool call, including code-mode nested calls, to collectionId, launchId, callId and backend attemptId before dispatch. It SHALL carry explicit context through asynchronous, blocking, IPC and worker boundaries to actual refreshId, helperInstanceId, threadInstanceId and aclOpId. Singleflight SHALL retain its original key and semantics, record one leader and every joiner, and allocate a new refreshId for a subsequent flight. Process and thread identities SHALL include host, PID/process creation time and TID/thread creation time without loss of 64-bit precision. The source SHALL explicitly report no-refresh and covered no-op branches and SHALL reject missing, reused or contradictory edges instead of inferring them from UTC, parent PID or model text.

#### Scenario: Concurrent calls join and a later call starts a new flight
- **WHEN** two attempts share one pending flight and a third arrives after its removal
- **THEN** the first two have explicit leader/joiner edges to one refresh and the third has a new refreshId without a diagnostic field changing the coalescing key
- **AND** deleting either edge makes the relevant causal graph incomplete

#### Scenario: Blocking or child boundary loses context
- **WHEN** context is omitted at spawn_blocking, a worker, or a ReadAclsOnly child that outlives its parent
- **THEN** the missing branch remains correlation/coverage-incomplete and parent context is not fabricated for it

#### Scenario: Numeric identity is reused
- **WHEN** a PID or TID reappears with different creation time or acl-before/result disagree on executing identity
- **THEN** the join is rejected as identity-mismatch and original records remain available

### Requirement: Refresh source implementation observes the effective token at the ACL boundary

Each covered native ACL call SHALL be observed on its executing thread immediately around the API with no observer-induced impersonation change, callback or await between the final token observation and that call. OpenThreadToken SHALL request only TOKEN_QUERY with OpenAsSelf FALSE; only ERROR_NO_TOKEN SHALL permit OpenProcessToken fallback. The source SHALL retain bounded security fields, token identity and stability checks, target identity, API/site, intended descriptor identity and the direct API result. Other query failures, required missing fields, unstable identity or uncontrolled concurrent mutation MUST NOT qualify as token-at-call. The source MUST NOT modify privileges, profiles, ACL decisions or API results to improve its evidence.

#### Scenario: Denied thread token and readable primary token
- **WHEN** the thread-token query is denied while a process-token query would succeed
- **THEN** the record reports token-unavailable with the actual error and does not attempt fallback or stronger access

#### Scenario: Thread has no token
- **WHEN** OpenThreadToken returns ERROR_NO_TOKEN
- **THEN** a TOKEN_QUERY process-token snapshot records the fallback reason, selection and interval

#### Scenario: Token changes during observation
- **WHEN** TokenId or ModifiedId changes within the snapshot or across the ACL call, a mandatory query fails, or the coverage review cannot bound context mutation
- **THEN** the source preserves the failure and does not assert token-at-call even if the ACL call or command succeeds

#### Scenario: ACL error survives observer calls
- **WHEN** SetNamedSecurityInfoW or SetSecurityInfo returns DWORD 5 and an observer API later changes last-error state
- **THEN** acl-result retains DWORD 5 for the same aclOpId without replacing the original caller result

### Requirement: Refresh source implementation exposes bounded and detectable evidence loss

The source SHALL emit only the allowlisted `refresh-boundary/v1` schema over an isolated bounded channel, with registered writers, monotonic sequences, checksums, initial handshakes and terminal seals. It SHALL preserve operation intents and distinguish them from executed API calls. Frame size SHALL be at most 256 KiB, each writer queue at most 1 MiB and aggregate sanitized records at most 10 MiB including a 64 KiB terminal reserve. Missing writers/records/seals, duplicate sequence, corrupt/truncated frames, unsupported schema, oversized mandatory data or storage/flush failure SHALL remain incomplete even with zero reported drops. A loss signal SHALL prevent new diagnostic invocations through the existing collector; a partial prefix MUST NOT become complete through replay. Secrets, full argv/payload, arbitrary exception text and personal settings MUST NOT be collected for logging.

#### Scenario: Missing last record without a reported drop
- **WHEN** a registered writer loses its terminal seal or a child never handshakes
- **THEN** the source checker reports incomplete and preserves the readable prefix despite zero reported drops

#### Scenario: Corrupt or unsupported frame
- **WHEN** a frame has an unknown schema, duplicate sequence, invalid checksum or truncated bytes
- **THEN** decoding stops accepting that stream as complete and identifies the first unusable boundary

#### Scenario: Storage or limit failure
- **WHEN** storage/flush fails, a writer overflows, or collection volume/deadline is exhausted
- **THEN** the source latches incomplete, requests no further diagnostic invocations, retains available evidence and does not retry indefinitely or change permissions

#### Scenario: Forbidden synthetic data
- **WHEN** tests place secret canaries in argv, payload, error text and unknown fields
- **THEN** all serialized bytes exclude those values and the fixture remains explicitly synthetic

### Requirement: Refresh source implementation proves coverage with production-boundary controls

Source delivery SHALL include a review mapping real dispatch-to-ACL paths, no-refresh branches, children, token mutators and every reachable ACL site to instrumentation and tests. The review SHALL inspect both acl.rs and setup_main/win.rs and other reachable sites, including SetSecurityInfo, cleanup and revoke. Negative tests SHALL exercise production context propagation, serializer/decoder, token selection and API wrappers while substituting only Windows/IPC boundaries. Removing a production propagation edge or bypassing a covered wrapper SHALL fail a corresponding control. Tests MUST NOT run real setup or real ACL mutation, and synthetic outcomes MUST NOT qualify as live-host evidence.

#### Scenario: Previously overlooked ACL site
- **WHEN** a reachable ACL call is absent from the coverage map or bypasses the wrapper
- **THEN** coverage is incomplete and the delivery cannot claim a complete source merely because the historical error site was instrumented

#### Scenario: A propagation mutation survives a test
- **WHEN** removal of context at an actual production boundary leaves the corresponding test green
- **THEN** that test does not satisfy negative-control acceptance and activation readiness remains unproven

### Requirement: Refresh source delivery preserves staged authorization and collector ownership

The first authorized development stage SHALL produce the patch, build manifest/receipts, source-coverage review and negative-test results without activating a runtime, querying live tokens or running real setup. It SHALL present the exact candidate and absolute artifact paths, SHA-256 and UTC for a separate activation decision. Missing technical facts SHALL name evidence, an available acquisition method and its responsible owner. Only a separate authorization tied to that candidate SHALL permit activation and a bounded diagnostic window. The existing 0370 collector SHALL retain launch, budget, ledger, lock, observer integration and final integrity/completeness/causalSufficiency decisions, with at most two sessions, four calls per session, two minutes per session and ten minutes overall. No reverse dependency on 0370 SHALL be required to develop the source. Build/test success or merged documents MUST NOT establish source availability, repair, incident verification or live causal sufficiency.

#### Scenario: Development authorization is already present
- **WHEN** the accepted pinned design and the owner's first authorization are available
- **THEN** development proceeds without waiting for its own future build receipts or another A/B choice, but cannot activate the resulting build

#### Scenario: Concrete package reaches the second gate
- **WHEN** a candidate patch, manifests, reproducible build receipts, coverage and negative controls are ready
- **THEN** delivery identifies that exact package for a separate activation decision and keeps live acceptance unproven until authorized primary records exist

#### Scenario: Host observation is unavailable
- **WHEN** authorized verification cannot establish selected-helper identity, token-at-call, storage or another required runtime fact
- **THEN** the handoff names the verified technical barrier and retains partial evidence without weakening 0370 or presenting command success as repair

#### Scenario: Primary evidence is handed off
- **WHEN** an authorized collection supplies records linking a specific tool call through refresh, helper/thread and ACL/token to read and Git outcomes
- **THEN** the handoff supplies absolute paths, hashes, UTC and primary record references for the existing collector's three separate verdicts, without closing the original incident itself
