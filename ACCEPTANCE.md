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
- `⋯` Mutation — parameter drift only. Priority swap and directive loss/gain need ≥2 directive kinds in the firmware to be meaningful; with the single `replicate` kind in R0 they reduce to no-ops or trivially destructive cases. Carrying them as deferred is honest.
- `✓` Lineage clustering — clades emerge, named lay-person legibly, and split at the divergence threshold; the lineage tree records descent
- `✓` Dashboard — always-on UI: run controls, sim controls, auto-pause, population, lineage tree, lineage inspector, events timeline
- `⋯` Forensic replay — light shape shipped (events timeline of significant events); full state-rewind scrub stays as a polish item. The data path (host Save/Load + snapshot replay) is in place; the UI affordance is what's missing.

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

Pending sign-off. The two `⋯` items are honestly carried: extra mutation kinds are gated on richer firmware (arguably an R1 prerequisite); state-rewind scrub is a polish item the data path already supports. R0 is otherwise fundamentally shippable.
