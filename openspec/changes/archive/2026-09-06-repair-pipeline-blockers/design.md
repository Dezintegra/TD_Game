## Context

This change repairs supervisor control-plane blockers in scheduler selection,
Codex accounting persistence, prompt construction, and readiness tests. It also
introduces a conservative recovery CLI for legacy Codex accounting. It must not
inspect or mutate the active pipeline runtime.

## Goals / Non-Goals

**Goals:** release phantom capacity, preserve accounting across provider
changes, recover only attributable monotonic usage, and show current review feedback.

**Non-Goals:** infer usage from weak clues, repair Trello, operate the
supervisor, alter game behaviour, or change non-journal clipping.

## Decisions

- Capacity and deploy exclusion derive from tracked live processes, not task
  status. This preserves the live-deploy guard while releasing dead held tasks.
- The normalized ledger loads independently of `providerOf(config)`, preventing
  provider hand-off from persisting an empty replacement.
- Recovery parsing and merge policy are testable library code; the CLI is a thin
  filesystem adapter. Evidence must match task/session identity and monotonically
  raise totals, otherwise it remains in the report.
- Runtime accounting receives the same local JSONL evidence through an injected
  host callback after a child exits. Stdout remains a transport for the final
  report only: it cannot prove Codex token usage. Raw streamed totals stay
  unfinished until the callback proves the completed current turn.
- Journal context is built from complete tail entries and marks omitted history;
  raw string tail clipping can split the newest verdict.
- Only the PR readiness-test semantics are copied after verification; no archived
  OpenSpec material is imported.

## Risks / Trade-offs

- [Artifacts lack identifiers] → report unresolved instead of guessing.
- [Recovery races supervisor] → explicit apply plus live-lock rejection before write.
- [One entry exceeds the limit] → preserve its newest bounded tail with marker.

## Migration Plan

The CLI normalizes the legacy task-to-session-number format while retaining
`legacy-unknown`. Dry-run reports changes. Apply backs up then atomically writes
only monotonic updates. A stopped-supervisor operator can restore the backup.

## Open Questions

None; production records are explicitly out of scope for this branch.
