# Features

Grouped by release. Each entry is one line, marked `✓` shipped or `⋯` in progress.

Updated in the same commit as any feature whose status changes.

## Release 2 — The Engineer's Console

- ✓ Quarantine — a player can suspend a lineage's replication from the inspector; the suspension is reversible and the tree marks quarantined lineages with a pip
- ✓ Origin compute — renewable budget regenerates per tick; patch and decree authoring each consume a one-shot cost, held quarantines drain a per-tick maintenance cost; the dashboard shows the budget bar and the current drain
- ✓ Patches — the lineage inspector opens a modal directive editor on click; submitted patches replace the lineage's reference firmware and every extant probe, with PATCH_AUTHORING_COST charged against Origin compute; descendants inherit and drift like any firmware
- ✓ Decrees — modal composer queues a conditional patch (trigger + target lineage + firmware); R2's trigger set is "lineage population below threshold"; the queue panel lists pending decrees and lets the player revoke before firing
- ✓ Intervention-versioned lineage tree — each lineage's patches list is exposed via the drift telemetry query and rendered in the inspector; child lineages inherit their parent's patches at speciation so the history follows the clade
- ✓ PatchSaturated auto-pause — fires once when a player-authored patch's carriers exceed 50% of the population; lineages inherit patches at speciation so the saturation count tracks descendant clades automatically
- ✓ New-visitor tour — a guided overlay walks first-time players through the dashboard in the order they need to learn it (run → population → lineage tree → drift → intervention surface → Origin compute → pacing); auto-fires once and sleeps, with a "?" affordance in the header to reopen on demand

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
