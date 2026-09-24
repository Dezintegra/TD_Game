## ADDED Requirements

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
