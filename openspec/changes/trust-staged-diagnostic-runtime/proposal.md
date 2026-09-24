## Why

The addressed diagnostic endpoint in PR #303 requires live Windows-host acceptance before that PR can be merged. Its owner check accepts only `supervisor/bin/supervise.mjs` in the main checkout, where the unmerged endpoint does not exist. The first single-owner staging attempt failed with `owner-unavailable`; the normal supervisor was restored. The acceptance gate and owner check therefore form a circular dependency.

## What Changes

- Permit an explicitly staged, committed supervisor from a registered worktree of the same repository to hold the existing root lock and expose the opt-in diagnostic endpoint.
- Verify the exact running entrypoint, worktree identity and clean supervisor code, code SHA, root state SHA, lock owner, Windows user and endpoint generation. Any mismatch fails closed.
- Record the loaded code SHA separately from the main checkout SHA in diagnostic metadata and results.
- Keep the existing single writer, authorization, pause, scheduling and report-store restrictions. The staged runtime is a temporary host-acceptance path, not a parallel service.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `pipeline-supervision-resilience`: a sole Windows owner may run a verified staged diagnostic build from a registered worktree without weakening process or store ownership checks.

## Impact

This affects supervisor process identity and the opt-in addressed diagnostic endpoint/CLI from PR #303, their Windows tests, and host installation instructions. It does not affect game responsiveness or game network traffic; checks happen only during supervisor startup and local diagnostic calls.

## Non-goals

- Merge PR #303 before its live acceptance, bypass a reviewer, or edit its owned worktree.
- Start another writer, change source task status or retry entitlement, or weaken diagnostics to accept a PID or descriptor alone.
- Change game behavior or the public server protocol.
