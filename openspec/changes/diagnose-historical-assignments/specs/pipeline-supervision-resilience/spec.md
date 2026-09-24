## ADDED Requirements

### Requirement: Historical assignments have an addressed diagnostic entry

The Windows runtime owner SHALL expose the existing stage-tool diagnostic mechanism for a verified historical assignment independently of retry-envelope presence and blocked/failed task status. The entry SHALL accept a request identity, assignment identity and fixed read-only profile, and MUST NOT accept executable command, environment or permission overrides from the requester. It SHALL reuse the existing control selection, structured fact extraction, context comparison, provider launch and usage accounting. It MUST NOT fabricate an original report, retry entitlement, refund or task transition, alter attempt counters or permission rules, resolve merges or apply retained reports.

#### Scenario: Blocked or failed assignment has no envelope

- **WHEN** the owner authorizes a verified stopped assignment with no retry envelope and its fixed profile
- **THEN** the diagnostic entry produces an addressed diagnostic result independently of its blocked/failed status
- **AND** the source task, report, attempts, merge state and retry rights remain unchanged

#### Scenario: Existing envelope is present

- **WHEN** a historical request addresses an assignment that already has retained diagnostic material
- **THEN** the entry preserves that envelope and its disposition, serializes against its active diagnostics, and stores the addressed result separately without triggering settlement

#### Scenario: Request includes executable overrides

- **WHEN** a request supplies an unknown profile, command text, path override, environment or permission override
- **THEN** it is rejected before any diagnostic launch

### Requirement: Historical diagnostics require current ownership and context proof

Before launching, the runtime owner SHALL verify assignment provenance, task/stage, historical launch identity or explicit unknown, real worktree and branch, provider/version, runtime revision, current environment/permission provenance, authority and absence of a live or competing owner. Unknown authority or ownership SHALL fail closed. The owner SHALL serialize diagnosis with scheduling and other diagnostics for that assignment, recheck immediately before spawn, and retain existing budget and launch restrictions. Manual pause MUST NOT be cleared. A trusted explicit diagnostic authorization during pause MAY permit only the fixed diagnostic operation, never stage scheduling. Unknown historical context MUST NOT be asserted equal to the current verified context.

#### Scenario: Assignment becomes busy

- **WHEN** a live stage, foreign owner or competing diagnostic appears before spawn
- **THEN** the entry returns busy without spawning or taking over that owner, and the source assignment remains unchanged

#### Scenario: Current context differs from owner-confirmed context

- **WHEN** cwd, branch, provider or environment/permission fingerprint differs from the authorized context
- **THEN** no diagnostic command runs and the result identifies the mismatch

#### Scenario: Historical fingerprints are unavailable

- **WHEN** current authority and context are independently verified but historical fingerprints are missing
- **THEN** current-context diagnostics remain possible while historical equivalence is explicitly unknown

#### Scenario: Budget or launch admission is closed

- **WHEN** existing token or runtime launch admission refuses the diagnostic
- **THEN** the entry returns the structured refusal without changing limits, accounting history, counters or pause

### Requirement: Addressed diagnostic results survive redelivery and uncertain launches

The owner SHALL durably record request identity and diagnostic launch identity before process creation and preserve the result before acknowledging completion. Each result SHALL include requestId, assignment and source launch provenance, diagnostic launchId and confirmed sessionId or explicit absence, UTC interval, verified context, runtime/code SHA, commands, structured outcomes, accounted usage/cost and available primary evidence references with SHA-256. Missing evidence SHALL be explicit and SHALL NOT be replaced by model prose. Repeated retrieval SHALL return the same saved result without a new launch or duplicate charge. Reusing requestId with different contents SHALL be rejected. An uncertain launch SHALL be reconciled by persisted identity and MUST NOT be blindly reissued. Storage or accounting errors SHALL prevent successful completion acknowledgement and further launch of the affected request while preserving available data.

The addressed entry SHALL extend the existing owner-managed report store and its production wiring, using separate diagnostic request accessors and a single runtime writer. It MUST NOT replace the report queue or create another report-delivery or recovery backend. Every write and restart SHALL preserve both report envelopes and diagnostic requests, including existing launch identities, plans, progress, rejections, dispositions and charge/retry records. Ordinary report views and delivery SHALL exclude addressed requests. Restoration SHALL retain the existing lock-before-store-before-recovery ordering and storage-failure protections.

#### Scenario: Result acknowledgement is lost

- **WHEN** diagnosis completed and the caller retries submission or retrieval with the same requestId after losing the answer
- **THEN** the saved result and evidence hashes are returned with no extra spawn or usage charge

#### Scenario: Reports and addressed requests share a restarted runtime

- **WHEN** the store contains a partially delivered ordinary report, an infrastructure-held envelope and an addressed request, and the production runtime is recreated after writes to each collection
- **THEN** supervisor, report delivery and the addressed endpoint use the same restored store and retain all three records with their identities and progress
- **AND** ordinary delivery completes only missing effects while addressed retrieval neither settles the hold nor launches or charges another diagnostic

#### Scenario: Report acknowledgement and storage verification preserve addressed data

- **WHEN** ordinary report acknowledgement writes the shared store while an addressed request and a held envelope remain
- **THEN** only that ordinary envelope is removed and the other records survive readback and restart
- **AND** failure to persist or verify either collection prevents durable-success acknowledgement and unsafe restart rather than falling back to an empty or separate queue

#### Scenario: Owner restarts after launch intent

- **WHEN** a request has a persisted launchId but completion or process creation is uncertain after restart
- **THEN** the owner reconciles existing process/output/usage evidence and exposes pending or inconclusive uncertainty without starting a replacement process

#### Scenario: Persistence fails

- **WHEN** launch-intent persistence fails or completed-result persistence/readback fails
- **THEN** the former prevents spawn and the latter preserves the available completed result for storage retry without relaunch
- **AND** neither path reports durable success or applies effects to the source task

#### Scenario: Helper refuses command creation

- **WHEN** a selected control returns a structured pre-creation failure tied to its invocation and verified context
- **THEN** the saved result preserves that evidence and uses the existing classifier
- **AND** error prose without such evidence remains inconclusive rather than fabricated confirmation

### Requirement: Historical diagnostic delivery includes reproducible addressed evidence

Delivery SHALL include a working owner-authorized invocation and installed code SHA, separate results for all four assigned historical targets, a readable manifest with SHA-256, and a verified retrieval method. Fixed profiles SHALL read revise.md and Git status for 0156/0208, additionally design.md for 0175, and audit.md and Git status for 0074. Required host preparation SHALL be completed before declaring this delivery ready. A verified helper refusal MAY be a diagnostic result; an unavailable entry, unverified owner or missing target result SHALL NOT count as completed delivery. This result MUST NOT assert causal repair, preserved historical merge contents or recovery of the source stages.

#### Scenario: Four targets respond through the delivered entry

- **WHEN** all four owner-verified assignments produce separate persisted responses through the delivered route
- **THEN** the manifest binds their requestIds, contexts, source provenance, launch/session identities, accounted costs and evidence hashes to the delivered revision
- **AND** repeated retrieval verifies the saved bytes without another diagnostic run

#### Scenario: Only a synthetic test or foreign-cwd probe succeeds

- **WHEN** implementation tests pass or commands work from the repair task's own cwd but an addressed target has no verified response
- **THEN** delivery remains incomplete for that target
