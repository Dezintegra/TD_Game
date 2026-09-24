## ADDED Requirements

### Requirement: Returned stages receive the complete latest relevant verdict

When an assignment enters `design` after audit or `revise` after review/PR reconciliation, the stage prompt SHALL include the latest complete relevant return record from the task journal even if later history has displaced it from the bounded journal tail. The copy SHALL retain its transition heading, full body, and report marker. It SHALL NOT assert that a historical record proves the current return; the worker MUST verify its applicability under the stage rules.

#### Scenario: Review verdict displaced by later continuation records

- **WHEN** a `revise` task has a complete `review → revise` record followed by enough journal entries to displace it from the bounded tail
- **THEN** the prompt includes that complete record outside the bounded tail and identifies it as the latest available return record.

#### Scenario: Several review or PR return cycles

- **WHEN** the journal contains multiple complete `review → revise` and `pr → revise` records
- **THEN** the prompt preserves only the most recent relevant complete record, regardless of which of those two transitions produced it.

#### Scenario: Audit verdict displaced before design

- **WHEN** a `design` task has a complete `audit → design` record displaced by later journal entries
- **THEN** the prompt includes the complete audit record and leaves the normal bounded tail unchanged.

#### Scenario: Record already visible or not provably complete

- **WHEN** the relevant return record already appears in full in the bounded tail
- **THEN** the prompt does not duplicate it.
- **WHEN** a return heading is present but its final report marker is missing
- **THEN** the prompt names the record as incomplete and MUST NOT present its body as a complete verdict.
