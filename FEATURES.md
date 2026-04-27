# Features

Grouped by release. Each entry is one line, marked `✓` shipped or `⋯` in progress.

Updated in the same commit as any feature whose status changes.

## Release 2 — The Engineer's Console

- ✓ Quarantine — a player can suspend a lineage's replication from the inspector; the suspension is reversible and the tree marks quarantined lineages with a pip
- ⋯ Origin compute — renewable budget regenerates per tick; patch and decree authoring consume it; the dashboard shows what's affordable
- ⋯ Patches — a directive editor authors firmware modifications to a target lineage; descendants inherit and drift like any firmware
- ⋯ Decrees — conditional patches queued to fire when their triggers match (R2 ships a narrow trigger set)
- ⋯ Intervention-versioned lineage tree — the tree shows when a patch landed and which clades inherited it
- ⋯ PatchSaturated auto-pause — fires when a player-authored patch reaches X% of the population

## Release 1 — Scarcity

- ✓ Sub-lattice — probes have positions on a 64×64 grid procedurally seeded with system centres; most cells are interstellar void
- ✓ Resources & diffusion — cells carry u64 resource counts that flow between neighbours each tick; per-cell caps fall off from system centres so void cells stay dead
- ✓ Energy & starvation — probes carry energy; basal metabolism drains it, gather replenishes it, replication transfers cost to the child; zero energy means death
- ✓ Gather directive — pulls resources from the cell into the probe's energy
- ✓ Explore directive — random-walk move to a cardinal neighbour, gated by a u64 threshold; tuned slow enough that wave-fronts of colonisation are visible
- ✓ Replicate directive (R1 reinterpretation) — energy-threshold gated, per SPEC
- ✓ Mutation: priority swap, directive loss/gain — now meaningful with three directive kinds in firmware
- ✓ Lineage extinction auto-pause — fires when a clade loses its last extant member
- ✓ Substrate dashboard panel — heatmap with probe overlay; click to expand

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
