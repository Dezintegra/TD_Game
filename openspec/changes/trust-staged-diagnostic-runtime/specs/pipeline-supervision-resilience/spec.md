## ADDED Requirements

### Requirement: Verified staged diagnostic runtime ownership
For opt-in Windows host acceptance of an unmerged diagnostic endpoint, the supervisor SHALL allow the sole owner to load committed supervisor code from a registered worktree of the same repository while retaining the existing project root, configuration, lock, report store and ledger. The endpoint and its client SHALL verify the owner's exact process entrypoint against that worktree, the lock PID, worktree registration, clean supervisor source and loaded code SHA. They MUST reject an arbitrary path, a stale or competing owner, a changed or dirty source tree, and a code SHA inferred only from the project root. No diagnostic request SHALL run after verification fails.

#### Scenario: Sole owner loads a staged build
- **WHEN** the existing owner has stopped, its lock is free, and a clean registered worktree supplies a committed supervisor build with the diagnostic endpoint
- **THEN** the new owner may acquire the same root lock and expose one endpoint whose descriptor identifies the loaded code SHA and the separate project-root SHA
- **AND** ordinary report delivery and addressed diagnostics continue to use the same root state and one writer.

#### Scenario: Entrypoint or code identity changes
- **WHEN** the lock PID, owner command line, registered worktree, loaded commit or supervisor source differs from the attested descriptor
- **THEN** endpoint startup or request validation fails closed, with no provider launch, diagnostic settlement or source-task transition.

#### Scenario: Main-checkout runtime remains valid
- **WHEN** the supervisor runs from the committed main checkout under the existing watchdog
- **THEN** its ordinary ownership checks and startup behavior remain valid without requiring a staged worktree or enabling the diagnostic endpoint.
