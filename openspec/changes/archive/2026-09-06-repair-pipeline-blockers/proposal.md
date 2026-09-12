## Why

The paused pipeline can indefinitely reserve capacity for a task whose Codex
usage ledger is incomplete, discard an existing ledger while Claude is the
selected provider, and hide the newest operator feedback.  Operators also
need a conservative, auditable way to reconstruct legacy Codex accounting
without touching the running supervisor.

## What Changes

- Correct scheduler capacity accounting for held tasks while preserving the
  exclusion guarantees for genuinely live and deploy sessions.
- Preserve a valid Codex token ledger independently of the currently selected
  stage provider.
- Add an explicit, dry-run-first LEGACY ledger recovery command with evidence
  validation, backup, atomic writes, and an unresolved-evidence report.
- Include Windows sandbox warmup in the stage-model readiness test.
- Pass the newest complete journal entries to stage prompts within the existing
  size bound and mark omitted history.
- Reserve an entire scheduler cycle for the single selected ready deploy/local
  benchmark continuation, and construct runtime ledger/stage state only after
  successful shared-lock ownership.

## Capabilities

### New Capabilities

- `pipeline-legacy-ledger-recovery`: Safely reconstruct conservative Codex
  ledger evidence from local session and stage-log records.
- `pipeline-supervision-resilience`: Scheduler, provider hand-off, readiness,
  and prompt-context rules for reliable supervisor operation.

### Modified Capabilities

- None.

## Non-goals

- Changing pipeline runtime state, Trello data, or any running supervisor.
- Treating uncertain evidence as complete accounting or lowering known usage.
- Changing non-journal text clipping or game behaviour.

## Impact

Affected code is limited to supervisor scheduling, ledger loading, prompt
construction, an operator CLI, its tests and documentation.  There is no
client-frame responsiveness or game-network-traffic impact: this is local
supervisor control-plane work only.
