# TODO

Deferred work and unresolved decisions. Follow [the TODO guide](docs/TODO_GUIDE.md). Ready entries are unblocked; live claims are found in branches, worktrees, and draft PRs. Migration preserves existing outcomes and design gates without approving a redesign.

## Needs triage

### Unprioritized

- [PERFORMANCE] `browser-session-budgets` — **Validate browser session budgets and retention.** Implement and validate the [proposed browser session/storage budgets and retention policy](docs/BROWSER_PERSISTENCE_BUDGET.md): wider seed/device/repeat measurements, cadence/anchor comparison, and quota warnings. Chromium OPFS and rendered rewinds are measured through 30,000 ticks; 5,000 ticks is the initial local playtest envelope. No budget or pruning is enforced yet. #host #performance
  - Source: TODO.md at `67839b2`, migrated 2026-10-06; original release and area tags retained.
  - Blocked by: Browser measurements, retention choices, and human playtest evidence are incomplete.
  - Coordination: Open PR #31 implements explicit named-save deletion; do not duplicate its scope.

- [TOOLING] `protobuf-codegen` — **Generate protocol types when a consumer exists.** Wire protobuf codegen into the prebuild step (ts-proto + protoc, or buf) once a consumer of generated types lands #r0 #toolchain
  - Source: TODO.md at `67839b2`, migrated 2026-10-06; original release and area tags retained.
  - Blocked by: A consumer of generated protocol types must land first.

- [SIM] `sim-clock-port` — **Introduce a Clock port when telemetry needs it.** `Clock` port for sim core (when achieved-speed telemetry needs it) #r0 #sim
  - Source: TODO.md at `67839b2`, migrated 2026-10-06; original release and area tags retained.
  - Blocked by: Achieved-speed telemetry must first establish a need.

- [HOST] `named-save-log-recovery` — **Recover named saves from logs when snapshots are unusable.** Extend rebuild-from-log to the named-save Load path. `handleSave` already captures a fresh snapshot at save-time (so save_tick is exactly the snap's tick); the gap is on the Load side — `handleLoad` (named save slot) still fails fast when the save's `.save` snapshot is missing or unreadable. Two minimal-cost paths to close it: **(A')** add a `runId` field to the saves-index entry and have Load fall back to `restoreToTick(saveTick, runLogEntries, persistence)` using the save's recorded runId when the `.save` file is missing — requires the run's log to still exist, which usually does. **(B)** Bundle a `<slot>.log` file alongside `<slot>.save` containing event-log entries the loader can replay forward — invents a new on-disk container, legacy saves degrade to today's behaviour. Decision pending. #r0 #host
  - Source: TODO.md at `67839b2`, migrated 2026-10-06; original release and area tags retained.
  - Blocked by: Choose run-log references versus bundled save logs.

- [UI] `preview-forensic-replay` — **Preview a scrub before committing rewind.** Forensic replay — preview-then-commit scrub mode. R2's forensic replay ships as a destructive rewind: clicking a timeline event loads to that tick and the post-rewind state is forfeit. A nicer UX is preview during drag (dashboard shows historical state without touching the live run), with an explicit "rewind here" commit button or a release-to-cancel. That design needs the host to maintain two parallel states (live and scrub-preview) and a query path that can serve historical state without disturbing the active run — a meaningful new architecture. Deferred until destructive scrub proves load-bearing enough to justify the lift; in the interim, Save-before-scrub gives the player a safe-out one click away. #r2-stretch #ui #host
  - Source: TODO.md at `67839b2`, migrated 2026-10-06; original release and area tags retained.
  - Blocked by: Validate the need and the isolated preview-state architecture.

- [HOST] `host-timeline-surfacer` — **Persist event surfacing across dashboard sessions.** Host-side TimelineSurfacer for the events panel. Today the two-strata + speciation-filter logic lives client-side in `EventsTimelinePanel.tsx`: the heuristic state (surfaced + candidate buffers) is per-mount, so closing the dashboard or switching runs forfeits any in-flight retroactive promotions. Moving the surfacer into the host (per the brainstorm sketch in the deleted `BRAINSTORM/rewindable-events.md`, with an additive `timelineBuffer` query) makes promotion survive UI sessions and lets a future Rust child speak the same surface. Defer until the client-side version proves the design; today's implementation is the load-bearing test of the two-axis filter. #r2-stretch #ui #host
  - Source: TODO.md at `67839b2`, migrated 2026-10-06; original release and area tags retained.
  - Blocked by: Validate the client-side design and the need for host persistence.

- [HOST] `milestone-snapshots` — **Bound milestone rewind replay distance.** Snapshot-on-stratum-1 trigger. ARCHITECTURE.md once promised "one snapshot just before any auto-pause-trigger event fires" but it isn't wired. With more first-class rewindable events (extinction, patchSaturated, autoPaused now; firstContact / treatyViolation in R3), a milestone rewind walks the cadence-distance backward through the log, which can be tens of thousands of ticks. Cheap to fix — `maybeWriteSnapshot(force=true)` after each stratum-1 emission. #r2-stretch #host
  - Source: TODO.md at `67839b2`, migrated 2026-10-06; original release and area tags retained.
  - Blocked by: Resolve pre-event versus post-event snapshot semantics and benchmark storage cost.

- [DESIGN] `r3-contact-dilemma` — **Assess the proposed First Contact dilemma before implementation.** The [contact dilemma proposal](docs/R3_CONTACT_DILEMMA.md) consolidates the kickoff brief, resolves its missing avoidance behaviour, and defines the dependent implementation slices and evidence to collect. Prepared under the player's delegated design authority on 2026-09-24; review before landing. R3 implementation follows assessment of the R2 experiment and browser session budgets, plus review of the proposed mechanics. #r3 #design
  - Source: [contact dilemma proposal](docs/R3_CONTACT_DILEMMA.md), TODO.md at `67839b2`, migrated 2026-10-06.
  - Depends on: `r2-engineer-loop`, `browser-session-budgets`
  - Blocked by: User review of the proposed mechanics and design pass before implementation.

## Needs proof of concept

### Unprioritized

- [DESIGN] `r2-engineer-loop` — **Complete the R2 engineer-loop experiment.** Complete the [R2 engineer-loop experiment](docs/R2_ENGINEER_LOOP_EXPERIMENT.md) with player sessions and a chosen cost model before R3: stable player-facing clades, meaningful firmware trade-offs, understandable editor units, explicit compute exhaustion, and provenance versus retained patch behaviour. Seeded free/upkeep comparisons and delegated player-facing decisions are recorded; the cost prototype is experiment-only. Pinned ancestry groups, firmware editor units/reference comparisons with current authoring costs, patch ancestry versus exact firmware retention, and explicit quarantine exhaustion now ship. Remaining work is the reviewed dashboard prototype for upkeep and a local predicate, tariff tuning, and human sessions. #r2 #design
  - Source: TODO.md at `67839b2`, migrated 2026-10-06; original release and area tags retained.
  - Blocked by: Human sessions, tariff tuning, and a reviewed dashboard prototype are pending.
  - Coordination: PRs #29 (provenance) and #30 (exhaustion) implement subsets; do not duplicate their scopes.

- [PERFORMANCE] `snapshot-cadence` — **Tune snapshot cadence against browser targets.** Tune snapshot cadence against the [measured browser rewind and storage targets](docs/BROWSER_PERSISTENCE_BUDGET.md). Keep 30,000 ticks for now; see the [filesystem benchmark and its limits](docs/SNAPSHOT_BENCHMARK.md). The earlier in-memory copy table did not measure total snapshot cost. #r0 #host
  - Source: TODO.md at `67839b2`, migrated 2026-10-06; original release and area tags retained.
  - Blocked by: Collect and assess wider browser measurements before changing the 30,000-tick cadence.
  - Depends on: `browser-session-budgets`

- [UI] `phylogeny-muller-plot` — **Prototype population-banded phylogeny.** Phylogeny redesign — muller plot (Passes 1 and 2). Replace the per-lineage row stack with a population-banded clade flow: y-axis is share-of-population (always 100%, canvas-bounded), x-axis is tick, each clade is a coloured stream whose thickness is its live population at that tick, speciation is a tributary split, extinction pinches to zero. Default filter shows living clades + their direct ancestors (per the hide-don't-compress codified pattern); an "include extinct" toggle reveals the rest. Closes both the legibility complaint ("still a bit baffling") and the long-run row-scaling problem (no rows → no per-row pixel ceiling) in one stroke. Pass 0 shipped at commit `8656fc9` (extinctionTick on lineageTree). **Pass 1**: muller plot over the existing 240-sample `populationHistory` rolling window — UI-only, no protocol change. **Pass 2**: add a `phylogenyHistory` query that returns per-clade population time-series at a sim-side sample cadence (suggested every 100 ticks) for full-run fidelity — additive protocol change. Alternatives rejected during brainstorm: drift-envelope clade collapse (captures current state, not history), radial cladogram (same equal-weight problem as today's view), stroke-width modulation alone (keeps rows), virtualised scrolling (fixes ceiling, not legibility), pure significance-threshold decimation (silent information loss), time-binning (absorbed as horizontal-scaling fallback). Open guesses to validate before shipping Pass 1: default-show-living-only vs include-extinct; 100% stacked vs absolute population; DFS sibling stacking order; sample cadence; whether the toggle should default off; whether the existing PhylogenyView keeps as a "rows" alt view or gets retired. #r2-stretch #ui #protocol
  - Source: TODO.md at `67839b2`, migrated 2026-10-06; original release and area tags retained.
  - Blocked by: Validate the documented display choices and history contract.

## Ready for separate work

### P1 High

- [TOOLING] `quarantine-exhaustion-e2e-flake` — **Make the quarantine-exhaustion browser test pass reliably in CI.** `e2e/quarantine-exhaustion.spec.ts` has failed the required `browser` check on five of the seven CI runs since #30 landed, including two main pushes.
  - Source: CI runs since #30 merged (failed: main 37706221176 at 75b9829 and 37707047026 at 42f02c9, PR #34 37742103263 and 37743074646 on both attempts, PR #35 37745391249 on markdown-only changes over 9b37eed; passed: main 37707228177 at 9b37eed, PR #35 37743485302). The pre-merge #30 branch passed twice (37704203247, 37704604442). Locally the full suite passed at 9b37eed and on #34 in three separate agent runs. Filed by PR #36, 2026-10-08.
  - Keep this entry open after a single green main run: 9b37eed already passed once, which does not show the failure is fixed.
  - Starting point: every failure is the 5 s wait at line 25 for `Resume` to reappear after resuming with the "Patch saturated" auto-pause armed. Likely cause (not yet confirmed): the pause tick depends on how long Start ran before Pause, so the population, and the time until the ten applied patches saturate, vary between runs. Look for a deterministic fixture (for example, pausing at a fixed tick via `step`) rather than a longer timeout.

### Unprioritized

- [UI] `patched-parent-promotion` — **Promote events for patched parents.** Patched-parent promotion in the rewindable-events filter. The forward-looking promotion path currently checks parent-quarantined OR parent-big; the brainstorm also called for parent-patched as a third axis. The store doesn't project per-lineage patch status today (would need a small additional reducer fed from `patchApplied` events). Logged for follow-up; today's promotion list still catches every patched lineage indirectly via the `patchApplied` stratum-1 event. #r2-stretch #ui
  - Source: TODO.md at `67839b2`, migrated 2026-10-06; original release and area tags retained.

- [DOCS] `full-codebase-review` — **Establish the first current full-review baseline.** The historical project-direction review is preserved; it does not establish current full-codebase coverage.
  - Source: Workflow audit of `67839b2` and live GitHub records, 2026-10-06.
