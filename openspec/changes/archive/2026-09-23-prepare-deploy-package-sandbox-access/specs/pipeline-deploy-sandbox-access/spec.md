## ADDED Requirements

### Requirement: Windows Codex deploy can install snapshot dependencies

The supervisor SHALL give a Windows Codex deploy stage explicit sandbox write access to every direct workspace package directory inside its assigned deploy snapshot before invoking the stage. It SHALL NOT grant these package paths to other stages or to paths outside the assigned snapshot. An invalid or incomplete deploy snapshot SHALL fail before stage launch rather than continue with partial permissions.

#### Scenario: Package-local dependency installation

- **WHEN** a Windows Codex deploy stage starts in a valid snapshot containing packages under `apps` and `packages`
- **THEN** its sandbox arguments include explicit writable roots for each package directory in that snapshot, allowing `pnpm install --frozen-lockfile` to create package-local `node_modules`

#### Scenario: Other stage remains scoped

- **WHEN** a Codex audit or implement stage starts
- **THEN** it receives no deploy package writable roots

#### Scenario: Snapshot path is invalid

- **WHEN** a deploy assignment does not identify a valid snapshot under `.pipeline/deploy-checkouts`
- **THEN** command generation fails before launching Codex
