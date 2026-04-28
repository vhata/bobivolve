# TODO

Flat list. Each entry tagged with `#release` and `#area`. Done items are deleted, not struck through.

## Foundational

- Wire protobuf codegen into the prebuild step (ts-proto + protoc, or buf) once a consumer of generated types lands #r0 #toolchain
- Flesh out R0 `Query` result message bodies as the dashboard UI takes shape #r0 #protocol
- `Clock` port for sim core (when achieved-speed telemetry needs it) #r0 #sim
- Cross-process NodeTransport variant: NDJSON over stdio, symmetric with the eventual Rust binary #r0 #transport
- Per-run OPFS slots (currently all runs reuse `runId='default'`; switching slots needs a UI for slot management) #r0 #host
- Snapshot reaper for orphaned snap files left behind when a newRun resets the slot #r0 #host
- Rebuild-from-log fallback when a snapshot is missing or unreadable (ARCHITECTURE.md migration path); currently load fails fast in that case #r0 #host
- Tune snapshot cadence once R0 has real behaviour to scrub through; 30,000 ticks is a heuristic per ARCHITECTURE.md #r0 #host

## Release 2 — The Engineer's Console

- Forensic replay: state-rewind scrub UI (load nearest snapshot + advance to selected tick); the events-timeline shape is in place, the data path supports it, the affordance waits on richer events for R2's player intervention #r2 #ui
- Tune gather-rate drift to be observable at the founder value (currently 2 with DRIFT_DIVISOR=64 floors drift to zero; a meaningful divisor change or a higher founder rate would let gather drift bite) #r2 #sim
- Restore intervention state in the dashboard after a Load — quarantines, queued decrees, applied patches all live in the snapshot but the client resets each on Load and only re-learns from new events; either re-emit synthetic events post-Load or pull a fresh state slab from a query #r2 #host #ui
- New-user experience overlay (NUX) — a guided tour that walks the player through the dashboard in the order they need to learn it (lineages → drift → intervention surface). Auto-fires once on first visit, then sleeps; a permanent "?" button reopens it on demand. Justified by the R2 acceptance test in `ACCEPTANCE.md` ("a first-time visitor … within ten minutes … without external instructions"). Tooltips alone are insufficient because they require the player to know to hover. #r2 #ui
- Pause regression — player reports clicking Pause and still seeing ticks advance and populations change. Suspect: the modal-on-action `resume()` cleanup in `PatchEditorModal` / `DecreeComposerModal` un-pauses what the player explicitly paused before opening, OR the worker's runUntil budget keeps grinding through queued ticks past the pause command (the e2e suite has a comment saying "this is the scenario where pause has historically failed"). Investigate both; the modal one is the easier fix (snapshot paused state on open, restore on close). #r2 #ui #host
- "Beginning to fade" indicator — once enough lineages exist, the player can't watch every population. Need a per-lineage trend signal: arrow (↑/→/↓), colour-coded sparkline in the lineage tree row, or a "declining" auto-pause trigger that fires when a lineage drops a configurable percentage from its peak. The lineage inspector already has population history; lifting that to per-row glances is the move. #r2 #ui
- Two-and-three-word lineage names — `sim/lineage-names.ts` currently picks a single noun by hashed ordinal and is starting to repeat. Add an adjective stage (deterministic, also hashed from ordinal) so names read "Wandering Pioneers" / "Stubborn Drifters" rather than just "Pioneers"; namespace size goes from O(N) to O(N×M) and lineage names become more legible at a glance. #r2 #ui #sim
- Server-authoritative state reconciliation — extend the Tick heartbeat to carry the host's authoritative `paused`/`speed`, and have the sim-store reconcile when the heartbeat disagrees with the optimistic projection AND no pending command for that field is in flight. Defence in depth against any class of message-drop or projection-drift bug. Cheap (one bool + one int per heartbeat, a few lines of store reconciliation) but does not solve host-side correctness bugs — those still need their own fix. Distinct from the current pause-honour bug; this is the systemic improvement that would have caught it (or at least bounded its visibility). #cross-cutting #host #ui
