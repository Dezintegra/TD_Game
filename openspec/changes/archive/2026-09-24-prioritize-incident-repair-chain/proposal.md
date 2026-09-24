## Why

The active design incident in 0199 names 0368 as its repair. Task 0368 failed and names 0074 in `recovery.fixedBy`. The scheduler gives priority to direct incident fixes and their ordinary `dependsOn` edges but does not follow `recovery.fixedBy`; 0074 consequently waits behind unrelated work while dozens of design tasks remain held.

## What Changes

- Include recovery fixes transitively when identifying work that can clear an active pipeline incident.
- Keep cycle protection and the existing distinction between priority and permission: a marked task still has to pass all ordinary admission checks.
- Add a regression test for the 0199 → 0368 → 0074 shape.

## Non-goals

- No card dependency or incident is removed by this change.
- No task receives a session if its workspace, token budget, or other admission conditions fail.
