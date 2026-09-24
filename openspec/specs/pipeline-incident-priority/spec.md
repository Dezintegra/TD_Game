# pipeline-incident-priority Specification

## Purpose
TBD - created by archiving change prioritize-incident-repair-chain. Update Purpose after archive.
## Requirements
### Requirement: Incident repair priority follows recovery dependencies

For an active pipeline incident, the supervisor SHALL give repair priority to the incident's direct fixes and their transitive `dependsOn`, `splitInto`, and `recovery.fixedBy` prerequisites. Priority SHALL NOT bypass ordinary admission holds or survive after the incident is verified.

#### Scenario: A failed fix needs another repair

- **WHEN** incident source A names fix B and B's pipeline recovery names C in `fixedBy`
- **THEN** C is considered recovery work when scheduling an eligible stage, ahead of unrelated eligible work.

#### Scenario: A repair graph contains a cycle

- **WHEN** repair references form a cycle
- **THEN** traversal terminates and each task is considered at most once.

#### Scenario: Repair prerequisite is held

- **WHEN** C is a repair prerequisite but its workspace or other admission requirement is unready
- **THEN** C remains held and another eligible task can use the slot.

### Requirement: Local pipeline blockers prioritize service repairs

The supervisor SHALL give scheduling priority to eligible service tasks named by an open blocked task's `dependsOn`, and to eligible service tasks named by an open pipeline-caused recovery's `fixedBy`. Their transitive prerequisites SHALL receive the same priority. This priority SHALL end when the source is no longer blocked or failed and SHALL NOT bypass ordinary admission holds or the affected-stage hold of an unrelated active pipeline incident.

#### Scenario: Local blocked tasks await a service repair

- **WHEN** blocked 0156 and 0208 depend on service repair 0381, while unrelated service work is eligible
- **THEN** an eligible stage of 0381 receives the next service slot before unrelated work.

#### Scenario: Repair has a prerequisite

- **WHEN** a local service repair itself depends on another open task
- **THEN** the prerequisite is considered for priority without infinite traversal on a cycle.

#### Scenario: Global incident holds an unrelated stage

- **WHEN** a local repair is at a stage held by a separate active pipeline incident
- **THEN** local priority does not admit that stage; another eligible task can use the slot.

#### Scenario: Source is resolved

- **WHEN** the source card has left blocked or failed status
- **THEN** its old repair links no longer grant priority.
