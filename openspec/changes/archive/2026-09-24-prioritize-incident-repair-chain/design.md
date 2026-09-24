## Decision

Extend `incidentPolicy`'s existing graph traversal from each active incident's `fixedBy` tasks. In addition to `dependsOn` and `splitInto`, visit each task's `recovery.fixedBy` IDs. The existing `fixes` set prevents loops and duplicate work. `planLaunches` already prefers tasks for which `isRecovery` is true, so no scheduler sorting rule changes.

This marks 0074 as urgent while it repairs 0368, which in turn repairs the 0199 incident. The scanner's usual holds, workspace checks and token admission still decide whether 0074 can actually start. When the incident is verified, the priority naturally disappears.
