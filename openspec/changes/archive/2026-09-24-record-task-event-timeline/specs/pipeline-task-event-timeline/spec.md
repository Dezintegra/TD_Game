## ADDED Requirements

### Requirement: Task events survive an interrupted stage

The supervisor SHALL append a UTC-stamped, task-addressed event to a local durable timeline when a stage starts, when a supported tool action starts or finishes, when an error is observed, and when the stage finishes. Every event SHALL identify its stage and launch, when a launch exists. A failed process spawn SHALL be recorded even when no stage log can be produced.

#### Scenario: Stage fails after some actions

- **WHEN** a stage starts, completes one action, then reports a tool error
- **THEN** the task timeline contains the ordered start, action and error records before the final stage result is processed.

#### Scenario: Supervisor stops before stage completion

- **WHEN** the supervisor stops after receiving action events but before saving the completed stage log
- **THEN** the already appended task timeline retains those actions and does not invent a completion event.

#### Scenario: Process fails to start

- **WHEN** process creation throws or yields no PID
- **THEN** the task timeline records the attempted stage and the bounded failure reason.

### Requirement: Task event timeline remains bounded and identifiable

The supervisor SHALL use one append-only timeline per task, preserve entries from earlier launches, and bound each recorded text field. It SHALL NOT copy raw prompts, full tool output or arbitrary assistant prose into this timeline. A failed timeline write SHALL be named in the supervisor log and SHALL NOT be reported as a successful write.

#### Scenario: Continuation of the same task

- **WHEN** a task has two stage launches, including a continuation or a supervisor restart
- **THEN** both launches appear in its timeline with distinct launch IDs and UTC timestamps.

#### Scenario: Large tool output

- **WHEN** a tool returns a large output or a long error
- **THEN** the timeline stores only a bounded action summary and bounded failure detail while the existing stage log retains its current behavior.

#### Scenario: Timeline storage fails

- **WHEN** the timeline cannot be appended
- **THEN** the supervisor records a diagnostic naming the task and stage and continues existing stage and report handling.
