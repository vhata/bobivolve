# Features

Grouped by release. Each entry is one line, marked `✓` shipped or `⋯` in progress.

Updated in the same commit as any feature whose status changes.

## Release 0 — Petri Dish

- ✓ Probes — entities with identity, lineage, and firmware
- ✓ Directive stacks — for now, just one directive kind: replicate
- ✓ Replication — children inherit (and may drift from) their parent's firmware
- ✓ Mutation — parameter drift on inherited firmware (priority swap and directive loss/gain deferred to R1, where richer firmware makes them meaningful)
- ✓ Lineage clustering — descendants whose firmware drifts past the divergence threshold found a new lineage; the lineage tree records who descended from whom
- ✓ Dashboard — population trajectory, named lineage tree, lineage inspector with drift envelope and sparkline, events timeline, run controls, auto-pause toggles
- ✓ Auto-pause triggers — pause when a clade speciates (other triggers wait for their mechanics to land at later releases)
- ✓ Persistence — runs save and load to the browser's Origin Private File System; the headless CLI saves and resumes runs to the local filesystem (`pnpm sim --save-dir … --run-id … --resume`)
- ✓ Lay-person lineage names — Pioneers, Vagabonds, Drifters and friends (deterministic, hashed from ordinal)
