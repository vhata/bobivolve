// Snapshot-cadence microbenchmark.
//
// ARCHITECTURE.md flags the 30,000-tick snapshot cadence as a heuristic to
// tune once R0 has real behaviour to scrub through. This script measures
// the four quantities that govern the tradeoff:
//
//   1. snap-write-ms       — wall-clock ms per snapshot persistence call
//                            (serialise + write to storage).
//   2. bytes-per-snap      — payload size on disk (or in the in-memory
//                            store backing this bench).
//   3. replay-ms           — wall-clock ms to advance one full cadence's
//                            worth of ticks from a snapshot forward. This
//                            is the worst-case scrub cost the cadence
//                            governs: a rewind that lands between snaps
//                            replays at most this many ticks.
//   4. total-ms-per-100k   — derived: (snaps-per-100k * mean snap-write-ms)
//                            across a 100k-tick run. The snapshot tax
//                            across a long run.
//
// Output: a tab-separated table on stdout. NOT auto-collected by vitest —
// the test runner globs only *.test.ts / *.spec.ts.
//
// Run: `tsx test/bench/snapshot-cadence.ts` from the project root.
//
// Strategy: do ONE canonical forward sim from seed=42 to FORWARD_TICKS,
// taking a snapshot at every cadence-boundary tick. Snap-write costs and
// bytes are recorded per snap. Then for each cadence, derive:
//   - mean snap-write-ms / bytes-per-snap from snaps that land on that
//     cadence's boundaries (snaps land at multiples of cadence; the union
//     of all five cadences' boundaries is just "every 5_000 ticks", so a
//     single forward run with cadence-5000 captures them all).
//   - replay-ms: from a fresh NodeHost, restore the snap at tick
//     (FORWARD_TICKS - cadence), advance `cadence` ticks. This is the
//     worst-case scrub: a rewind landing one cadence past the latest
//     snap replays exactly this many ticks.
//
// Determinism: a fixed seed across runs keeps the simulation shape
// identical so snap sizes and replay times are comparable.

import type { Storage } from '../../sim/ports.js';
import { NodeHost } from '../../host/node.js';
import { deserializeSnapshot } from '../../host/snapshot-codec.js';
import { restore } from '../../sim/state.js';

const SEED = 42n;
// Distance the canonical forward sim runs to. The largest cadence we
// measure (100_000) defines the minimum useful forward distance for a
// representative replay-ms measurement; we extend that little further
// so snap-write samples for the larger cadences land at population
// scales like a real long session, not at tick-0.
const FORWARD_TICKS = 100_000n;
// Cadence values to bench. The 5_000-tick floor is also the forward-sim
// cadence — that captures every snap any of these values would write.
const CADENCES: readonly bigint[] = [5_000n, 10_000n, 30_000n, 60_000n, 100_000n];
const FORWARD_CADENCE = 5_000n;

// In-memory Storage with per-snapshot-write instrumentation. Captures
// elapsed wall-clock ms per `write` call where the key is a snapshot
// file (`runs/<id>/snapshots/<tick>.snap`), and the byte length of the
// payload. Other writes (log appends) are honoured but not timed —
// the bench only cares about snap-write cost.
class MeasuringMemoryStorage implements Storage {
  readonly data = new Map<string, Uint8Array>();
  readonly snapWriteMs = new Map<bigint, number>(); // tick → ms
  readonly snapBytes = new Map<bigint, number>(); // tick → bytes

  async read(key: string): Promise<Uint8Array | null> {
    return this.data.get(key) ?? null;
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    if (isSnapshotKey(key)) {
      const tick = snapshotKeyTick(key);
      const start = performance.now();
      // Copy semantics: NodeStorage's writeFile takes a snapshot of bytes
      // immediately. Mirror that here so we measure serialise + retain
      // costs, not just the Map.set call.
      const copy = new Uint8Array(data.length);
      copy.set(data);
      this.data.set(key, copy);
      const elapsed = performance.now() - start;
      this.snapWriteMs.set(tick, elapsed);
      this.snapBytes.set(tick, data.length);
    } else {
      this.data.set(key, data);
    }
  }

  async append(key: string, data: Uint8Array): Promise<void> {
    const existing = this.data.get(key);
    if (existing === undefined) {
      const copy = new Uint8Array(data.length);
      copy.set(data);
      this.data.set(key, copy);
      return;
    }
    const merged = new Uint8Array(existing.length + data.length);
    merged.set(existing, 0);
    merged.set(data, existing.length);
    this.data.set(key, merged);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

function isSnapshotKey(key: string): boolean {
  return key.startsWith('runs/') && key.includes('/snapshots/') && key.endsWith('.snap');
}

function snapshotKeyTick(key: string): bigint {
  const file = key.split('/').pop()!;
  return BigInt(file.slice(0, -'.snap'.length));
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

interface CadenceResult {
  readonly cadence: bigint;
  readonly snapSampleCount: number;
  readonly snapWriteMeanMs: number;
  readonly bytesPerSnapMean: number;
  readonly replayMs: number;
  readonly snapsPer100k: number;
  readonly totalPer100kMs: number;
}

async function main(): Promise<void> {
  // ── Warm-up ─────────────────────────────────────────────────────────────
  // First NodeHost spin-up pays JIT / module-init costs that would
  // otherwise inflate the canonical-run measurement.
  {
    const storage = new MeasuringMemoryStorage();
    const host = new NodeHost({
      heartbeatHz: 0,
      persistence: { storage, runId: 'warmup', snapshotCadenceTicks: 5_000n },
    });
    host.send({ kind: 'newRun', commandId: 'newRun-0', seed: SEED });
    host.runUntil(5_000n);
    await host.flush();
  }

  // ── Canonical forward run ───────────────────────────────────────────────
  // One sim from seed=SEED to FORWARD_TICKS with cadence = FORWARD_CADENCE
  // (5_000, the smallest cadence we measure — so it captures every snap
  // that any of the larger cadences would write).
  console.error(
    `[bench] canonical forward run: ${FORWARD_TICKS.toString()} ticks @ cadence ${FORWARD_CADENCE.toString()} ...`,
  );
  const forwardStart = performance.now();
  const forwardStorage = new MeasuringMemoryStorage();
  const forwardHost = new NodeHost({
    heartbeatHz: 0,
    persistence: {
      storage: forwardStorage,
      runId: 'forward',
      snapshotCadenceTicks: FORWARD_CADENCE,
    },
  });
  forwardHost.send({ kind: 'newRun', commandId: 'newRun-0', seed: SEED });
  forwardHost.runUntil(FORWARD_TICKS);
  await forwardHost.flush();
  console.error(`[bench] forward run done in ${(performance.now() - forwardStart).toFixed(0)} ms`);

  // ── Per-cadence measurement ────────────────────────────────────────────
  const results: CadenceResult[] = [];
  for (const cadence of CADENCES) {
    console.error(`[bench] cadence=${cadence.toString()} ...`);

    // Snap-write samples for this cadence: snaps at multiples of cadence
    // (skipping tick 0 — its size isn't representative of a fat-pop snap,
    // and ARCHITECTURE.md's heuristic targets the steady-state cost).
    const snapMsSamples: number[] = [];
    const snapByteSamples: number[] = [];
    let tick = cadence;
    while (tick <= FORWARD_TICKS) {
      const ms = forwardStorage.snapWriteMs.get(tick);
      const bytes = forwardStorage.snapBytes.get(tick);
      if (ms !== undefined && bytes !== undefined) {
        snapMsSamples.push(ms);
        snapByteSamples.push(bytes);
      }
      tick += cadence;
    }
    const snapWriteMeanMs = mean(snapMsSamples);
    const bytesPerSnapMean = mean(snapByteSamples);

    // Replay-ms: restore the snap at (FORWARD_TICKS - cadence), advance
    // `cadence` ticks forward, time the advance. This is the worst-case
    // scrub: a rewind landing one cadence past the latest snap walks
    // exactly this many ticks. The replay host is a fresh NodeHost with
    // no persistence — we don't care about log-write costs during the
    // replay, only the tick-advance cost.
    const replaySnapTick = FORWARD_TICKS - cadence;
    const replaySnapKey = `runs/forward/snapshots/${replaySnapTick.toString()}.snap`;
    const snapBytes = forwardStorage.data.get(replaySnapKey);
    if (snapBytes === undefined) {
      throw new Error(`bench setup: no snapshot at tick ${replaySnapTick.toString()}`);
    }
    const snap = deserializeSnapshot(snapBytes);
    const replayHost = new NodeHost({ heartbeatHz: 0 });
    // Inject restored state directly. NodeHost has no public restore
    // entrypoint outside the Load path (which is async and goes through
    // storage); reaching into the private `state` field is the
    // bench-only shortcut. The alternative would be plumbing a
    // restoreFromSnapshot() method into the host purely for this
    // bench, which the user would rightly object to.
    (replayHost as unknown as { state: ReturnType<typeof restore> }).state = restore(snap);
    const replayStart = performance.now();
    replayHost.runUntil(FORWARD_TICKS);
    const replayMs = performance.now() - replayStart;

    const snapsPer100k = Number(100_000n / cadence);
    const totalPer100kMs = snapsPer100k * snapWriteMeanMs;

    results.push({
      cadence,
      snapSampleCount: snapMsSamples.length,
      snapWriteMeanMs,
      bytesPerSnapMean,
      replayMs,
      snapsPer100k,
      totalPer100kMs,
    });
  }

  // ── Output ──────────────────────────────────────────────────────────────
  const header = [
    'cadence',
    'snap-samples',
    'snap-write-ms-mean',
    'bytes-per-snap-mean',
    'replay-ms',
    'snaps-per-100k',
    'total-ms-per-100k',
  ].join('\t');
  const body = results
    .map((r) =>
      [
        r.cadence.toString(),
        r.snapSampleCount.toString(),
        r.snapWriteMeanMs.toFixed(3),
        r.bytesPerSnapMean.toFixed(0),
        r.replayMs.toFixed(1),
        r.snapsPer100k.toString(),
        r.totalPer100kMs.toFixed(1),
      ].join('\t'),
    )
    .join('\n');
  // Stdout is the consumable table. Progress notes go to stderr above so
  // a `> table.tsv` capture stays clean.
  process.stdout.write(header + '\n' + body + '\n');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
