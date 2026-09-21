# Bobivolve architecture

Current implementation through Release 2. Product intent and future releases live in [SPEC.md](SPEC.md); rationale lives in [design decisions](docs/DECISIONS.md).

## Three layers

| Area | Responsibility | Starting points |
| --- | --- | --- |
| `sim/` | Deterministic state and tick mechanics; no DOM or Node APIs | `state.ts`, `step.ts`, `rng.ts` |
| `host/` | Run loop, commands, queries, event log, snapshots, storage | `node.ts`, `worker.ts`, `node-cli.ts` |
| `transport/` | Message delivery between client and host | `types.ts`, `worker.ts`, `node.ts`, `node-stdio.ts` |
| `ui/` | React dashboard and Zustand projection of events/queries | `App.tsx`, `sim-store.ts`, `components/` |
| `protocol/` | Shared message contract | `schema.proto`, `types.ts` |

The browser worker wraps the shared `NodeHost` with OPFS storage; the name does not imply that the host requires Node APIs. The app entrypoint wires the worker transport. UI panels consume protocol data rather than simulation internals.

## The seam contract

Commands, events, queries, and query results cross as plain data. Use stable string IDs, not internal references, classes, callbacks, or mutable simulation state. A replacement host must be able to serve the same contract without changing the panels.

### Protocol and IDL

`protocol/schema.proto` defines the intended schema; `protocol/types.ts` is its hand-written TypeScript counterpart used by the application. Keep both in sync. Code generation is deferred, not part of the build.

Worker messages use structured clone, including native bigints. The stdio transport uses NDJSON with decimal strings for bigint fields and hand-written revival in `transport/ndjson-codec.ts`. This is the current application encoding, not generated protobuf serialization. Evolve the schema additively; do not reuse field numbers or silently change existing field semantics.

Commands are acknowledged with events; queries return correlated results. Heartbeats are best-effort summaries (the browser host requests 4 Hz). Domain events are ordered and persisted; the browser worker deliberately filters replication and death events that the UI does not consume. Message definitions may reserve future capabilities; a schema entry alone is not evidence that a feature is implemented.

## Transports and headless capability

All transports implement `SimTransport` (`send`, `onEvent`, `query`, `close`):

- `WorkerTransport`: browser worker messages.
- `NodeTransport`: in-process host for headless use and tests.
- `NodeStdioTransport`: child process with NDJSON over stdio.

The headless CLI supports seeded runs, saving, and resuming. It is also the reference runtime for determinism checks and experiments. Run commands are in [README.md](README.md).

## Event log and snapshots

The host stores NDJSON entries ordered by `(tick, seq)`: commands, domain events, and snapshot references. It appends during normal play and truncates the active log when rewind forks history. Heartbeats are not logged. Browser storage uses OPFS; Node storage uses files behind the `Storage` interface in `sim/ports.ts`.

Snapshots serialize simulation state as JSON with tagged bigint values (`host/snapshot-codec.ts`). The default periodic cadence is 30,000 ticks. Run switching and rewind use `restoreToTick` to reconstruct state from available snapshots and logs, with a log-replay fallback when snapshots are unavailable. Replay skips persistence-management commands that would switch, delete, or save runs during reconstruction.

Named save slots are distinct from run storage: Save captures a fresh snapshot; Load requires that snapshot and forks the active timeline. Missing or unreadable named-save snapshots do not yet have a log-rebuild fallback. Rewind is destructive to the active future; saving first preserves a way back.

Snapshot cadence tuning, milestone-triggered snapshots, and named-save recovery are tracked in [TODO.md](TODO.md). Do not promise automatic snapshot pruning, pre-auto-pause snapshots, or universal recovery: those are not current guarantees.

## Determinism disciplines

- Use the seeded `xoshiro256**` PRNG and preserve deliberate draw and iteration order.
- Use integer ticks (`bigint` in TypeScript, `uint64` at the schema) and integer simulation accounting. Never consult wall-clock time or unseeded randomness inside the core.
- Keep host APIs, persistence scheduling, and UI concerns outside simulation mechanics. Host timing controls execution and telemetry, not the outcome of a tick. There is no core `Clock` port today.
- Preserve snapshot/restore state, including PRNG state, and deterministic command replay.
- Node is the reference for the checked-in event-log goldens. Browser and headless execution must agree for equivalent inputs.

Lint enforces some of these boundaries; tests and review cover what static rules cannot. See [quality policy](docs/QUALITY.md) for verification.

## Migration path to Rust (future option)

No Rust runtime or Tauri transport exists here. If TypeScript becomes a demonstrated constraint, port the core behind the same protocol and compare event logs against the TypeScript reference. Code generation and a native transport would arrive with that work. Old-run recovery would require compatible command replay; cross-version migration is not implemented today.
