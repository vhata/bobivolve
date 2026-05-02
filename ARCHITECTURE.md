# Bobivolve Architecture

Companion to `SPEC.md`. `SPEC.md` describes what the game is; this document captures how it is built and the engineering disciplines that make later releases possible without rewrites.

## Status

Pre-R0. No implementation yet. All decisions below are revisable. The disciplines are designed so that the most expensive substitutions — language, transport, storage backend — can be made without disturbing the rest of the system.

## Investment principle

We are willing to do meaningfully more work now to make later work easier, particularly when the up-front cost is bounded and the savings compound across releases. When in doubt, pay the cost now. This principle is the reason for several of the choices below — the IDL, the transport seam, the determinism test, the on-disk log format — each of which would be cheaper to skip in R0 and progressively more expensive to retrofit.

## Tech stack

**TypeScript everywhere. Simulation runs in a Web Worker. The seam between simulation and UI is designed as if it were a network boundary, so that the simulation can later be replaced with a Rust binary behind the same protocol without UI changes.**

Rationale:

- The dashboard is the dominant UI workload — population graphs, lineage trees, scrubable replay, firmware editor. This is web-native territory; shipping it in a game engine would be an uphill fight.
- The simulation is computationally tractable in TypeScript through R0–R4. By R5–R6 (full Others firmware co-evolution) it may need a faster runtime; by then the design has earned the porting effort.
- One language across the codebase keeps iteration fast in the early releases, when the design is most uncertain.
- A clean sim/UI seam pays for itself even if the port never happens: deterministic replay, headless runs, swappable hosts, golden-file testing.

Rejected alternatives:

- **Native game engine (Godot/Unity).** Dashboard-and-data dominant; the UI work would fight an engine optimized for game-world rendering.
- **Rust core + web UI from day one.** Correct ceiling, but two languages and two build chains slow the early-release iteration that matters most.

## Three layers

```
┌──────────────────────────────────────────────┐
│ UI                                           │
│ React; dashboard, inspectors, editors        │
│ Imports protocol/* only from the sim side    │
└──────────────────────────────────────────────┘
                     ↑↓  Transport
┌──────────────────────────────────────────────┐
│ Sim host                                     │
│ Run loop, clock, storage adapter             │
│ Worker | Node | Tauri (later)                │
└──────────────────────────────────────────────┘
                     ↑↓  in-process
┌──────────────────────────────────────────────┐
│ Sim core                                     │
│ Pure module: state, step, log, snapshot      │
│ No DOM, no Node APIs, no host coupling       │
└──────────────────────────────────────────────┘
```

The UI is aware of the seam between itself and the sim host. It is not aware of anything below the host.

## The seam contract

Crosses the seam:

- Plain-data, IDL-defined messages: `Command`, `SimEvent`, `Query`, `QueryResult`.

Does not cross the seam:

- Object references, function references, class instances, closures, mutable state, host APIs.

The principle: if a separate Rust process could produce the same byte stream, the UI cannot tell the difference.

## Protocol and IDL

Protobuf 3, single source of truth in `protocol/schema.proto`. Codegen on prebuild:

- TypeScript via `ts-proto`, used by both sim host and UI.
- Rust via `prost`, used once the port begins.

Wire format: proto3 JSON encoding (NDJSON for streams). Human-readable for forensic debugging and golden-file testing. Switchable to binary at the transport layer without changing the schema.

Schema evolution follows proto3 rules: new optional fields are additive, no field-number reuse, no semantic changes to existing fields.

### Message families

- **Command (UI → sim).** `newRun`, `setSpeed`, `pause`, `resume`, `step`, `applyPatch`, `queueDecree`, `revokeDecree`, `quarantine`, `releaseQuarantine`, `configureAutoPause`, `save`, `load`, `rewindToTick`. Fire-and-forget; the sim acknowledges via `SimEvent`.
- **SimEvent (sim → UI).** Two delivery tiers:
  - *Heartbeat:* one `tick` event per UI frame at most, carrying population summary, `simTick`, and actual speed. Best-effort delivery; the UI may drop heartbeats under load and must not depend on them for correctness.
  - *Domain events:* `replication`, `speciation`, `extinction`, `death`, `firstContact`, `treatyViolation`, `patchApplied`, `patchSaturated`, `decreeQueued`, `decreeFired`, `decreeRevoked`, `quarantineImposed`, `quarantineLifted`, `autoPaused`, `commandAck`, `commandError`. Guaranteed in-order delivery.
- **Query (UI → sim → reply).** `lineageTree`, `probeInspector`, `driftTelemetry`, `logSlice`, `populationSummary`, `substrate`, `decreeQueue`, `listSaves`. Pull-only; never pushed.

## Transports

All conform to one interface:

```
SimTransport {
  send(cmd)                          // fire-and-forget
  onEvent(handler) -> Unsubscribe    // sim → UI stream
  query(q) -> Promise<QueryResult>   // request/response
  close()
}
```

Three implementations:

- **WorkerTransport.** `postMessage` to a Web Worker. Day-one default for the desktop and web builds.
- **NodeTransport.** Runs the same TypeScript sim under Node, NDJSON over stdio. For headless runs, CI, and golden-file testing.
- **TauriTransport.** `invoke` for commands and queries, event listener for the event stream. Reserved for the future Rust port.

The UI imports `SimTransport`; the host process wires the implementation at startup.

## Headless capability

The architecture supports running the simulation without any UI attached, via `NodeTransport`. This is deliberate. It serves:

- **CI and golden-file testing.** Determinism tests run as plain Node processes — no browser, no Worker, no UI to mock.
- **Forensic replay outside the dashboard.** A command log can be re-run end to end from the shell and the resulting event log diffed against a golden.
- **Long-running experiments.** Sweeping seeds or parameter ranges to study lineage dynamics is easier when the sim is a CLI than when it is bound to a UI session.
- **Future "cook between interrupts" UX.** If we later want the simulation to advance in the background and surface only at the next auto-pause trigger, the seam is already cut for it. Not a current goal; an option preserved at low cost by choices being made anyway.

This section exists so that `NodeTransport` is not later mistaken for unused scaffolding and removed.

## Event log

The spine of replay and determinism. Append-only, keyed by `(tick, seq)`.

Entries are one of:

- `cmd` — a `Command` that arrived at this tick.
- `ev` — a `SimEvent` the sim emitted.
- `snap` — a reference to a periodic snapshot (see below).

Heartbeats are not logged; they are derivable.

Storage:

- Browser host: OPFS (Origin Private File System). Real filesystem semantics, suited to append-only workloads.
- Node host: plain files on disk.
- Same NDJSON format in both places. A save file moves between hosts without conversion.

A save slot is `(latest snapshot, log tail since that snapshot)`.

## Snapshots

**Snapshots are an implementation-defined performance cache, not part of the IDL.**

The seed plus the command log is the canonical description of the universe. Snapshots exist only to make replay scrubbing and load-time fast. Consequences:

- Snapshot format is whatever the current implementation prefers — structured-cloned blobs in TypeScript today, something else in Rust later.
- Snapshot format may change between releases without a migration. A missing or unreadable snapshot triggers a rebuild-from-log pass.
- When the Rust port ships, opening a TypeScript-era save file performs a one-time rebuild from the log behind a progress indicator. This tax is accepted in exchange for keeping snapshots out of the IDL forever.

Initial cadence (heuristic; tune once R0 has real behaviour):

- One snapshot every ~30,000 ticks.
- One snapshot just before any auto-pause-trigger event fires, so scrubbing around moments of interest is fast.
- All snapshots retained for the active session. Older sessions retain only every Nth.

## Determinism disciplines

Necessary for replay correctness, golden-file testing, and a faithful future port.

- **One PRNG, named, portable.** `xoshiro256**`. Seed lives in the snapshot. Never `Math.random()`.
- **Integer time only.** `simTick: u64` is the clock. No floats for time. No `Date.now()` inside sim code.
- **Stable IDs, never references.** Probes, lineages, patches are addressed by string ID at the seam. Internal `Map<id, T>` structures never leak across it.
- **No host APIs in sim.** The sim core imports nothing from `window`, `document`, `fs`, `process`, or any browser/Node-specific module. It accepts a `Storage` port and a `Clock` port from the host.
- **Determinism test from week one.** A CI job runs `(seed, command-log) → event-log` and diffs the result against a checked-in golden. The day this test stops passing is the day a non-determinism bug just shipped. The same test will validate the Rust port byte-for-byte against the TypeScript reference.
- **Headless runtime is Node.** The canonical reference for the determinism golden is the Node host. The browser host runs the same TypeScript code and must produce identical output; if it ever diverges, Node is the truth and the browser is the bug.

The mechanics that must produce byte-for-byte identical output across implementations and sessions are: PRNG draws, mutation (parameter drift, priority swap, directive loss and gain), lineage clustering against the reference genome, resource diffusion across the sub-lattice, and (from R3) contact and encounter rolls. Any new mechanic in a future release that consumes randomness or compares values in a way sensitive to representation inherits this constraint.

## Directory layout (proposed)

```
/protocol
  schema.proto             single source of truth
  generated/               ts-proto output (gitignored)

/sim                       pure core; no DOM, no Node, no Tauri
  rng.ts
  state.ts
  step.ts
  log.ts
  snapshot.ts
  ports.ts                 Storage, Clock interfaces

/host                      sim host run-loops
  worker.ts
  node.ts
  tauri.ts                 (later)

/transport                 UI-side transport implementations
  worker.ts
  node.ts
  tauri.ts                 (later)

/ui                        React; imports protocol/generated only
  ...

/test
  determinism/
    golden/                checked-in event-log goldens
```

## Migration path to Rust (for the record, not for now)

When the simulation outgrows TypeScript:

1. Translate `/sim` to a Rust crate of the same shape.
2. Wrap it in a binary that reads commands on stdin and writes events on stdout, NDJSON. Same proto3 JSON shapes.
3. Wire the Tauri transport to spawn it.
4. Run the determinism test against both implementations on the same `(seed, command-log)`. Event logs must match byte-for-byte.
5. Save files written by the TypeScript sim load into the Rust sim via the rebuild-from-log pass on first open.

## Open questions

- **Snapshot cadence.** The 30k-ticks-plus-auto-pause-boundary heuristic is a guess. Revisit once R0 has real behaviour to scrub through.
- **Directive stack shape.** The patch editor UX is not yet specified, and its requirements will shape the `DirectiveStack` message in the protocol.
- **Multi-session continuity (R9).** Persistent civ memory and named events across sessions may impose storage requirements not yet captured here.
