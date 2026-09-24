## Context

`supervisor/lib/run-stage.mjs` streams provider events, but `stage-logs.mjs` publishes the complete stdout/stderr log only in `finish`. A lost supervisor can therefore leave a task with no durable account of its last actions. Trello comments describe state transitions but are not a live tool trace. The three cancelled diagnostic tasks remain closed; this change prepares evidence for future incidents without claiming a repair.

## Goals / Non-Goals

**Goals:** Per-task append-only chronology written while the process is alive, with stage/launch correlation, concise action summaries, error details and explicit final outcomes. Make a failed append visible.

**Non-Goals:** Instrument Windows sandbox internals or derive ACL causality; replay commands; publish raw prompts or outputs to Trello; change scheduler admission or incident verdicts.

## Decisions

1. Store UTF-8 JSONL at `.pipeline/task-events/<full-task-id>.jsonl`. Each line has `at`, `taskId`, `stage`, optional `launchId`, `kind` and bounded allowlisted fields. The directory is already excluded from Git. A file per task allows direct inspection without reconstructing a board-wide log; JSONL tolerates an incomplete final line after a crash.
2. Append and flush each event on arrival in the supervisor process. `launch-start` follows confirmed PID, while `spawn-failed` covers failures before a child exists. `action-start`, `action-finish`, `error` and `launch-finish` use the existing provider event stream. No extra model calls or CLI instrumentation are introduced.
3. Summaries come only from known tool event fields. Commands, paths and errors are shortened to fixed limits; full stdout, prompts, tool payloads and assistant prose are omitted. The full stage log remains the deeper source when a launch finishes.
4. The writer validates task IDs and ordinary files, rejects symlinked log paths and reports write failures through the supervisor's existing diagnostic log. Logging failure does not alter the task outcome or block unrelated work.

## Risks / Trade-offs

- A provider that emits no structured tool events yields start/error/finish records but no action detail. This is visible as a gap, not filled by inference.
- A crash can leave the final JSONL line incomplete. Readers ignore that line; prior flushed lines remain useful.
- Frequent synchronous flushes add disk I/O to tool boundaries. Events are far less frequent than model tokens; each entry is bounded and no game path is touched.

## Migration Plan

No migration of existing logs: new task files are created on first event. Rollback removes the writer integration; existing stage logs and Trello comments continue to work.

## Open Questions

None for this scope. A later operator viewer can be added if direct JSONL inspection proves insufficient.
