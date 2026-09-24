## ADDED Requirements

### Requirement: Administrative cleanup incident declarations use local recovery

The supervisor SHALL accept a successful pipeline-caused postmortem that declares an incident confined to `cleanup` with `check.stage` and the source `returnTo` equal to `cleanup` as local recovery when evidence, verification expectation, and resolved repair tasks are present. It SHALL preserve the diagnosis and repair links, SHALL NOT open a global `pipelineIncident`, and SHALL keep the source held until the repairs and ordinary cleanup admission conditions are satisfied.

#### Scenario: Preserved report for cleanup loop

- **WHEN** 0067's saved postmortem names the cleanup loop, `0339` and `0340` as repairs, and a cleanup verification expectation
- **THEN** the same report is accepted after explicit retry, its evidence and expectation are recorded, and 0067 waits for those repairs without a global incident.

#### Scenario: Incomplete cleanup declaration

- **WHEN** the declaration lacks valid evidence or an expectation, has no resolved repair tasks, or names additional affected stages
- **THEN** it remains rejected in the saved report queue with a diagnostic; no repair or cleanup is assumed complete.

#### Scenario: Unrelated incident declaration

- **WHEN** a postmortem declares an invalid incident for a session stage
- **THEN** ordinary incident validation still rejects the declaration and preserves the original report.
