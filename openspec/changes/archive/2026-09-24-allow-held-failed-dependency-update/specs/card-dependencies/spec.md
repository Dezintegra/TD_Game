## ADDED Requirements

### Requirement: Addressed additions under an idle same-station failed claim

The supervisor SHALL permit an ordinary saved `dependencyUpdates` report to add dependencies to a `failed` target already claimed by its own station only when the target has exactly the current Trello member, the card's machine owner matches the station, and no live stage or other pending report owns the target. It SHALL re-read authoritative card data and revalidate the merged dependencies before writing, preserve the existing claim and task state, confirm the write independently, and keep the source report retryable until confirmation. Missing activity evidence, another station's claim, a live stage, or a different task state SHALL retain the busy refusal without a target write.

#### Scenario: Failed target held by the same idle station

- **WHEN** 0241's saved report adds a prerequisite to failed 0238, whose only member and owner are the idle current station
- **THEN** the addition is confirmed without removing or replacing 0238's claim, and the original report is delivered once.

#### Scenario: Active or foreign claim

- **WHEN** the target has a live stage, another pending report, a different owner or member, or cannot be proved idle
- **THEN** the target remains unchanged and the source report stays available for retry with a busy diagnostic.

#### Scenario: Confirmation fails

- **WHEN** the metadata PUT may have succeeded but readback fails
- **THEN** the source report remains in the queue, later actions use fresh target data, and a retry confirms the prior write without duplicating it.
