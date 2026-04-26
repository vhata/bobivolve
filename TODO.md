# TODO

Flat list. Each entry tagged with `#release` and `#area`. Done items are deleted, not struck through.

## Foundational

- Wire protobuf codegen into the prebuild step (ts-proto + protoc, or buf) once a consumer of generated types lands #r0 #toolchain
- Flesh out R0 `Query` result message bodies as the dashboard UI takes shape #r0 #protocol
- `Clock` port for sim core (when achieved-speed telemetry needs it) #r0 #sim
- Worker host (`/host/worker.ts`) #r0 #host
- Node host (`/host/node.ts`) for headless runs #r0 #host
- WorkerTransport and NodeTransport implementations #r0 #transport
- Event log (NDJSON, append-only, keyed by `(tick, seq)`) #r0 #sim
- Persistent snapshot mechanism (write to Storage; rebuild-from-log fallback) #r0 #sim
- Determinism golden test: `(seed, command-log) → event-log` diffed against checked-in golden, wired into CI #r0 #ci
- Add `build` step to CI once a build target exists (Vite + UI) #r0 #ci
- Project-aware code review skill (PROCESS.md Layer 2) #r0 #process

## Release 0 — Petri Dish

- Mutation: priority swap (needs ≥2 directive kinds in firmware to be meaningful) #r0 #sim
- Mutation: directive loss / gain (needs ≥2 directive kinds in firmware to be meaningful) #r0 #sim
- Lineage clustering against a reference genome #r0 #sim
- Speciation event when drift exceeds threshold #r0 #sim
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
