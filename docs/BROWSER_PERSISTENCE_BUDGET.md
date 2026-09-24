# Browser persistence measurements and proposed budgets

Status: measured on 2026-09-24; budgets and retention policy proposed for review, not enforced by the app. Production snapshot cadence remains 30,000 ticks. The [filesystem benchmark](SNAPSHOT_BENCHMARK.md) covers the Node adapter separately.

## Reproduce

```sh
BOBIVOLVE_BENCH_TICKS=5000 \
BOBIVOLVE_BENCH_OUTPUT=test-results/browser-5000.json \
  scripts/browser-persistence-benchmark.sh
```

The default is 5,000 ticks; accepted diagnostic targets are 2–100,000. This opt-in `@diagnostic` Playwright test uses a fresh Chromium context, its own OPFS run, the production storage adapter and host, and the real dashboard. It cannot read or delete the user's normal browser storage. Its worker generates seed 42 in 250-tick chunks, flushes at 5,000-tick measurement points, and saves a reference at the target minus one. It records log/snapshot bytes and individual OPFS reads/writes/appends. The temporary browser context is removed after the test.

After preparation, reload restores the run through the production worker. The probe issues rewind through the dashboard store, measures command acknowledgement and the first rendered target tick with rehydrated lineage data, and saves the result through the production transport. The resulting full serialized state must exactly equal the reference. The visible timer begins at dispatch, excluding the confirmation dialog and human reaction time.

## Results

Baseline `7c26fa4`, Apple M4 Max, macOS arm64, Chromium 147.0.7727.15. One sample per endpoint; these are local observations, not percentiles or cross-device guarantees. Other applications were running on the workstation. Raw observations include all timings and byte counts:

|                                             Endpoint | Active run MiB | Reference capture ms | Save plus flush ms | Decode/restore ms | Reload visible seconds | Rewind visible seconds |
| ---------------------------------------------------: | -------------: | -------------------: | -----------------: | ----------------: | ---------------------: | ---------------------: |
|   [1,000](measurements/browser-1000-2026-09-24.json) |           0.38 |                  0.1 |                9.2 |               5.2 |                  0.388 |                  0.156 |
|   [5,000](measurements/browser-5000-2026-09-24.json) |           7.65 |                  0.5 |               67.8 |              56.0 |                  4.908 |                  4.333 |
| [30,000](measurements/browser-30000-2026-09-24.json) |          56.49 |                  1.6 |              143.6 |             186.4 |                  0.892 |                 50.264 |

All three full-state comparisons passed. The 30,000-tick log is 44.09 MiB and retained run snapshots are 12.40 MiB; the reference named save is a further 12.25 MiB. Run totals exclude named saves. Capture is the synchronous Save call; save-plus-flush includes queued work, encoding, the save index and pending log append, so it is not a pure snapshot-write metric. Decode/restore is measured separately against a warm readback.

Reload at 30,000 benefits from an exact cadence snapshot; rewind to 29,999 cannot use it and replays from tick zero. At 5,000 both reload and rewind reconstruct from zero. The large difference is consistent with replay distance, while the raw file operations are much shorter. These observations justify focusing on replay anchors and reconstruction cost before changing storage adapters.

Fixture generation uses an unpaced host without live dashboard event/render traffic and periodically flushes for measurement. Production normally flushes on pause and persistence operations. Consequently forward throughput, memory pressure, durability between pauses, and crash-loss windows are not measured. The rewind and reload paths do use the real dashboard and browser worker. This is Chromium-only, with warm OS/browser caches, one seed, no explicit disk sync, no quota-pressure test, and no mobile-hardware claim.

## Decisions for the next supported-session pass

1. **Initial validation envelope:** seed 42 through 5,000 ticks on the reference Chromium desktop. Use this as the next playtest session target; runs beyond it remain exploratory until a broader device/seed matrix is measured. This is not a new runtime cap. The 30,000-tick result fails the responsiveness target below.
2. **Latency targets:** reload or committed rewind should complete visibly within 5 seconds in a representative short session, with progress feedback visible immediately. Target a measured 95th percentile after collecting enough repeats on a slower reference device; the samples above do not establish that percentile. Keep pause acknowledgement under 250 ms in a separate live-load test. This probe does not certify pause performance.
3. **Storage targets:** 128 MiB per active run (log plus referenced snapshots) and 256 MiB per origin including named saves and other runs. Treat the smaller of this origin target and 50% of the browser's reported quota as the warning threshold. These are reviewable soft-budget choices, not promises about browser quota or current UI warnings.
4. **Retention:** keep the complete active command/event history and every named save. Never silently prune the history needed to explain or replay a player decision. Offer explicit deletion of whole inactive runs, as the existing run manager permits. Named-save deletion and budget warnings need UI work before the origin policy is enforceable. Do not automatically delete saves or the active run when a budget is exceeded.
5. **Snapshot tuning:** retain the current cadence in production. Next compare 1,000/5,000/10,000-tick cadences with bounded snapshot retention against the same near-boundary rewind target. Keep a valid anchor for every retained replay interval; full-log parse cost remains even with more snapshots. Adopt a cadence only when it meets both latency and storage targets. Snapshot pruning is not implemented by this PR.

The budgets deliberately separate a measured local envelope, proposed service targets, and missing enforcement. The queued work is maintained in [TODO.md](../TODO.md), not duplicated as a second implementation checklist here.
