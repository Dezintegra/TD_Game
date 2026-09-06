## ADDED Requirements

### Requirement: Selectable provider
The supervisor SHALL support claude and codex providers and default to claude. Unknown providers SHALL fail before launching stages.

#### Scenario: Existing configuration
- **WHEN** no provider is specified
- **THEN** the existing Claude command and permissions are used

#### Scenario: Codex selected
- **WHEN** codex is selected at launch
- **THEN** the supervisor uses Codex commands, events and its own permission configuration

### Requirement: Provider-owned sessions
The supervisor SHALL persist the provider with every session and SHALL NOT resume a session in a different provider.

#### Scenario: Switch after interruption
- **WHEN** a Claude stage is continued under Codex
- **THEN** a new Codex session receives the assignment and journal without the Claude session identifier

#### Scenario: Codex starts a thread
- **WHEN** a thread.started event is received
- **THEN** its identifier is persisted before completion

### Requirement: Honest completion and spending
The Codex adapter SHALL require a successful terminal event and process exit for success. It SHALL enforce a configurable task token budget for Codex independently of Claude dollar accounting.

#### Scenario: Truncated stream
- **WHEN** an agent message arrives without turn.completed
- **THEN** the run is not accepted as successful

#### Scenario: ChatGPT subscription
- **WHEN** Codex runs with its default subscription configuration
- **THEN** 25,000,000 input plus output tokens per task trigger decompose before the next ordinary stage, while Claude retains its dollar cap

#### Scenario: Persistent cumulative usage
- **WHEN** a turn reports cumulative session usage, including before a failed exit or invalid report
- **THEN** the supervisor persists the session maximum, counts cached input once and sums sessions across stages without resetting on resume, restart or forgotten session

#### Scenario: Unknown consumption
- **WHEN** a completed turn omits usage while the budget is enabled
- **THEN** the stage is not accepted as successful and existing attempt and timeout guards remain active

### Requirement: Discoverable project guidance
The repository SHALL expose project instructions and six OpenSpec skills to Codex while retaining Claude support.

#### Scenario: Codex opens the project
- **WHEN** Codex discovers AGENTS.md and .agents/skills
- **THEN** it can follow the same project workflow without Claude-specific tools
