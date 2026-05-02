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

- Forensic replay — preview-then-commit scrub mode. R2's forensic replay ships as a destructive rewind: clicking a timeline event loads to that tick and the post-rewind state is forfeit. A nicer UX is preview during drag (dashboard shows historical state without touching the live run), with an explicit "rewind here" commit button or a release-to-cancel. That design needs the host to maintain two parallel states (live and scrub-preview) and a query path that can serve historical state without disturbing the active run — a meaningful new architecture. Deferred until destructive scrub proves load-bearing enough to justify the lift; in the interim, Save-before-scrub gives the player a safe-out one click away. #r2-stretch #ui #host
- Phylogeny: lineageTree query response should carry historical extinctionTick. Today the query result has only foundedAtTick; lineages already extinct at the moment of a Load or Rewind come back with extinctionTick=null and render as a dot at their founding tick instead of a true lifeline. Extending LineageTreeEntry with the field would let the phylogeny show a faithful retrospective even after restoring an older save. Out of scope for the R2 phylogeny shipping commit; logged here for future polish. #r2-stretch #protocol #ui
