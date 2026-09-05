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
The Codex adapter SHALL require a successful terminal event and process exit for success. It SHALL NOT silently disable a configured dollar cap when token prices are unavailable.

#### Scenario: Truncated stream
- **WHEN** an agent message arrives without turn.completed
- **THEN** the run is not accepted as successful

#### Scenario: Missing prices
- **WHEN** Codex is selected with a positive dollar cap and no explicit token prices
- **THEN** startup explains the missing configuration and starts no stages

### Requirement: Discoverable project guidance
The repository SHALL expose project instructions and six OpenSpec skills to Codex while retaining Claude support.

#### Scenario: Codex opens the project
- **WHEN** Codex discovers AGENTS.md and .agents/skills
- **THEN** it can follow the same project workflow without Claude-specific tools
