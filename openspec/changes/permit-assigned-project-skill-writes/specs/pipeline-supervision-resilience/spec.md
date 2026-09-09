## ADDED Requirements

### Requirement: Protected project skill writes follow a trusted assignment
The supervisor SHALL grant Windows Codex writes to explicitly assigned existing project skill files only from a reviewed configuration of the running supervisor, bound to task identity, change and implementation stage. It MUST NOT derive additional permissions from free-form prompts, worker reports or editable task plans. Missing assignments SHALL preserve default protection.

#### Scenario: Assigned implementation edits both skills
- **WHEN** implement or revise runs for task 0083 with change `guard-declared-purpose-updates` and its trusted two-file assignment
- **THEN** its assigned worktree profile permits `.agents/skills/openspec-archive-change/SKILL.md` and `.agents/skills/openspec-sync-specs/SKILL.md` without granting their parent directories.

#### Scenario: Another task or planning stage
- **WHEN** another task or a stage other than implement/revise starts with the same skill names in its prompt
- **THEN** it receives no protected-skill write extension.

#### Scenario: Invalid assignment fails before execution
- **WHEN** a matching configured entry has an invalid schema, mismatched change, invalid worktree identity, escaping path, link or unsupported file type
- **THEN** launch fails with a specific diagnostic before executing the worker and no broader grant is substituted.

#### Scenario: Continuation recalculates the scope
- **WHEN** an eligible implementation resumes a session
- **THEN** its launch receives the currently validated trusted assignment and does not treat the session identifier as permission to retain obsolete grants.

### Requirement: Skill write exceptions preserve sandbox boundaries
The Windows adapter SHALL retain the configured sandbox, workspace protections, never-approval policy and existing Git/performance exceptions while adding only exact validated skill-file grants. It MUST NOT expand writes to the project root, other worktrees, unassigned protected paths or user configuration. Unsupported policies SHALL fail explicitly without disabling sandbox, switching providers, changing ACL manually or retrying through an alternate tool to bypass denial.

#### Scenario: Unassigned protected file remains protected
- **WHEN** the assigned implementation attempts to write a different skill or a protected Codex configuration file
- **THEN** the effective policy rejects the write and the target remains unchanged.

#### Scenario: Another worktree remains protected
- **WHEN** a worker with the two-file exception attempts to write a file in another worktree
- **THEN** the effective policy rejects the write and the target remains unchanged.

#### Scenario: Runtime cannot enforce the exact exception
- **WHEN** the installed runtime or managed policy rejects the file-scoped configuration
- **THEN** the failure is preserved and the adapter does not replace it with a directory grant or an unrestricted execution route.

### Requirement: Live evidence is required to accept skill write repair
Acceptance SHALL include regression evidence for assignment propagation and a bounded live Windows experiment using the production permission builder, sandbox mode and native worker tools. Both assigned files SHALL be demonstrably modified, continuation SHALL retain the validated scope, and negative controls SHALL prove rejection and unchanged existing targets. A valid argv, textual worker claim, missing target, timeout or unexecuted command MUST NOT count as successful enforcement.

#### Scenario: Complete positive and negative controls
- **WHEN** the baseline refuses the protected write, the assigned profile writes both skill copies, resume works and unassigned-skill, protected-config and foreign-worktree controls are rejected
- **THEN** sanitized evidence binds CLI version, code revision, effective assignment, session/tool events and before/after hashes to the accepted result.

#### Scenario: Negative control succeeds or evidence is missing
- **WHEN** any negative control writes successfully or a required event, tool or profile provenance is unavailable
- **THEN** acceptance fails, remaining writes stop, the uncertainty or failure is recorded and the cause is not declared repaired.

### Requirement: Permission repair preserves the blocked implementation
Delivery of a permission repair SHALL preserve the existing consumer change, worktree, branch and draft files and provide a continuation route through the updated supervisor tool. It MUST NOT replace the consumer change or claim its implementation tasks complete merely because permissions were repaired.

#### Scenario: Continue the saved Purpose plan
- **WHEN** repair 0299 has passed live acceptance and is delivered to the running tool used for the next assignment of 0083
- **THEN** 0083 can resume its existing `guard-declared-purpose-updates` plan with both assigned skill paths; its artifacts and all four `.matchlog/0083-*` drafts remain present and unmodified by 0299, and its implementation checkbox remains owned by 0083.
