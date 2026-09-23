## Why

Deploy 0013 failed before any performance check or remote change: Codex CLI 0.153.4 could write to the snapshot root but `pnpm install --frozen-lockfile` received `EPERM` creating `apps/client/node_modules`. The same pinned CLI completed installation in that snapshot when the package directories were explicit Windows sandbox writable roots. Deploy needs this access consistently instead of another failed attempt.

## What Changes

- Grant a Windows Codex deploy stage write access to package directories inside its assigned immutable deploy snapshot, including future direct children of the workspace package groups.
- Keep other stages and paths outside that snapshot at their existing permission scope.
- Cover the generated stage arguments with a regression test and verify installation in the previously failing snapshot.

## Capabilities

### New Capabilities

- `pipeline-deploy-sandbox-access`: Deploy installation can write package-local dependencies within its assigned snapshot.

### Modified Capabilities

None.

## Impact

Changes `supervisor/lib/provider.mjs` and focused tests. The Windows sandbox receives explicit writable package paths only for deploy. This does not alter game code, player UI responsiveness, or network traffic.

## Non-goals

- Changing ACLs on existing project directories or broadening all Codex stages.
- Declaring the 0013 deployment complete without its own performance and remote verification.
