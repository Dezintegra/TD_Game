## Context

PR #303 adds an opt-in Windows named-pipe diagnostic endpoint. The owner check in its production wiring calls `supervisorIdentity(pid, lockPath)`, which derives one permitted entrypoint from the main root. A single-owner attempt using PR #303's clean worktree and the original root/configuration/store exited with `owner-unavailable` before publishing the endpoint. The existing supervisor was restored. Installing the PR code into main first would violate the required live acceptance gate.

## Goals / Non-Goals

**Goals:** make the staged acceptance build a verifiable sole owner, distinguish its loaded code revision from the main project revision, and preserve all existing diagnostic and scheduling restrictions.

**Non-Goals:** add another writer, launch provider during preparation, relax per-request grants, or merge PR #303 before its acceptance.

## Decisions

1. The diagnostic path accepts an explicit entrypoint attestation; ordinary `supervisorIdentity` callers retain their main-root default. If that path does not match, watchdog/stop may recognize a staged owner only from an opt-in process command line and an endpoint descriptor that matches the lock, store, exact entrypoint and registered clean Git code. The runtime derives its entrypoint from its own module location, not the descriptor or requester. The client independently validates the descriptor. Exact command-line matching and live root-lock PID remain mandatory. This avoids a PID-only bypass and prevents the watchdog from misclassifying a live staged owner as an orphan.
2. The endpoint records `codeSha` from the worktree containing the executing module and `rootSha` from the project root. Code cleanliness is checked in the executing worktree. Both values are rechecked before a diagnostic launch; the client also rejects a descriptor whose attestation no longer matches. The existing `runtimeSha` field may be retained as an explicit alias of `codeSha` for consumers, but it must never silently describe root HEAD while the loaded code differs.
3. The host stops the existing supervisor only after pausing new scheduling and confirming no live children or pending ordinary reports. It launches the staged build with the same root, local directory, config and provider; the watchdog sees the occupied root lock and does not create another owner. When the opt-in endpoint is enabled, Codex readiness runs even under a manual scheduling pause; the pause still prevents ordinary task launches. Each diagnostic grant must explicitly allow that pause. After four results and repeat-get evidence are saved, the host stops the staged owner and restores the ordinary main runtime.
4. Tests use the production endpoint wiring, a real Windows pipe fixture, and distinct root/code Git revisions. They exercise successful staged identity; wrong entrypoint, unregistered worktree, dirty supervisor, changed SHA, stale lock and client refusal. Existing main-root identity tests remain unchanged.

## Risks / Trade-offs

- [Staged code differs from main] → record both SHAs and verify the exact loaded entrypoint and clean worktree on each request.
- [Restart while a diagnostic is in flight] → retain the shared report store's durable intent/result rules; stop only after the result is settled or explicitly uncertain.
- [Another watchdog launch during handoff] → rely on the single root lock and verify the winner's command line before creating grants.
- [Trello or SSH delay] → keep the normal runtime restored and unpaused while implementing this fix; do not claim host acceptance until live responses exist.

## Migration Plan

Patch the PR #303-based build, run focused tests and exact-source verification, then repeat the sole-owner handoff. Record code/root SHAs and four diagnostic results. Reconcile the support patch into PR #303 before declaring its implementation complete. If startup or verification fails, remove only this handoff's pause, restore the main supervisor through the standard launcher, and keep the diagnostic task blocked with its exact failure.

## Open Questions

None for the owner identity contract. The four source assignments may still yield verified helper refusals; those are diagnostic results, not permission to change their cards.
