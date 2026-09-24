## 1. Readiness contract

- [x] 1.1 Separate verified local and remote outcomes in the Codex probe and run the child-process check before SSH; add focused tests for timeout, missing SSH and failed local command.

## 2. Runtime isolation

- [x] 2.1 Hold deploy admission on an unready remote, retry reachability and require a fresh Codex proof before releasing; cover scanner behavior and update setup docs. Run focused checks and `pnpm test:pipeline`, then obtain green PR CI.

## Delivery

After these implementation tasks, archive the change, merge after green CI, and verify non-deploy work and task-event logging in the live runtime.
