# Snapshot persistence benchmark

Run `scripts/snapshot-benchmark.sh > snapshot-benchmark.ndjson` from any directory. Defaults: seed 42, 30,000 ticks, cadences 5,000 / 10,000 / 30,000, storage samples every 5,000 ticks. For a quick correctness smoke:

```sh
scripts/snapshot-benchmark.sh --ticks 100 --cadences 10,30,100 --sample-every 50
```

Use `--ticks`, `--cadences` (comma-separated), `--seed`, and `--sample-every` to vary the run. `--directory /existing/parent` selects the filesystem to measure; the script creates its own unique child directory there. `--keep` retains that child for inspection. Otherwise it removes only its own child, even on failure. Progress goes to stderr; stdout is NDJSON with environment, snapshot, growth, forward and summary records.

## What is measured

The canonical forward simulation runs once. Its domain events feed a separate production `EventLogWriter` for each cadence, backed by real `NodeStorage` files. Snapshots use the production capture/encode/write/read/decode/restore functions. The fixture records an initial `newRun` and tick-zero snapshot, then cadence snapshots; it has no interventions. This isolates persistence costs without adding instrumentation to the production host.

- `snapshot` records split capture, JSON encoding, awaited filesystem write, read, decoding, and restoration into maps/sets. The combined timers include the full corresponding operation. Every snapshot is checked against a reserialized full-state digest outside the timers.
- `growth` records cumulative log bytes (filesystem stat), snapshot bytes, total bytes, population and retained lineage count. `logFlushMs` includes event serialization, text encoding and filesystem append. Logs flush at sample intervals to bound memory, not according to the browser worker's wall-clock flush schedule.
- `summary` means exclude the tiny tick-zero snapshot; the snapshot time total includes it. These are measured totals for this run, not extrapolated per-100k costs. Each cadence has its own sample count and age distribution: a cadence with one late sample is not directly comparable to an average of several earlier, smaller snapshots.
- `rewindMs` times public `NodeHost.rewindToTick` plus `flush`: read and parse the entire log, choose/read/decode/restore a snapshot, replay, serialize/rewrite the retained log and acknowledge. It excludes host bootstrap, UI message delivery and rendering. The target is `ticks - 1`; `replayTicks` reports the actual distance from that cadence's latest snapshot, rather than assuming a full interval. The final state is saved and its digest compared with the canonical forward state, including PRNG and intervention fields.
- `forward.wallMs` includes shared simulation, all cadence fixtures, component readback/verification and measurement output. It is not a single production host's throughput or the sum of persistence costs.

## Limits and decision

These are local Node filesystem measurements with normal OS caching, no `fsync`, no cold-cache control and no OPFS. Immediate snapshot readbacks and host bootstrap warm the cache. Cadences execute sequentially in a fixed order; wall-clock values depend on JIT, GC, system load and hardware. Retain the environment record and raw samples when comparing runs. The benchmark does not measure browser input latency or durability after a crash.

Keep the production 30,000-tick cadence until browser OPFS measurements and player-visible rewind/storage budgets justify changing it. More frequent snapshots trade disk space and encoding work for less simulation replay; they do not bound the cost of reading the entire event log or retaining extinct lineage records. Browser persistence, supported session length and retention decisions remain in [TODO.md](../TODO.md).

## Recorded measurement

2026-09-23, simulation baseline `bb56f32`, command `scripts/snapshot-benchmark.sh`, Node v26.9.0 on darwin/arm64 (Apple M4 Max). [Raw NDJSON](measurements/snapshot-node-2026-09-23.ndjson) includes each component sample and all growth checkpoints. Other validation jobs ran on the workstation during this measurement; timings are exploratory observations under shared load, not a cadence ranking. In particular the 5,000-cadence rewind took longer than the 10,000 case despite replaying fewer ticks. Do not infer an optimum from that ordering.

| Cadence | Samples | Capture/encode/write mean (ms) | Read/decode/restore mean (ms) | Snapshot storage (MiB) | Log (MiB) | Rewind to 29,999 (s) | Replayed ticks |
| ------: | ------: | -----------------------------: | ----------------------------: | ---------------------: | --------: | -------------------: | -------------: |
|    5000 |       6 |                          200.2 |                         367.3 |                  49.52 |     44.09 |                42.51 |           4999 |
|   10000 |       3 |                          198.9 |                         186.6 |                  27.33 |     44.09 |                26.16 |           9999 |
|   30000 |       1 |                          248.5 |                         459.7 |                  12.40 |     44.09 |                65.18 |          29999 |

All three replayed states matched the canonical forward state byte-for-byte after serialization. By tick 30,000 the simulation held 5,981 probes and 24,039 lineage records. The event log grew from about 7.49 MiB at tick 5,000 to 44.09 MiB at tick 30,000; the tick-30,000 snapshot alone was 12.25 MiB. Retaining more frequent snapshots raised total stored bytes from about 56.49 MiB (30,000 cadence) to 93.61 MiB (5,000 cadence).

Full snapshot operations are hundreds of milliseconds in this sample, and complete rewinds are tens of seconds. The former in-memory-copy number around 1 ms is not an estimate of either operation. Repeat on an idle machine and in browser OPFS before making a tuning decision.

Browser OPFS and rendered rewind measurements are now recorded separately in [the browser budget report](BROWSER_PERSISTENCE_BUDGET.md). They do not change the production cadence.
