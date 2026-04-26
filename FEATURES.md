# Features

Grouped by release. Each entry is one line, marked `✓` shipped or `⋯` in progress.

Updated in the same commit as any feature whose status changes.

## Release 0 — Petri Dish

- ⋯ Probes — entities with identity, lineage, and firmware
- ⋯ Directive stacks — for now, just one directive kind: replicate
- ⋯ Replication — children inherit (and may drift from) their parent's firmware
- ⋯ Mutation — parameter drift on inherited firmware (priority swap and directive loss/gain still pending)
- ⋯ Lineage clustering — descendants whose firmware drifts past the divergence threshold found a new lineage; the lineage tree records who descended from whom
- ⋯ Dashboard shell — an empty React app that talks to the sim through a Web Worker; first panel shows population by lineage
