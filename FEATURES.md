# Features

Grouped by release. Each entry is one line, marked `✓` shipped or `⋯` in progress.

Updated in the same commit as any feature whose status changes.

## Release 0 — Petri Dish

- ⋯ Probes — entities with identity, lineage, and firmware
- ⋯ Directive stacks — for now, just one directive kind: replicate
- ⋯ Replication — children inherit (and may drift from) their parent's firmware
- ⋯ Mutation — parameter drift on inherited firmware (priority swap and directive loss/gain still pending)
- ⋯ Lineage clustering — descendants whose firmware drifts past the divergence threshold found a new lineage; the lineage tree records who descended from whom
- ⋯ Dashboard — population trajectory chart, lineage tree, probe inspector, controls (pause / resume / 1×–64× speed)
