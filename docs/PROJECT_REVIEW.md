# Project direction review

Reviewed baseline: `c8ca0c3081d6b50c2ce1f3dcba0882c4d5477f6a` (Release 2, local main). Review requested by the player on 2026-09-20. No open PRs or other worktrees were present at the start. This document records findings and proposals, not implemented changes or approved R3 scope. Actionable follow-ups live in [TODO.md](../TODO.md).

## Recommendation

Keep the deterministic TypeScript simulation, browser worker, React dashboard, shared host, and headless runtime. Change the immediate delivery priority: before First Contact, prove the current observe → understand → intervene → recognise consequences loop. There are both correctness defects and design weaknesses obstructing it. A runtime rewrite would leave those problems intact.

Bobivolve's distinctive promise is authorship with consequences: the player writes inheritable behaviour, watches it change under selection, recognises the resulting lineages, and cares when their policy succeeds or goes wrong. The implementation already supports considerable simulation activity and intervention. It does not yet reliably make that activity legible or establish that the player's choices are meaningfully balanced.

The R0–R2 acceptance verdicts mostly demonstrate that the design questions are _answerable by playing_. That is useful functional evidence, but it is not evidence that drift remains interesting, competition creates recognisable rivals, or patching sustains meaningful decisions. Those questions need explicit playtesting alongside technical gates.

## What exists and what to preserve

| Area                | Current implementation                                                                                                                                               | Assessment                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Simulation          | Seeded PRNG, integer accounting, fixed 64×64 resource lattice, procedural resource centres, gather/explore/replicate firmware, mutation, reference-genome speciation | A useful experimental foundation. Behavioural depth and lineage granularity need attention.                             |
| Player intervention | Whole-firmware patches to extant members of one lineage, one-shot population-below decrees, replication quarantine, renewable compute                                | Working command paths, but narrow authoring and weak economic trade-offs.                                               |
| Dashboard           | Population, substrate canvas, living tree, row-based phylogeny, drift inspector, event timeline, intervention modals and tour                                        | Substantial coverage. The main limitation is interpreting cause and consequence, compounded by actual timeline defects. |
| Runtime boundary    | Shared host behind worker, in-process Node and stdio transports                                                                                                      | Appropriate for this dashboard-heavy game. Preserve this separation.                                                    |
| History             | Command/event log, snapshots, named saves, run slots, destructive rewind                                                                                             | Valuable capability with serious correctness gaps. Fix before relying on it for player experimentation.                 |
| Validation          | 247 passing unit/integration tests, deterministic golden logs, conservation tests, browser suite                                                                     | Good base, but important interaction cases escape it. Browser suite currently fails one test.                           |
| Roadmap             | R3–R9 progressively add external pressure, diplomacy, politics, co-evolution, information limits and continuity                                                      | A coherent direction; should remain hypotheses rather than a fixed feature conveyor belt.                               |

The current world is a fully allocated lattice. The specification's dormant, lazily resolved systems are future intent, not current behaviour. Likewise, initial firmware is fixed in the dashboard, and I found no player lineage-renaming command or UI despite those verbs appearing in the product description. The patch modal edits existing numeric parameters; it cannot add, remove or reorder directives. Treat these as product gaps to prioritise deliberately, not evidence that a general firmware-authoring experience is already complete.

## Simulation and product findings

### Lineages are too fine-grained for the proposed unit of attention

Three unmodified core runs, each to 10,000 ticks, produced:

| Seed | Population | Living lineages | All lineages | Largest living lineage share |
| ---: | ---------: | --------------: | -----------: | ---------------------------: |
|    0 |      5,965 |           1,923 |        7,591 |                        3.24% |
|   42 |      6,053 |           2,285 |        8,625 |                        1.39% |
| 2026 |      6,169 |           1,855 |        7,231 |                        3.83% |

These are short, unattended runs, not proof of every seed or long-run equilibrium. Nevertheless, thousands of living clades, averaging only a few probes each, are poorly matched to a player expected to recognise, compare, rescue and remember them. The phylogeny currently caps rendering at 1,500 rows, already below even the living-lineage counts here.

The mechanics explain part of this. `sim/lineage.ts` declares divergence beyond 1%. For the founder's gather rate of 2, `sim/mutation.ts` can change the value by one: a 50% change, immediately beyond that threshold. Structural changes also create new lineages. All surviving mutations get the same identity treatment regardless of whether they create a lasting ecological role.

Recommended experiment: separate complete genetic ancestry from the handful of clades the player follows. Compare adjusted speciation rules, persistence/population thresholds for prominent identities, and explicit watch/naming tools. Preserve full ancestry for inspection. Measure clade lifetime, population concentration, turnover, and player recall across a seed suite. Do not just turn down mutation until the tree fits.

The queued Muller plot is promising for population history, but replacing rows with thousands of coloured streams will not alone solve this problem. Population history also needs a stable simulation-time sampling contract before it becomes an authoritative full-run view; current heartbeat-derived, decimated samples are display history.

### Firmware needs trade-offs and understandable controls

Gather takes `min(cell resources, rate)` with no capability cost, execution cost, or increased upkeep for a higher rate (`sim/step.ts`). The patch authoring cost is constant. Raising harvest capacity can deplete shared resources and change competition, so it is not a proven universally optimal long-run strategy. It is still a mechanically unpriced increase in immediate capability. Adding more directive kinds on top of this will not automatically create interesting optimisation.

All directives execute every tick, in order. There are no local conditional rules such as “explore when this cell is depleted” or “avoid an inhabited cell.” The only decree trigger monitors population, and decrees perform a one-shot rewrite. That is a much narrower policy language than the later roadmap implicitly expects.

Recommended bounded design experiment: introduce one understandable constraint (for example, hardware allocation or upkeep that trades harvesting against mobility or replication), and one useful local predicate. Compare at least two viable strategies under different conditions. Choose the actual mechanic with the player; no VM, scripting language, or large rule framework is justified yet.

The editor should show player units: movement chance or expected movement interval, harvest per tick, replication reserve, and relevant costs. The inspector already translates movement into a percentage, while the editor asks for a raw integer near `2^58`. Offer structural edits and before/after explanations where the simulation supports them. Show command rejection and preserve the draft until acknowledgement; `ui/sim-store.ts` currently removes failed pending commands without displaying their error message.

### Compute currently provides little sustained scarcity

`sim/compute.ts` starts at 1,000 compute, charges 100 per patch/decree, and restores one per tick. At the browser's nominal one tick per 16 ms pulse, a patch replenishes in about 1.6 seconds at 1× before workload overhead; at higher speeds it can be faster. The source comment claiming roughly 17 minutes is stale.

One quarantine exactly offsets regeneration and leaves a full budget at 1,000. When many holds exceed the budget, unpaid maintenance is forgiven and the holds remain effective: `applyComputeTick(1n, 100)` returns `1n`. This is intentional code behaviour, but it does not fulfil a strong interpretation of budget-gated quarantine.

Decide what compute is meant to constrain: simultaneous policies, intervention frequency, deployment scale, or emergency response. Then define and surface an explicit exhaustion policy. Avoid merely increasing prices without relating them to actual session pacing.

### Intervention history needs semantic precision

Patches replace all current genomes within the selected lineage and its reference genome. Existing child lineages are not affected. Patch IDs are inherited as ancestry records and are never removed when a later patch replaces the firmware. `checkPatchSaturation` counts those ancestry markers, so “carriers” does not necessarily mean probes still executing a particular patch's behaviour.

That can be a valid provenance model, but the UI should distinguish authorship ancestry, current firmware, and retained behavioural effect. Otherwise a “patch takeover” can be interpreted as success even after the relevant behaviour has disappeared. Store or recover the actual firmware changes in intervention history; a list of IDs and timestamps is insufficient to explain why a lineage changed.

### First Contact needs a decision the player can actually make

The draft R3 brief introduces incursions, inhabited cells, violations, inherited taint, a speed cap and proximity decrees. It postpones most new policy verbs. Random explore does not currently support an avoidance zone; a proximity-triggered rewrite needs an actionable movement or interaction rule to deliver the promised response.

Before implementing the brief, walk through one concrete story: the player discovers a vulnerable population, understands the stakes, chooses a feasible protection policy at a real cost, observes compliance and drift, and can reconstruct why harm occurred. An unavoidable violation followed by a sticky label is an event, but may offer little agency. An arbitrary incursion roll is pressure, but needs a legible policy counter to become strategy.

Prefer one complete contact dilemma over adding every proposed R3 event shape at once. Keep R4–R9 as options conditional on what playtests reveal. This recommendation respects the existing R3 design gate; it does not approve or implement the brief.

## Correctness findings

P1 means player history/state trust is compromised; P2 means a significant correctness, usability or performance defect. Reproductions used isolated in-memory storage or a fresh Chromium profile, not the player's existing saves.

### P1 — Rewind retains and replays the discarded future

Location: `host/node.ts`, `doRewindToTick` and `restoreToTick`.

Reproduced: new run, quarantine L0 at tick 10, advance to 20, rewind to 5, resume to 15 without reissuing quarantine. L0 is correctly unquarantined. Rewind again to 12: L0 becomes quarantined from the old future. Rewind changes in-memory state but neither forks nor truncates the log and snapshot references. Continuing appends entries out of tick order, while restoration assumes ordered history.

Fix direction: establish an explicit new timeline branch or atomically replace the active history with a valid prefix and a new anchor. Test repeated rewind/resume, run switching, and commands on both sides of the fork.

### P1 — Replay drops commands at the snapshot tick

Location: `host/node.ts`, `restoreToTick`, especially `entry.tick <= startTick`.

Reproduced with snapshot cadence 10: advance to 10, flush the snapshot, quarantine L0 at tick 10, advance to 12, rewind to 10. Quarantine is lost. The event log has `(tick, seq)` ordering but restoration filters by tick alone. The same issue affects tick-zero commands on a fresh-state rebuild.

Fix direction: restore from an exact log cursor and replay later entries at the same tick. Specify what an event-tick rewind includes when multiple commands/events share the tick.

### P1 — Named-save Load creates a timeline without a replay anchor

Location: `host/node.ts`, `doLoad`.

Reproduced: save at 10, load it, resume to 20, rewind to 15. The host rejects with “no snapshot at-or-before tick 15 and log lacks a newRun command to seed a rebuild.” Load deletes the active log but does not write an anchor for the newly loaded state. This is separate from the already deferred recovery of a missing named-save file.

Fix direction: persist a new snapshot/log anchor as part of the load transaction before acknowledging success.

### P1 — Browser startup resets the default run

Location: `ui/App.tsx` startup effect, `host/worker.ts` startup restoration, `host/node.ts` `handleNewRun`.

Reproduced in a fresh browser: start seed 2026, pause, reload; the dashboard starts seed 42. App startup unconditionally sends `newRun(42)`, which deletes the default slot's previous log/snapshots. The worker only attempts automatic restoration for a non-default active marker, independently of that startup command. Explicit named saves are separate and were not deleted by this reproduction.

Fix direction: one acknowledged bootstrap flow should choose resume-existing or create-new. New run should be an explicit player action once a slot exists.

### P1 — Auto-pause drops already-produced domain events

Location: `host/node.ts`, `advanceUnpaused`.

Reproduced at seed 42, tick 8, with speciation auto-pause enabled: the core produces two speciations and eight replications. The host emits the first speciation and auto-pause, then returns, losing the remaining events even though the whole tick's state changes have happened. This can omit a lineage from the UI and persisted event history.

Fix direction: deliver the full committed tick's event batch, then stop before the next tick. Test event/state equivalence with each auto-pause trigger enabled.

### P2 — A captured snapshot can acquire a future extinction timestamp

Location: `sim/state.ts`, `snapshot`; `sim/step.ts`, extinction stamping.

Reproduced: capture a tick-zero snapshot of a one-energy founder with inert exploration, then advance one tick. The saved snapshot now contains `extinctionTick=1` despite its `simTick=0`. Probes are copied but lineage objects are shared; live extinction mutates them in place. Deferred serialization makes this relevant to queued persistence.

Fix direction: copy mutable lineage records on capture or replace them on mutation; regression-test delayed serialization.

### P2 — Live timeline flushing is starved; history is not scoped to the run

Location: `ui/components/EventsTimelinePanel.tsx`, flush effect and component-local buffers.

Browser reproduction after five seconds at default speed: timeline reads “0 milestones · 0 speciations”; pause and wait 500 ms: “31 milestones · 44 speciations.” The 250 ms interval is recreated on every `simTick` change, so normal updates can keep cancelling it before it runs. This explains the forensic browser test failing while it waits for a visible entry.

Separately, buffers are not reset on new run/load/rewind/switch, and `allSpeciationsBufferRef` grows without a cap. Its rendered slice is bounded, but its storage is not. Old entries can describe a different run, and the memoized “all” view does not depend on ref changes.

Fix direction: use a stable flush clock and explicit run/timeline identity to reset or rehydrate history. Bound stored data as well as rendered data. Moving this into the host may later be useful, but is not required to fix the timer.

### P2 — The configured heartbeat limit is bypassed

Location: `host/node.ts`, `runUntil` final heartbeat; `host/worker.ts`, `pulse`.

Reproduced with `heartbeatHz: 4`, a frozen clock and 100 `runUntil` calls: 100 heartbeats are emitted despite zero elapsed milliseconds. Each worker pulse invokes `runUntil`, whose unconditional final heartbeat bypasses the cadence check. The browser's intended 4 Hz protection therefore does not hold.

Fix direction: distinguish an explicitly requested terminal snapshot from normal pulse progress and enforce the cadence on the latter. Measure message rate, rendering work and pause latency at representative populations.

## Architecture, performance and testing

The boundaries are the right ones. Incrementally separate `host/node.ts` into command handling, timeline restoration/persistence, and query projection when touching those areas; its 1,810 lines currently mix their invariants. No replacement architecture is needed. Similarly, centralise run identity and command outcomes in the UI so panels cannot retain data from a previous timeline.

Before tuning snapshot cadence, correct the measurement: `test/bench/snapshot-cadence.ts` starts its snapshot-write timer inside `Storage.write`, after `serializeSnapshot` has already run. The recorded approximately 1 ms values measure copying bytes into memory, not serialization plus filesystem/OPFS cost. The TODO table's interpretation overstates what was measured. Actual persistence, serialization, log growth and restoration need separate measurements.

The browser profile from this review reached 5,965 probes in its late sample: main-thread task time was 54.9% of a 15-second window, script time 50.6%, while click-to-zero-speed took 14 ms. This supports keeping the current runtime while fixing message/render overhead. It is a local development-browser sample, not a hardware-independent benchmark or proof of long-run capacity.

Long runs retain extinct lineages, patch ancestry and all domain events. Log reading loads and parses the full file. Current snapshot cadence does not imply retention management or crash-safe flushing. Establish supported session length, responsiveness and storage budgets before adding more event-heavy mechanics. Profile realistic persistence, not just core tick throughput.

Inspection also found recovery errors swallowed by the async work queue without a corresponding command error, and unreadable snapshots lacking the missing-file fallback. Treat these as failure-path coverage for the persistence work rather than claiming universal recovery. Validate directive numeric domains at the host boundary too: its parser currently accepts any `BigInt` string, including negative/out-of-u64 values, and patch validation only checks minimum length.

The R2 acceptance text says intervention goldens are checked in, but `test/determinism/golden.test.ts` runs three seed/tick cases without intervention scripts. Intervention tests exist; they are not equivalent to those claimed golden scenarios. It also describes command-script input to the CLI, while `host/node-cli.ts` only accepts seed, ticks, heartbeat, save-directory, run-ID and resume options. The programmatic host supports interventions; that is distinct from CLI script ingestion. CI runs formatting, lint, types, tests and build, but not Playwright, despite historical “always green” acceptance wording. Update claims and add meaningful workflow coverage for apply/ack/error, decree fire, repeated rewind, startup resume and run isolation.

## Proposed sequence and exit evidence

1. **Restore trust.** Fix timeline forks/cursors, load/bootstrap anchors, immutable snapshots, complete auto-pause event delivery, timeline flushing and visible command errors. Exit: scripted intervention histories round-trip through save/load/rewind/run switching; fresh-browser resume preserves the active run; the browser suite passes.
2. **Validate the engineer loop.** Run a small multi-seed experiment on meaningful firmware constraints and stable player-facing clades. Improve editor units and before/after feedback. Exit: a player can explain why two policies behave differently, make a trade-off, recognise its descendants, and diagnose an unintended consequence without source-code help.
3. **Ship one contact dilemma.** Design it with the player under the existing R3 gate. Exit: the player can recognise the threat, enact a policy with a cost, observe a consequence and trace it to behaviour. Broader archetypes and politics follow only if they improve that loop.

Proposed playtest protocol: give a new player ten minutes, then ask which lineage they care about, what intervention they made, what it cost, and what evidence shows its effect. Repeat with a returning player over a longer session. Observe whether they understand and choose; do not equate button completion with meaningful authorship. These are proposed gates, not results from a human playtest conducted here.

## Validation and limits

- `scripts/check.sh`: passed formatting, ESLint, TypeScript and all 247 tests across 21 files.
- `scripts/build.sh`: passed.
- `scripts/e2e.sh`: 29 passed, 1 failed (`e2e/forensic-replay.spec.ts`, missing timeline entry within 45 seconds).
- Three core seeded runs to 10,000 ticks; results above. These bypass storage and browser pacing and do not establish long-run balance.
- Targeted runtime reproductions for snapshot aliasing, same-tick replay, discarded-future replay, heartbeat cadence, auto-pause event loss and post-Load rewind failure.
- Fresh Chromium reproduction of live timeline starvation and default-run reset on reload; visual inspection of the dashboard screenshot.
- Static review across product/architecture/quality documents, core mechanics, host, worker, storage/log codecs, transports, store and dashboard components. This was not a proof of every interleaving, an exhaustive security audit, a cross-browser matrix, a dependency audit or a human enjoyment study.
- Initial validation attempts were blocked by sandbox network access needed for pnpm version verification; the reported completed checks used approved network access. No dependency or application-code changes were made for this review.
