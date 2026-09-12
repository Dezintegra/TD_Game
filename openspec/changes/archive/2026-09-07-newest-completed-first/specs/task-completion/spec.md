## ADDED Requirements

### Requirement: New completions appear first

The Trello backlog SHALL place a card at the top of the completed list when saving a transition into that list. It SHALL preserve the position of a card already in the completed list. It SHALL keep existing positioning rules for other lists.

#### Scenario: Newly fulfilled task

- **WHEN** a feature, run or note moves from its working list into completed
- **THEN** the existing card update also places it at the top of completed
- **AND** no separate positioning request is needed

#### Scenario: Already completed card

- **WHEN** a card already in completed is saved again, including with an old transition entry or a blocking flag
- **THEN** the save does not change its position

#### Scenario: Retry after comment failure

- **WHEN** moving into completed succeeds but writing the journal fails
- **THEN** a retry in the same adapter or with a refreshed snapshot preserves the position

#### Scenario: Retry after move failure

- **WHEN** the update moving a card into completed fails
- **THEN** retrying the transition still requests the top position

#### Scenario: Other lists

- **WHEN** a task is saved outside completed
- **THEN** existing positioning rules, including precedence for blocking work, remain unchanged
