## Context

The deploy snapshot is a Git worktree below `.pipeline/deploy-checkouts`. On Windows, `td-pipeline` extends `:workspace`, but inherited writable access did not let the pinned CLI create `apps/client/node_modules` in the failed 0013 snapshot. A controlled rerun of `pnpm install --frozen-lockfile` succeeded when all 11 package directories were explicit writable roots. Linux already uses workspace-write rooted at the stage cwd.

## Goals / Non-Goals

**Goals:** Give only the Windows Codex deploy stage package-local write access in its assigned snapshot and retain automatic coverage when a direct package is added under `apps` or `packages`.

**Non-Goals:** Modify existing ACLs, widen other stages, alter deploy results, or treat successful dependency installation as completed deployment.

## Decisions

1. Pass the stage to `codexExecutionArgs`. Only `deploy` adds package paths. The alternative of granting paths to every stage would increase write scope unnecessarily.
2. Resolve package directories from the assigned snapshot, requiring a direct child of `.pipeline/deploy-checkouts`, a Git worktree pointer, and direct package directories containing `package.json` under `apps` or `packages`. Reject a malformed deploy path rather than silently launching with incomplete access. The alternative of listing today's 11 paths in config would miss a newly added package.
3. Add these paths to the existing `td-pipeline` filesystem map before launch. This uses the supported permission mechanism observed to complete the failed installation; no persistent ACL edit is needed.

## Risks / Trade-offs

- An unusual workspace layout outside `apps/*` and `packages/*` would need this rule updated; focused tests and a failed early validation make that visible.
- A package directory is writable for the duration of deploy, including code files; the scope stays inside the immutable snapshot, and no other stage receives it.

## Migration Plan

Merge the supervisor change and allow its normal self-update. The next deploy snapshot receives the new arguments. If it fails on another path, retain the incident hold and evidence rather than silently broadening permissions. Rollback is the prior provider command generation.

## Open Questions

None for the observed pnpm workspace layout.
