## MODIFIED Requirements

### Requirement: Bounded reconciliation makes progress toward incident repairs

The supervisor SHALL exclude active incident sources and tasks with an undelivered delay journal before selecting PR reconciliation reads. It SHALL prioritize eligible incident repairs and their prerequisite tasks, using the same incident policy and archived dependency records as scheduling. Recovery priority SHALL be distinct from ordinary admission: admitting an unaffected task SHALL NOT grant it repair priority. Within each group it SHALL select never-checked current PRs first, then the oldest persisted check. Equal checks SHALL retain board order. The existing maximum of two reads per cycle and exclusion of live work, foreign owners and pending report participants SHALL remain.

#### Scenario: Incident sources precede an urgent repair
- **WHEN** incident sources and unrelated stale PRs precede a repair waiting for reconciliation
- **THEN** sources consume no reads and the repair is selected before unrelated work, including admitted unaffected tasks

#### Scenario: Repeated cycles advance beyond the beginning of the board
- **WHEN** more tasks need checking than fit in a cycle and successful checks are persisted between cycles
- **THEN** the next cycle selects the oldest or never-checked remaining tasks even after earlier checks become due again

#### Scenario: Repair reaches its early budget analysis
- **WHEN** an eligible repair has reached the early token threshold and its fresh reconciliation confirms an open PR
- **THEN** the next scan admits its budget analysis without requiring another PR check or treating the incident as resolved

#### Scenario: Protected repair is unavailable
- **WHEN** a repair is live, owned by another station, awaiting report delivery or has an undelivered delay journal
- **THEN** it consumes no reconciliation slot and its state remains unchanged
