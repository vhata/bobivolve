# TODO

Flat list. Each entry tagged with `#release` and `#area`. Done items are deleted, not struck through.

## Foundational

- Wire protobuf codegen into the prebuild step (ts-proto + protoc, or buf) once a consumer of generated types lands #r0 #toolchain
- Flesh out R0 `Query` result message bodies as the dashboard UI takes shape #r0 #protocol
- `Clock` port for sim core (when achieved-speed telemetry needs it) #r0 #sim
- Worker host (`/host/worker.ts`) — drives the sim under a Web Worker for the browser UI #r0 #host
- WorkerTransport (UI side wiring for the Worker host) #r0 #transport
- Cross-process NodeTransport variant: NDJSON over stdio, symmetric with the eventual Rust binary #r0 #transport
- Replication events with `parentProbeId` and `mutated` populated (currently derived from probe-id deltas in the host; needs an explicit emission hook in `sim/step.ts`) #r0 #sim
- Speciation events (data path is in place — `Lineage.parentLineageId`; emit when explicit-event hook lands) #r0 #sim
- Concrete `Storage` adapters: `NodeStorage` (filesystem) and `OPFSStorage` (browser). The interface exists in `sim/ports.ts`; nothing implements it yet, and without an implementation save/load and the event log have no destination. #r0 #host
- Event log (NDJSON, append-only, keyed by `(tick, seq)`) — depends on `Storage` adapters #r0 #sim
- Persistent snapshot mechanism (write to Storage; rebuild-from-log fallback on first open) — depends on `Storage` adapters #r0 #sim
- Save / Load command handlers in the host run-loop (the protocol commands exist; nothing routes them) #r0 #host
- Add `build` step to CI once a build target exists (Vite + UI) #r0 #ci

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
- OPFS-backed event log in the browser host #r0 #host
- Disk-backed event log in the node host #r0 #host
