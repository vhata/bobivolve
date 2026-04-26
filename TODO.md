# TODO

Flat list. Each entry tagged with `#release` and `#area`. Done items are deleted, not struck through.

## Foundational

- Wire protobuf codegen into the prebuild step (ts-proto + protoc, or buf) once a consumer of generated types lands #r0 #toolchain
- Flesh out R0 `Query` result message bodies as the dashboard UI takes shape #r0 #protocol
- `Clock` port for sim core (when achieved-speed telemetry needs it) #r0 #sim
- Worker host (`/host/worker.ts`) — drives the sim under a Web Worker for the browser UI #r0 #host
- WorkerTransport (UI side wiring for the Worker host) #r0 #transport
- Cross-process NodeTransport variant: NDJSON over stdio, symmetric with the eventual Rust binary #r0 #transport
- `OPFSStorage` adapter (browser-side counterpart to `NodeStorage`) #r0 #host
- Rebuild-from-log fallback when a snapshot is missing or unreadable (ARCHITECTURE.md migration path); currently load fails fast in that case #r0 #host
- Tune snapshot cadence once R0 has real behaviour to scrub through; 30,000 ticks is a heuristic per ARCHITECTURE.md #r0 #host

## Release 0 — Petri Dish

- Mutation: priority swap (needs ≥2 directive kinds in firmware to be meaningful) #r0 #sim
- Mutation: directive loss / gain (needs ≥2 directive kinds in firmware to be meaningful) #r0 #sim
- Lineage names: lay-person legible (currently ordinal `Lk`) — ARCHITECTURE.md open question, deferred #r0 #sim
- Dashboard shell (React) #r0 #ui
- Population graphs by lineage #r0 #ui
- Lineage tree view with named clades and divergence markers #r0 #ui
- Per-probe inspector #r0 #ui
- Drift telemetry (rate of change per parameter, per lineage) #r0 #ui
- Forensic replay: scrubable timeline #r0 #ui
- Auto-pause trigger configuration UI #r0 #ui
- Speed control: 1x, 4x, 16x, 64x #r0 #ui
