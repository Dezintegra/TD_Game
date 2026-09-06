## ADDED Requirements

### Requirement: Applicable server configuration

Deployment SHALL require only settings consumed by the deployed services and SHALL preserve existing explicit server configuration without printing secrets.

#### Scenario: Local supervisor credentials

- **WHEN** TRELLO_KEY and TRELLO_TOKEN are absent on a game server whose services do not consume them
- **THEN** deployment does not ask for them or copy them to the server

### Requirement: Existing defaults

Deployment SHALL distinguish an existing documented default from a missing mandatory setting requiring an owner decision.

#### Scenario: Optional telemetry override

- **WHEN** TELEMETRY is absent and the assigned Compose revision explicitly defaults it to 1
- **THEN** deployment uses that default and records it without a new permission question or editing server env

#### Scenario: Required domain

- **WHEN** TD_DOMAIN is absent and Compose requires it without a default
- **THEN** deployment stops with a specific question about that required setting

#### Scenario: Explicit override

- **WHEN** an optional setting already exists on the server
- **THEN** deployment preserves its value instead of replacing it with the default
