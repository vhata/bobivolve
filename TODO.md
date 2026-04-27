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
- Restore quarantine state in the dashboard after a Load — the snapshot carries the set, but the client resets to empty and only re-learns from new events; either re-emit synthetic events on Load or extend the lineageTree query result body and pull on Load ack #r2 #host #ui
- Wire the per-tick maintenance compute cost for held quarantines once Origin compute lands; currently quarantine is flag-only #r2 #sim
