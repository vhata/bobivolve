# R3 proposal: shelter or expansion

Status: proposed design for review, 2026-09-24. The player delegated overnight design decisions and requested review before landing. This document resolves the kickoff brief into one implementable direction; none of its mechanics or acceptance results are shipped. [SPEC.md](../SPEC.md#release-3--first-contact) owns the release roadmap.

## The decision the player makes

A clade reaches a fertile system inhabited by Deltans. An Others incursion puts nearby probes under pressure. The player can protect the inhabited cells and accept slower growth or starvation elsewhere, or continue harvesting and replicating there and cause irreversible harm. A conditional policy should carry the player's decision into descendants; mutation can erode its protection.

Success is a player explaining: “I protected that world, which cost my clade access to those resources. This descendant lost the protection and wiped it out.” The UI must show the policy, its actual carriers, the lost resource opportunity, and the action that caused the harm. A taint badge alone is insufficient.

## Decisions for the first implementation

| Area           | Proposed rule and rationale                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deltans        | A small set of inhabited resource cells, each with a stable ID, discovered flag, and alive/extinct state. No entities or diplomacy AI. Choose cells from existing nonzero resource caps outside the founder's immediate neighbourhood so contact precedes routine exploitation.                                                                                  |
| Discovery      | A probe's entry reveals the cell and emits first contact once per site. Only discovered sites appear in player queries and overlays. Retain discovery through saves and replay; do not let the new query reveal hidden sites.                                                                                                                                    |
| Harm           | Occupation, positive resource extraction, and successful replication are separate severities. Mere presence is reversible operationally but remains in history; extraction marks exploitation; successful replication makes that site's extinction permanent in that timeline. A failed/no-yield directive causes no extraction or replication violation.        |
| Event volume   | Emit each new `(site, lineage, severity)` milestone once. Keep counts and last occurrence for repeated actions rather than emitting a high-priority milestone every tick. Record the probe, lineage, cell, action, tick, and policy provenance that caused each escalation.                                                                                      |
| Inheritance    | Store a lineage severity summary inherited at speciation, plus the original incident references. Future offences by an ancestor do not retroactively taint already-diverged children. Site extinction remains global to the run.                                                                                                                                 |
| Others         | One non-firmware incursion record with stable ID, centre, radius, and expiry. It does not replicate or speciate in R3. Select an occupied resource region deterministically; never spawn on the founder's first tick. Broader archetypes stay in R4.                                                                                                             |
| Encounter      | After directives and before death, iterate the tick-start probes in stable ID order. For each probe in the footprint, consume exactly one encounter draw; a hit subtracts energy, allowing the existing death phase to resolve the consequence. Emit aggregated per-incursion/tick damage plus individually traceable deaths. No second combat simulation.       |
| Initial tuning | First incursion at tick 5,000 plus seed-derived jitter up to 1,000; subsequent incursions at that interval after expiry. Radius 2, duration 250 ticks, hit probability 1/16, damage 100 energy. These are explicit prototype values, subject to seeded balance evidence, not accepted difficulty settings.                                                       |
| Pacing         | Default auto-pause on first contact and the first new violation severity, after delivering the entire committed tick. A crisis caps effective speed at 4× for 250 ticks after the latest milestone or until an active incursion expires, whichever is later. Keep requested speed separately and show both; expiry restores the requested speed, never unpauses. |
| Player cost    | Existing patch/decree authoring costs remain. Protection gives up access to the marked resource cells; damage makes that opportunity cost visible. Do not add a second emergency currency or cost multiplier. R2 upkeep balancing is a separate gate.                                                                                                            |

The earlier 50,000-tick incursion guess is too late for a short session and precedes an established long-session performance budget. Prototype contact earlier; choose final cadence after measuring encounters, viable responses, and the browser session budget.

## A policy that can actually protect a cell

The old brief proposed only a `proximityToCell` decree trigger. That detects a situation but cannot express avoidance with today's gather/explore/replicate directives. The prototype therefore needs one additional firmware directive: `protectedZone { x, y, radius }`.

Treat protection as a constraint collected before action execution, regardless of its stack position. A probe carrying it cannot gather or replicate inside any protected zone. Evaluate distances with squared integer Euclidean distance, including the boundary; multiple zones form a union. Coordinates must be inside the lattice and radius must be 0–8 inclusive. Host validation happens before charging compute.

Exploration from outside that union refuses destinations inside it. An existing occupant may take ordinary exploration steps, including steps that remain inside the union, until it reaches an unprotected cell; from there, re-entry is refused. This permits gradual escape through overlapping zones without extra history state or a guaranteed escape time. Gathering and replication remain blocked on every protected cell throughout. Apply the constraint after the normal exploration gate and destination draws; reject a forbidden candidate without redrawing, forced movement, or free energy.

The directive is inheritable. Initially mutate only radius by one cell, clamped to bounds; existing directive loss/duplication can also remove or duplicate protection. Keep the centre stable so a minor mutation cannot silently relocate a treaty. Compare the current firmware with the authored zone in the inspector. A historical patch ID must never be presented as proof that current descendants still protect the same area.

Add `proximityToCell { lineageId, x, y, radius }` for decrees: it fires when any living probe in the monitored lineage is in range. The queued patch still targets its explicit lineage, using existing semantics. Evaluate at the existing end-of-tick decree phase, so it protects subsequent ticks; the editor must say that entry-tick harm is possible. Proactive protection or direct patching while paused is the safe option. Do not silently apply patches to every existing descendant; make the target population and limited scope visible before submission.

## Dashboard and protocol

Add one Contact panel: discovered inhabited sites, active incursions, incident summaries, and “inspect responsible clade”/“inspect policy”/“rewind to incident” actions. The substrate gets discovered-site and incursion overlays. The inspector distinguishes inherited history from current protective behaviour. The timeline keeps first contact, escalation, site extinction, incursion start/end, and associated policy changes prominent; encounter aggregates remain optional detail.

Add plain-data contact queries and events, the protected-zone directive parameters, and the proximity trigger to both `protocol/types.ts` and `schema.proto`. Keep existing field numbers. Extend NDJSON codecs with exact integer round trips and worker filtering deliberately. Query results must be scoped to the active timeline; a switch or rewind invalidates contact selections and summaries.

## Determinism, saves, and release sequencing

Persist contact state, discovery, incident deduplication keys, crisis expiry, next incursion schedule, and any added RNG stream state. Use an explicitly versioned new-run ruleset: existing R2 saves continue with R2 rules, while new R3 runs use the new rules. Do not reinterpret old logs under new simulation laws. This version boundary is required implementation work, not an existing migration guarantee.

Document PRNG draw order before regenerating new-rules goldens. Round-trip through snapshot, log-only rebuild, named saves, rewind, and CLI intervention scripts. Compare complete state and ordered event histories, including commands at the same tick as discovery or extinction.

Implement as a dependency stack, each layer targeting the preceding branch:

1. **Ruleset and persistence boundary:** old-run compatibility, new state, codecs, and deterministic fixtures.
2. **Protective policy:** constraints, mutation/validation, proximity decrees, and seeded cost/consequence cases.
3. **Contact simulation:** discovery, incidents, incursions, bounded event volume, and crisis state.
4. **Player surfaces:** Contact panel, map overlays, policy feedback, and complete browser dilemma.

The current proposal PR depends on the [R2 experiment and player-facing decisions](R2_ENGINEER_LOOP_EXPERIMENT.md#delegated-cost-model-pass--2026-09-24) because its player-facing clade and provenance choices carry forward. Implementation remains a separate reviewed stack after the R2 and browser-budget evidence has been assessed. Do not tag a release as part of this work.

## Acceptance evidence to collect

- A fixture reaches an inhabited cell; zero-yield gather and blocked replication cause no false violation. Positive extraction escalates once; successful replication emits exactly one extinction.
- Protected-zone boundaries, duplicate zones, and removal/radius mutation behave as described without extra movement PRNG draws. An occupant at the centre of a radius-2 zone can escape over ordinary steps, including through overlapping zones; intermediate protected cells still block gathering and replication. Once outside the union, re-entry is refused and a rejected step does not redraw.
- A queued proximity response cannot prevent harm earlier in its firing tick, and the player sees that limitation before queueing it.
- The same contact history survives full-state save/load, missing-cache rebuild, same-tick rewind, run switching, and scripted headless replay. R2 saves retain R2 outcomes.
- Crisis speed caps never resume a paused game; expiry restores requested speed. Invalid commands do not spend compute.
- Three seeds and rich/poor resource cases admit a surviving protective strategy and an exploiting strategy with visibly different costs and consequences. If protection is always fatal or exploitation always dominates, retune before a player study.
- A ten-minute human session identifies the site, authors a policy, explains its cost, and traces one descendant's unintended consequence without source-code help. Automated browser interaction does not satisfy this gate.

Review decisions are concentrated in the new protective directive, early contact pacing, the treatment of replication as extinction, and the R2-save compatibility boundary. All numbers remain prototype tuning until measured.
