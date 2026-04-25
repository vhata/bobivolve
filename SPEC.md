# Bobivolve

*Working title.*

## Overview

Bobivolve is a real-time evolutionary simulation. The player observes — and from Release 2 onward, directs — a population of self-replicating probes whose behavior is governed by inheritable, mutable firmware. Behavior is encoded as a stack of directives that drift across generations. Lineages emerge, compete, dominate, and collapse. Selection pressure makes drift consequential. External constraints, when added in later releases, force stewardship decisions whose effects propagate through the swarm's genetic record.

The setting borrows premises from Dennis E. Taylor's *Bobiverse* novels — Von Neumann probes, replicative drift, a galaxy with neighbors — but the world, species, and emergent events are procedurally generated.

## Player Role

The player is the **Origin**: the author of the swarm's initial firmware and, in later releases, of its updates. The player does not control individual probes. Player actions are limited to:

- Observing the swarm through a dashboard
- Naming lineages
- Inspecting firmware and replay history
- Authoring patches (R2+)
- Queueing conditional decrees (R2+)
- Configuring auto-pause triggers
- Investing in observation infrastructure (R7+)

The role progresses across releases from observer to engineer to governor.

## Glossary

- **Probe.** Autonomous entity that consumes resources, replicates, and executes a directive stack.
- **Directive.** A parameterized behavior unit (e.g. *gather*, *replicate*, *explore*, *defend*) with a priority and parameters.
- **Directive Stack.** Ordered list of directives a probe executes. Equivalent to the probe's firmware.
- **Mutation.** Random alteration to a directive's parameters or position on replication. Most mutations are silent.
- **Lineage / Clade.** Cluster of probes descended from a common ancestor whose firmware has not diverged enough to be considered a new lineage.
- **Drift.** Accumulated change in a lineage's firmware over generations.
- **Speciation.** Drift event sufficient to cluster the diverging probes as a new named lineage.
- **Origin.** The player's seat. In-world entity from R8 onward.
- **Patch.** Player-authored modification to a lineage's directive stack. Costs Origin compute. Inheritable.
- **Decree.** Conditional patch queued to fire when triggers are met.
- **Quarantine.** Player intervention that suspends a lineage's replication, halting further propagation. From R5, also blocks firmware evangelism to neighboring lineages.
- **Substrate.** The simulation space in which probes operate.
- **Sub-lattice.** Coarse grid overlaid on the substrate. Used for resource diffusion and (from R7) communication latency.
- **Origin compute.** Renewable budget that gates patch authoring.

## Simulation Mechanics

### Galaxy and Scale

The substrate is procedurally generated from a seed. Star systems, resources, and civilization placements are deterministic functions of the seed rather than pre-authored content. Most of the substrate is dormant; systems resolve into full simulation state on first probe entry and remain dormant until then.

The explored region is intentionally modest. Bobivolve targets a contained galaxy of a few dozen densely-populated systems, each of which earns its presence, rather than a sprawling galaxy of thousands of empty ones. Apparent scale comes from procedural unknowns at the frontier, not from raw system count.

### Replication and Mutation

Probes replicate when their internal energy passes a directive-defined threshold. Replication produces a copy of the parent's directive stack with a small probability of mutation per directive. Mutation types:

- **Parameter drift.** A directive's numeric parameter is perturbed by a small random amount.
- **Priority swap.** Two adjacent directives swap order.
- **Directive loss or gain.** Rare. A directive is removed, or a duplicate is inserted with altered parameters.

### Lineage Tracking

Probes are clustered into lineages based on firmware similarity to a reference genome. New lineages are named at the point of speciation. Lineage trees persist across the session and are inspectable in the dashboard.

### Selection (R1+)

Probes consume resources from the substrate to maintain energy. Resources diffuse across the sub-lattice. Probes that fail to maintain energy stop functioning. Selection pressure emerges from this scarcity.

### External Entities (R3+)

Two archetypes are introduced at R3:

- **Others.** Hostile self-replicating swarms. Episodic. Force existential crises.
- **Deltans.** Pre-contact species present in some systems. Fragile. Treaty violations occur when probes act on Deltan worlds.

R4 generalizes these into procedurally rolled archetypes. R6 promotes the Others to a full firmware simulation that co-evolves with the player's swarm.

### Player Intervention (R2+)

The player has three intervention tools, all gated by the Origin compute budget:

- **Patches** are authored in a directive editor and applied to a target lineage. Once applied, the patched directives are inherited by descendants and drift like any other firmware: a player intervention becomes part of the genetic record and can mutate forward in ways the player did not anticipate.
- **Decrees** are conditional patches queued to fire when their triggers match.
- **Quarantine** suspends a lineage's replication, halting further propagation. From R5, also blocks firmware evangelism to neighboring lineages.

All interventions are versioned and tagged so their propagation through the lineage tree is traceable in the dashboard.

## Dashboard

Always-on UI panel. The primary unit of attention is the lineage, not the individual probe — population, drift, and lineage trees aggregate at the clade level by default, with per-probe data available through the inspector. This keeps the interface readable as the swarm grows.

Panel contents:

- Population graphs by lineage
- Lineage tree with named clades and divergence markers
- Per-probe inspector (firmware, energy, location, lineage)
- Drift telemetry (rate of change per parameter, per lineage)
- Forensic replay (scrubable timeline of past events)
- Auto-pause trigger configuration
- (R2+) Patch editor, decree queue, quarantine controls
- (R7+) Observation infrastructure controls; telemetry shown with reliability indicators

## Pacing Model

Real-time. Variable speed: 1x, 4x, 16x, 64x.

Auto-pause triggers are user-configurable. Default trigger set:

- First contact with a new sentient species
- Hostile entity detected within N sub-lattice cells of any probe
- Treaty violation
- Patch saturation (a player-authored patch reaches X% of population)
- Lineage extinction (a named lineage drops below N members)
- Significant drift event (a clade diverges enough to warrant a new lineage stamp)

Pause is non-modal: inspection, patch authoring, and decree queueing all occur during pause without exiting it.

## Release Roadmap

Each release is a self-contained content drop. A release's purpose is to push back the point at which the previous release loses its novelty. Every release ships as a complete, playable game.

### Release 0 — Petri Dish

**Adds:** Probes, directive stacks, replication, mutation, lineage clustering, dashboard, forensic replay.
**Design question:** Does the firmware-as-data idea produce interesting drift on its own, with no goals or pressure?

### Release 1 — Scarcity

**Adds:** Resources, resource diffusion across the sub-lattice, energy budgets, starvation.
**Design question:** Does selection pressure produce competitive lineage dynamics?

### Release 2 — The Engineer's Console

**Adds:** Patch authoring, decree queueing, lineage quarantine, Origin compute budget, intervention-versioning in the lineage tree.
**Design question:** Does the player's role as meta-programmer feel meaningful?

### Release 3 — First Contact

**Adds:** The Others, the Deltans, treaty-violation events, crisis-mode pacing.
**Design question:** Does the crisis-aftermath-tragedy loop produce stories worth retelling?

### Release 4 — A Galaxy of Tenants

**Adds:** Procedural civ archetypes along five axes (hostility, sophistication, fragility, communicativeness, stance volatility); trade and diplomacy directives; stance-shift events.
**Design question:** Does archetype variety force generalized firmware policy rather than scripted responses?

### Release 5 — Communion

**Adds:** Inter-clade interactions; firmware evangelism; speciation events; patch-incompatibility between forks.
**Design question:** Does internal swarm politics keep the quiet stretches interesting?

### Release 6 — Dim Mirror

**Adds:** Full firmware simulation for the Others; adversarial co-evolution; counter-adaptation; captured-firmware analysis.
**Design question:** Does adversarial evolution keep encounters fresh after the player has learned the basic counters?

### Release 7 — The Long Shadow

**Adds:** Communication lag; fog of war; observation infrastructure (listening posts, scout probes); unreliable telemetry; false reports.
**Design question:** Does information scarcity make decisions harder in productive ways?

### Release 8 — The Origin

**Adds:** The Origin as an in-world entity with location and vulnerability; threats to home; recovery mechanics.
**Design question:** Does an existential end-game stake change the player's relationship to risk?

### Release 9 — The Long Memory

**Adds:** Persistent civ memory; mission stack; reputation system; multi-session continuity; named events in galactic history.
**Design question:** Does the game function as a chronicle rather than a chain of disconnected sessions?

## Out of Scope

Not goals of any release:

- Direct probe control
- Combat as unit-level micromanagement
- Conventional research-based tech trees
- Win/lose conditions delivered as a victory screen
- Multiplayer
