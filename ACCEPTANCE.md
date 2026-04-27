# Acceptance criteria

Per-release acceptance gates. A release tag (`r0-petri-dish`, `r1-scarcity`, ...) only lands on `main` once the matching section's criteria are all `✓`.

Marker:

- `✓` shipped
- `⋯` in progress
- `—` deferred (with rationale)

The list for a release is fleshed out when work on that release begins; speculative criteria for far-off releases just rot.

## Release 0 — Petri Dish

**Design question:** _Does the firmware-as-data idea produce interesting drift on its own, with no goals or pressure?_

### Functional (from SPEC.md)

- `✓` Probes — entities with identity, lineage, and directive-driven behavior
- `✓` Directive stacks — at least one directive kind, parameterised
- `✓` Replication — children inherit firmware deterministically from the seed
- `✓` Mutation — parameter drift on inherited firmware. Priority swap and directive loss/gain are deferred to R1: with a single `replicate` directive kind they reduce to no-ops or trivially destructive cases, so they need richer firmware to be meaningful.
- `✓` Lineage clustering — clades emerge, named lay-person legibly, and split at the divergence threshold; the lineage tree records descent
- `✓` Dashboard — always-on UI: run controls, sim controls, auto-pause, population, lineage tree, lineage inspector, events timeline
- `—` Forensic replay — events-timeline shape shipped; full state-rewind scrub deferred. The data path (host Save/Load + snapshot replay) is already in place; the UI affordance is gated on R1+ producing more events worth rewinding to (death, extinction, contact). Building it now would polish a button with little to do.

### Implicit (from ARCHITECTURE.md and PROCESS.md)

- `✓` Variable speed (1× / 4× / 16× / 64×) with pause and resume
- `✓` Auto-pause triggers — significant drift (lineage extinction waits on R1 death; remote contact triggers wait on R3+)
- `✓` Determinism — same seed → byte-for-byte same event log; locked under `test/determinism/golden/` and verified in CI
- `✓` Save / load — headless CLI (`pnpm sim --save-dir … --run-id … --resume`) and dashboard buttons; both back the same on-disk shape via `Storage`
- `✓` Headless capability — `pnpm sim` runs the same simulation without any UI attached
- `✓` Always green — format / lint / typecheck / vitest / Playwright e2e all pass on every commit to `main`
- `✓` Layered review — Layer 1 lint enforces sim-side determinism disciplines; Layer 2 review skill (`/bobivolve-review`) is authored and ready

### Acceptance test (manual)

A first-time visitor to the dashboard can, within ten minutes and without external instructions:

- start a run at a chosen seed,
- watch the population grow,
- watch named lineages emerge in the tree,
- pause when a clade speciates,
- inspect a lineage and read its drift envelope.

If they can do that, the design question — does the firmware-as-data idea produce interesting drift on its own — is answerable by playing.

### Verdict

Shipped as `r0-petri-dish`. Two items deferred with rationale: extra mutation kinds (gated on R1's richer firmware) and the state-rewind scrub UI (gated on later releases producing more events worth rewinding to). The R0 design question — does firmware-as-data drift produce something interesting on its own — is answerable by playing the dashboard.

## Release 1 — Scarcity

**Design question:** _Does selection pressure produce competitive lineage dynamics?_

### Functional (from SPEC.md)

- `✓` Sub-lattice — fixed 64×64 grid procedurally seeded with system centres (most cells are interstellar void); probes carry positions on it
- `✓` Resources — u64 scalar quantity in each cell with per-cell caps that fall off from system centres; regen scales with cap so void cells stay dead
- `✓` Resource diffusion — a fraction of each cell's resources flows to its 4 cardinal neighbours every tick, deterministically (pure integer arithmetic, no PRNG draws); boundary reflects so total resources are conserved
- `✓` Energy budgets — every probe carries an energy reservoir; basal metabolism drains it per tick, gather replenishes it, replication transfers a fixed cost from parent to child
- `✓` Starvation — when a probe's energy reaches zero at end of tick it dies and the host emits `DeathEvent`; if the lineage's last extant member dies, an `ExtinctionEvent` follows
- `✓` Gather directive — parameterised, pulls up to `rate` from the probe's cell into its energy
- `✓` Explore directive — parameterised, gates a single-step move to a uniformly random cardinal neighbour
- `✓` Replicate directive — energy-threshold gated per SPEC; replaces R0's probability mechanic
- `✓` Mutation: priority swap — adjacent directives swap with ~1.5% probability per replication
- `✓` Mutation: directive loss / gain — ~0.4% each; gain duplicates an existing directive with parameter drift on the copy, capped at MAX_FIRMWARE_LENGTH

### Implicit (from ARCHITECTURE.md and PROCESS.md)

- `✓` Determinism extends to the new mechanics — same seed produces a byte-for-byte identical event log; goldens at seed=0/1000, seed=42/3000, seed=2026/5000 are checked in and verified in CI
- `✓` Save / load round-trips the new state — probe positions, energies, and the lattice resource grid all survive a snapshot
- `✓` Headless capability extends — `pnpm sim` runs the full R1 mechanics with no UI attached
- `✓` Auto-pause: lineage extinction fires when a clade loses its last extant member; the dashboard checkbox is live
- `✓` Always green — format / lint / typecheck / vitest / Playwright e2e all pass on every commit to `main`

### Acceptance test (manual)

A first-time visitor to the dashboard can, within ten minutes and without external instructions:

- start a run at a chosen seed,
- watch the population grow, plateau, and oscillate as births balance deaths,
- watch named lineages compete — some thrive, some go extinct,
- catch at least one extinction auto-pause as a clade collapses,
- compare two surviving clades in the lineage inspector and see how their firmware has diverged under pressure.

If they can do that, the design question — does selection pressure produce competitive lineage dynamics — is answerable by playing.

### Verdict

Shipped as `r1-scarcity`. The R1 design question is now answerable from the dashboard: open a run, watch the lattice fill, watch lineages compete and die, compare drift envelopes between survivors. Selection pressure is the new variable, and lineage dominance no longer correlates with founding age alone.

## Release 2 — The Engineer's Console

**Design question:** _Does the player's role as meta-programmer feel meaningful?_

R2 turns the player from a spectator into a participant. The simulation already produces lineages that compete, drift, and die; R2 lets the player author firmware modifications, queue them to fire on conditions, and suspend lineages from replicating. Interventions are part of the genetic record — a patch becomes a directive that descendants inherit and that mutation can drift forward. The Origin compute budget makes intervention scarce, so patch authoring is a decision rather than a tic.

### Functional (from SPEC.md)

- `⋯` Quarantine — a per-lineage suspension that halts replication for any probe in that lineage; reversible; survives save/load. The simplest intervention; lands first as the smoke test for the whole intervention pipeline.
- `⋯` Origin compute — renewable u64 budget regenerated per tick. Patch authoring (and decree queueing) consumes it; quarantine is free. Exposed to the dashboard so the player can see what they can afford.
- `⋯` Patches — directive editor authors a modification to a target lineage's firmware. Applied patches mutate the lineage's reference firmware so descendants inherit; the patch itself drifts forward like any directive (parameter drift, priority swap, loss/gain). Versioned: each patch carries an id and a target lineage id; the lineage tree records when the patch landed.
- `⋯` Decrees — conditional patches queued to fire when their triggers match. R2 ships a narrow trigger set (population threshold, lineage near-extinction, drift-event); broader triggers wait on later releases that produce the events. Trigger evaluation is a pure function of state — no PRNG draws.
- `⋯` Intervention-versioned lineage tree — the lineage tree shows patches as overlays on the lineages they touched, so the propagation of a player intervention is visible alongside natural speciation.
- `⋯` PatchSaturated auto-pause trigger — fires when a player-authored patch reaches X% of the population. The trigger and the field number are reserved in the schema; R2 wires them.

### Implicit (from ARCHITECTURE.md and PROCESS.md)

- `⋯` Determinism extends to interventions — the same (seed, command-log) including patch / decree / quarantine commands produces a byte-for-byte identical event log. Goldens for at least one R2 case (an applied patch that propagates through a lineage) are checked in and verified in CI.
- `⋯` Save / load round-trips intervention state — quarantines, queued decrees, applied-patch metadata, and the Origin compute budget all survive a snapshot.
- `⋯` Headless capability extends — `pnpm sim` accepts a command script that includes patches, decrees, and quarantines, and produces the same event log a UI-driven session would.
- `⋯` Always green — format / lint / typecheck / vitest / Playwright e2e all pass on every commit to `main`.

### Deferred to a later release (with rationale)

- `⋯` Forensic replay scrub UI — listed in TODO under `#r2 #ui` and unblocked by R2's richer event set. Bundle into R2 if it fits the pacing; otherwise it ships when the Layer 2 review judges the affordance worth the integration noise. The data path (snapshots + log replay) is already in place; only the affordance is missing.
- `—` Patch-incompatibility between forks — SPEC places this at R5 (Communion). Out of scope for R2.

### Acceptance test (manual)

A first-time visitor to the dashboard can, within ten minutes and without external instructions:

- start a run at a chosen seed,
- watch lineages emerge, compete, and one of them begin to fade,
- author a patch that adjusts the fading lineage's firmware,
- watch the patch propagate through descendants and either rescue the lineage or fail to,
- queue a decree that responds to a future condition (e.g. another lineage near-extinction),
- quarantine a lineage that's outcompeting the rest, and watch the rest of the swarm rebalance,
- compare two clades in the lineage inspector and see, for each, the patches that have landed on it.

If they can do that, the design question — does the player's role as meta-programmer feel meaningful — is answerable by playing.
