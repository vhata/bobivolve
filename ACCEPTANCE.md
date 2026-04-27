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

- `⋯` Sub-lattice — fixed-size 2D grid; probes carry positions on it; resources live per cell
- `⋯` Resources — u64 scalar quantity in each cell, with constant regen
- `⋯` Resource diffusion — a fraction of each cell's resources flows to its neighbours every tick, deterministically (pure integer arithmetic, no PRNG draws)
- `⋯` Energy budgets — every probe carries an energy field; basal metabolism drains it per tick, gather replenishes it, replication deducts a fixed cost
- `⋯` Starvation — when a probe's energy reaches zero it dies; the host emits `DeathEvent`
- `⋯` Gather directive — a parameterised directive that pulls resources from the probe's cell into its energy. Founder firmware becomes `[gather, replicate]`.
- `⋯` Mutation: priority swap — meaningful now that the firmware has ≥2 directive kinds (carried over from R0's deferred list)
- `⋯` Mutation: directive loss / gain — same gate; same carry-over

### Implicit (from ARCHITECTURE.md and PROCESS.md)

- `⋯` Determinism extends to the new mechanics — same seed produces a byte-for-byte identical event log including resource fields and death events; covered by the determinism golden
- `⋯` Save / load round-trips the new state — probe positions, energies, and the lattice resource grid all survive a snapshot
- `⋯` Headless capability extends — `pnpm sim` runs the full R1 mechanics with no UI attached
- `⋯` Auto-pause: lineage extinction now actually fires (the death-event path is live)
- `⋯` Always green — format / lint / typecheck / vitest / Playwright e2e all pass on every commit to `main`

### Acceptance test (manual)

A first-time visitor to the dashboard can, within ten minutes and without external instructions:

- start a run at a chosen seed,
- watch the population grow, plateau, and oscillate as births balance deaths,
- watch named lineages compete — some thrive, some go extinct,
- catch at least one extinction auto-pause as a clade collapses,
- compare two surviving clades in the lineage inspector and see how their firmware has diverged under pressure.

If they can do that, the design question — does selection pressure produce competitive lineage dynamics — is answerable by playing.

### Verdict

Pending. Acceptance criteria are open; the work just begun.
