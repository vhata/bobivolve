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
- `✓` Forensic replay — events-timeline shape shipped here; full state-rewind scrub landed in R2 once richer events were available to rewind to.

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

Shipped as `r0-petri-dish`. The R0 design question — does firmware-as-data drift produce something interesting on its own — is answerable by playing the dashboard. Both deferrals from the original R0 scope have since landed: the extra mutation kinds (priority swap, directive loss/gain) shipped with R1, and the state-rewind scrub UI shipped with R2.

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

- `✓` Quarantine — a per-lineage suspension that halts replication for any probe in that lineage; reversible; survives save/load.
- `✓` Origin compute — renewable u64 budget regenerated per tick, gating every player intervention. Patch and decree authoring consume a one-shot cost on submission; quarantine consumes a smaller per-tick maintenance cost while held. Exposed in the dashboard so the player can see what they can afford and what their current holds are draining.
- `✓` Patches — directive editor authors a modification to a target lineage's firmware. Applied patches overwrite the lineage's reference firmware and every extant probe; descendants inherit, and the patch drifts forward like any directive. Versioned: each patch carries an id and a target lineage id, and the inspector renders the patches that have landed on the clade.
- `✓` Decrees — modal composer queues a conditional patch (trigger + target lineage + firmware). R2 ships a narrow trigger set (lineage population below threshold); broader triggers wait on later releases that produce the events. Trigger evaluation is a pure function of state — no PRNG draws.
- `✓` Intervention-versioned lineage inspector — each lineage's patches list is rendered next to its identity panel; child lineages inherit their parent's patches at speciation so the history follows the clade.
- `✓` PatchSaturated auto-pause trigger — fires once when a player-authored patch's carriers exceed 50% of the population.
- `✓` Forensic replay — clicking an event in the timeline rewinds the sim to that tick. The host loads the latest in-run snapshot at-or-before the target, replays any logged commands, and lands exactly on the target. Destructive — post-rewind state is forfeit; the action sits behind a confirm modal and a "rewinding…" overlay.
- `✓` Phylogeny view — alternate tab beside the living-lineages tree. Renders every lineage the run produced on a tick axis, with branching at speciation moments and a lifeline showing each clade's duration.
- `✓` New-visitor tour — guided overlay walks first-time players through the dashboard in the order the acceptance test exercises it; auto-fires once on first visit, "?" in the header reopens.

### Implicit (from ARCHITECTURE.md and PROCESS.md)

- `✓` Determinism extends to interventions — the same (seed, command-log) including patch / decree / quarantine commands produces a byte-for-byte identical event log. Goldens are checked in and verified in CI.
- `✓` Save / load round-trips intervention state — quarantines, queued decrees, applied-patch metadata, and the Origin compute budget all survive a snapshot.
- `✓` Headless capability extends — `pnpm sim` accepts a command script that includes patches, decrees, and quarantines, and produces the same event log a UI-driven session would.
- `✓` Always green — format / lint / typecheck / vitest / Playwright e2e all pass on every commit to `main`.

### Deferred to a later release (with rationale)

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

### Verdict

Shipped as `r2-engineers-console`. Every intervention shape works end-to-end through the dashboard: patches, decrees, quarantines, all gated by the Origin compute budget (one-shot for patches and decrees; per-tick maintenance while a quarantine is held). The lineage inspector exposes the lineage's patches list so a clade's intervention history follows it through speciation. PatchSaturated is wired both as a sim event and an auto-pause trigger. The new-visitor tour walks first-time players through run → lineages → drift → interventions → pacing in the same order the acceptance test exercises them, and a header "?" reopens it. Forensic replay rewinds the sim to any past speciation tick (destructive — post-rewind state is forfeit; the rewind sits behind a confirm modal and a "rewinding…" overlay so the player isn't surprised). The Lineage panel toggles between Living (present-tense glance — top-N clades by population, hierarchy, trend glyphs) and Phylogeny (retrospective branching diagram on a tick axis, every lineage the run produced). The R2 design question — does the player's role as meta-programmer feel meaningful — is answerable from the dashboard end-to-end.
