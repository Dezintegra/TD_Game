# pipeline-legacy-ledger-recovery Specification

## Purpose
TBD - created by archiving change repair-pipeline-blockers. Update Purpose after archive.
## Requirements
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

### Requirement: Runtime Codex accounting uses local session evidence
The supervisor SHALL obtain Codex cumulative evidence only from an injected
host-side reader of local session JSONL after the child finishes. It SHALL bind
the session and current completed turn to the persisted launch identity, defer
raw streamed usage until that evidence arrives, and preserve `unfinished-launch`
or an unknown reason when evidence is missing, stale, foreign, malformed, or
ambiguous. It SHALL not treat stdout `token_usage_record` text as evidence.

#### Scenario: Durable current-turn evidence supersedes resumed raw total
- **WHEN** a resumed child reports raw usage 421689 while local JSONL proves
  the completed thread cumulative total 2007334 from a prior 1585645 snapshot
- **THEN** the persisted session total is 2007334 and the launch is complete
  without a decreased-usage reason.

#### Scenario: Evidence is not conclusive
- **WHEN** the injected reader reports missing, stale, foreign, malformed, or
  conflicting current-turn evidence
- **THEN** the launch remains incomplete or unknown and raw streaming does not
  make the session complete.

