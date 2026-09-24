## 1. Priority graph

- [x] 1.1 Extend incident repair traversal to `recovery.fixedBy` and test transitive priority, cycles, and ordinary admission holds. Run focused tests, full `pnpm test:pipeline`, format/lint and strict OpenSpec validation; obtain green PR CI.

## Delivery

Archive the change, merge after green CI, and confirm the live scanner selects a reachable incident repair prerequisite before unrelated work when a slot is available.
