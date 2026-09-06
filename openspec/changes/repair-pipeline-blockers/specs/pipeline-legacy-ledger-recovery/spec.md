## ADDED Requirements

### Requirement: Recovery is explicit and non-destructive
The recovery CLI SHALL dry-run by default, require explicit apply, refuse apply
while a live supervisor lock exists, create a backup, and use an atomic ledger
replacement. It SHALL never reduce `knownTokens`, erase a ledger entry, or mark
a session complete without conclusive evidence.

#### Scenario: Default invocation
- **WHEN** an operator runs recovery without `--apply`
- **THEN** it reports proposed changes and writes neither ledger nor backup.

#### Scenario: Live supervisor lock
- **WHEN** an operator runs recovery with `--apply` while the lock identifies a live process
- **THEN** the command refuses without changing the ledger.

### Requirement: Recovery evidence is attributable and monotonic
The CLI SHALL use only session JSONL usage or trustworthy stage logs that
identify task and session, use greatest saved usage, report missing, corrupt,
mismatched, decreased, or ambiguous evidence as unresolved, and remove only
`legacy-unknown` when evidence proves that session. It SHALL migrate old
task-to-session-number format with `legacy-unknown` retained.

#### Scenario: Matching evidence raises usage
- **WHEN** a matching session record reports usage greater than stored `knownTokens`
- **THEN** recovery proposes that greater value and removes only its proven `legacy-unknown` reason.

#### Scenario: Ambiguous evidence
- **WHEN** evidence cannot be uniquely attributed to a task and session
- **THEN** recovery leaves the ledger unchanged and reports it unresolved.

### Requirement: Durable thread usage controls resume accounting
The runtime SHALL prefer attributable `token_usage_record.thread_token_usage`
over raw resumed `turn.completed` usage, and SHALL retain unknown accounting
when identity or response evidence conflicts.

#### Scenario: Resume reports a reset process counter
- **WHEN** a resumed process reports a smaller raw counter but matching durable thread usage
- **THEN** the ledger records the durable cumulative thread total without a decreased-usage reason.
