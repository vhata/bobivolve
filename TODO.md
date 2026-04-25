# TODO

Flat list. Each entry tagged with `#release` and `#area`. Done items are deleted, not struck through.

## Foundational

- `protocol/schema.proto` with initial `Command`, `SimEvent`, `Query` message families #r0 #protocol
- Wire protobuf codegen into the prebuild step #r0 #toolchain
- `xoshiro256**` PRNG, seedable, portable, with golden-vector test #r0 #sim
- Integer-time clock (`simTick: u64`) #r0 #sim
- `Storage` and `Clock` ports for sim core #r0 #sim
- Sim core directory: `/sim` per ARCHITECTURE.md, with no DOM/Node imports #r0 #sim
- Worker host (`/host/worker.ts`) #r0 #host
- Node host (`/host/node.ts`) for headless runs #r0 #host
- WorkerTransport and NodeTransport implementations #r0 #transport
- Event log (NDJSON, append-only, keyed by `(tick, seq)`) #r0 #sim
- Snapshot mechanism (implementation-defined; rebuild-from-log fallback) #r0 #sim
- Determinism golden test: `(seed, command-log) → event-log` diffed against checked-in golden #r0 #ci
- GitHub Actions: format, lint, tests, determinism, build, on every push #r0 #ci
- Project-aware code review skill (PROCESS.md Layer 2) #r0 #process

## Release 0 — Petri Dish

- Probes (entity, energy, location, lineage id) #r0 #sim
- Directive stack (ordered, parameterised, prioritised) #r0 #sim
- Replication on energy threshold #r0 #sim
- Mutation: parameter drift #r0 #sim
- Mutation: priority swap #r0 #sim
- Mutation: directive loss / gain #r0 #sim
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
