## Decision

The startup Codex probe runs Git, GitHub, push dry-run and child-process checks before SSH. Its result distinguishes local readiness from remote readiness using verified command events, not model prose. A local failure preserves the existing startup pause. A failed or missing SSH command leaves `remoteReady` false and lets the supervisor serve non-deploy work.

The supervisor passes remote unavailability to the pure scanner. The scanner keeps deploy tasks and deploy batches out of session admission without charging an attempt or consuming a slot. The supervisor tests the same remote command periodically outside Codex; after reachability returns it reruns the Codex readiness probe, and only its successful SSH command releases deploy. This avoids spending a model session on every network timeout while retaining proof that the actual executor can use SSH.

An already running deploy is not interrupted. A later outage after a successful probe remains an ordinary deploy failure; the probe cannot guarantee future availability.
