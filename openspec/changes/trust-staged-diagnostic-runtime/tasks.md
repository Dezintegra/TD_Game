## 1. Prepare the isolated host build

- [ ] 1.1 Integrate the committed PR #303 endpoint source with current main in this assigned worktree, without editing the 0383-owned tree; verify exact source SHAs, clean source and successful syntax/import checks.

## 2. Attest the sole owner and loaded code

- [ ] 2.1 Extend diagnostic-only process identity to verify an explicit canonical entrypoint from a registered worktree of the same repository; retain the ordinary main-entrypoint default. Test correct owner, wrong entrypoint, stale lock and unregistered tree.
- [ ] 2.2 Attest loaded `codeSha` separately from `rootSha`, check source cleanliness at startup and before launch, and make client/endpoint reject changed or fabricated attestation. Test distinct root/code revisions, changed SHA, dirty source and a request that cannot start provider.
- [ ] 2.3 Update host instructions with single-owner staged startup, verification and rollback. Run focused endpoint/process-identity tests, lint, formatting and strict OpenSpec validation; commit and push the support patch with green CI.

## 3. Prove live host acceptance

- [ ] 3.1 On a quiet host, pause new scheduling, stop the ordinary owner, start the committed staged build against the original root/configuration/store, and prove exact entrypoint, code/root SHAs, lock PID, Windows identity, provider and endpoint generation. On refusal restore the ordinary owner and record the exact cause.
- [ ] 3.2 Authorize the four fixed assignments, perform prepare/submit/get, verify repeated get without new launch or charge, and save a redacted manifest plus SHA-256 for 0383/0381. Preserve any uncertain result and do not relaunch it blindly.
- [ ] 3.3 Restore the ordinary main runtime, remove only this handoff's pause, verify its next non-idle cycle and communicate the accepted evidence to the owning 0383 task without changing its worktree or source cards.
