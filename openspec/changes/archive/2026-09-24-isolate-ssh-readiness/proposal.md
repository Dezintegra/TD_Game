## Why

On 24 September the deploy host stopped accepting TCP connections on port 22. The Codex startup probe had already proved local Git, GitHub and push access, but its SSH failure wrote `.pipeline/pause` and ended the whole supervisor. Independent design, audit and repair tasks then received no work.

## What Changes

- Separate local Codex readiness from remote deploy readiness. A failed SSH connection holds deploy sessions only.
- Check local child-process ability before the SSH command so a remote outage does not conceal an untested local prerequisite.
- Retry the remote connection while the supervisor continues local work, and only release deploy after a fresh successful probe in Codex.
- Name the remote hold and retry in the supervisor log and setup documentation.

## Non-goals

- No deploy is attempted while remote readiness is unproven.
- No SSH host-key, key, or sandbox policy is weakened.
- An unproven local prerequisite still prevents stage admission.
