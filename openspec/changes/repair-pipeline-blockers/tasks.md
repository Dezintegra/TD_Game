## 1. Scheduler and provider resilience

- [x] 1.1 Release capacity and deploy exclusivity held only by non-live incomplete-ledger tasks, with scheduler cases for two held tasks, held deploy, and live sessions.
- [x] 1.2 Load the Codex ledger independently of provider and cover provider round-trip plus orphan adoption without loss of unrelated tasks.

## 2. Conservative legacy ledger recovery

- [ ] 2.1 Implement evidence normalization and monotonic recovery planning for legacy ledger entries, session JSONL, and trustworthy stage logs.
- [ ] 2.2 Add the dry-run-first recovery CLI with live-lock refusal, backup, atomic apply, unresolved report, fixtures, and operator documentation.

## 3. Current execution context

- [x] 3.1 Update the Windows stage-model readiness mock for sandbox warmup, after verifying the needed upstream test-only change.
- [x] 3.2 Preserve newest full journal records in stage prompts with an omission marker and a large-journal P1/owner-response test.
