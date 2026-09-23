// Filesystem persistence benchmark; see docs/SNAPSHOT_BENCHMARK.md.
// Uses the production simulation, codecs, log writer and storage adapter.
// Reconstruction is exercised through public NodeHost commands.
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { EventLogWriter } from '../../host/event-log.js';
import { NodeHost } from '../../host/node.js';
import { deserializeSnapshot, serializeSnapshot } from '../../host/snapshot-codec.js';
import { NodeStorage } from '../../host/storage-node.js';
import type { SimEvent } from '../../protocol/types.js';
import { createInitialState, restore, snapshot, type SimState } from '../../sim/state.js';
import { tick } from '../../sim/step.js';
import { Seed } from '../../sim/types.js';

const { values } = parseArgs({
  options: {
    ticks: { type: 'string', default: '30000' },
    cadences: { type: 'string', default: '5000,10000,30000' },
    seed: { type: 'string', default: '42' },
    'sample-every': { type: 'string', default: '5000' },
    directory: { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});

function positive(value: string, name: string): bigint {
  if (!/^[0-9]+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${name} must be a positive decimal integer`);
  }
  return BigInt(value);
}

const ticks = positive(values.ticks!, 'ticks');
if (ticks < 2n) throw new Error('ticks must be at least 2');
const cadences = [...new Set(values.cadences!.split(',').map((v) => positive(v, 'cadence')))];
if (cadences.some((v) => v > ticks)) throw new Error('each cadence must be <= ticks');
const sampleEvery = positive(values['sample-every']!, 'sample-every');
if (!/^[0-9]+$/.test(values.seed!) || BigInt(values.seed!) > (1n << 64n) - 1n) {
  throw new Error('seed must be a decimal uint64');
}
const seed = BigInt(values.seed!);

function emit(record: object): void {
  process.stdout.write(
    JSON.stringify(record, (_, v: unknown) => (typeof v === 'bigint' ? String(v) : v)) + '\n',
  );
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface SnapshotSample {
  tick: bigint;
  bytes: number;
  captureMs: number;
  encodeMs: number;
  writeMs: number;
  captureEncodeWriteMs: number;
  readMs: number;
  decodeMs: number;
  restoreMs: number;
  readDecodeRestoreMs: number;
}

interface Run {
  cadence: bigint;
  id: string;
  log: EventLogWriter;
  samples: SnapshotSample[];
  logFlushMs: number;
  snapshotBytes: number;
}

async function measureSnapshot(state: SimState, run: Run, storage: NodeStorage): Promise<void> {
  const key = `runs/${run.id}/snapshots/${state.simTick}.snap`;
  const begin = performance.now();
  const snap = snapshot(state);
  const captured = performance.now();
  const bytes = serializeSnapshot(snap);
  const encoded = performance.now();
  await storage.write(key, bytes);
  const written = performance.now();
  run.log.appendSnap(state.simTick, key);

  const readStart = performance.now();
  const readBytes = await storage.read(key);
  const readEnd = performance.now();
  if (readBytes === null) throw new Error(`Missing snapshot ${key}`);
  const decoded = deserializeSnapshot(readBytes);
  const decodeEnd = performance.now();
  const restored = restore(decoded);
  const restoreEnd = performance.now();
  // Verification is outside all timers. Compare all state, including PRNG.
  if (digest(serializeSnapshot(snapshot(restored))) !== digest(bytes)) {
    throw new Error(`Snapshot round-trip differs at ${state.simTick}`);
  }
  const sample: SnapshotSample = {
    tick: state.simTick,
    bytes: bytes.length,
    captureMs: captured - begin,
    encodeMs: encoded - captured,
    writeMs: written - encoded,
    captureEncodeWriteMs: written - begin,
    readMs: readEnd - readStart,
    decodeMs: decodeEnd - readEnd,
    restoreMs: restoreEnd - decodeEnd,
    readDecodeRestoreMs: restoreEnd - readStart,
  };
  run.samples.push(sample);
  run.snapshotBytes += bytes.length;
  emit({ kind: 'snapshot', cadence: run.cadence, ...sample });
}

async function flushLog(run: Run): Promise<void> {
  const start = performance.now();
  await run.log.flush();
  run.logFlushMs += performance.now() - start;
}

async function main(): Promise<void> {
  // mkdtemp never reuses or deletes a caller-owned directory. --directory
  // selects the parent filesystem; only this generated child is removed.
  const root = await mkdtemp(join(values.directory ?? tmpdir(), 'bobivolve-benchmark-'));
  emit({
    kind: 'environment',
    root,
    seed,
    ticks,
    cadences,
    sampleEvery,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model,
    storage: 'NodeStorage; OS cache; no fsync',
  });
  try {
    const storage = new NodeStorage({ root });
    const state = createInitialState(Seed(seed));
    const runs: Run[] = cadences.map((cadence) => {
      const id = `cadence-${cadence}`;
      const log = new EventLogWriter(storage, `runs/${id}/log.ndjson`);
      log.appendCommand(0n, { kind: 'newRun', commandId: 'benchmark-new', seed });
      return { cadence, id, log, samples: [], logFlushMs: 0, snapshotBytes: 0 };
    });
    for (const run of runs) await measureSnapshot(state, run, storage);

    // One canonical forward simulation supplies identical events/state to
    // each cadence. Flush in bounded batches; do not retain the full log.
    let expectedRewindDigest = '';
    const forwardStart = performance.now();
    while (state.simTick < ticks) {
      const events: SimEvent[] = [];
      tick(state, events);
      for (const run of runs) {
        for (const event of events) run.log.appendEvent(state.simTick, event);
        if (state.simTick % run.cadence === 0n) await measureSnapshot(state, run, storage);
        if (state.simTick % sampleEvery === 0n || state.simTick === ticks) {
          await flushLog(run);
          const logBytes = (await stat(storage.pathFor(`runs/${run.id}/log.ndjson`))).size;
          emit({
            kind: 'growth',
            cadence: run.cadence,
            tick: state.simTick,
            population: state.probes.size,
            lineages: state.lineages.size,
            logBytes,
            snapshotBytes: run.snapshotBytes,
            totalBytes: logBytes + run.snapshotBytes,
            logFlushMs: run.logFlushMs,
          });
        }
      }
      if (state.simTick === ticks - 1n) {
        expectedRewindDigest = digest(serializeSnapshot(snapshot(state)));
      }
      if (state.simTick % sampleEvery === 0n)
        console.error(`[bench] forward tick ${state.simTick}`);
    }
    emit({ kind: 'forward', wallMs: performance.now() - forwardStart });

    for (const run of runs) {
      // Guarantee the log head even if the final tick emitted no events.
      run.log.appendCommand(ticks, { kind: 'pause', commandId: 'benchmark-end' });
      await flushLog(run);
      const host = new NodeHost({ heartbeatHz: 0, persistence: { storage, runId: 'empty' } });
      const failures: string[] = [];
      const acknowledged = new Set<string>();
      host.subscribe((event) => {
        if (event.kind === 'commandError') failures.push(event.message);
        if (event.kind === 'commandAck') acknowledged.add(event.commandId);
      });
      // Bootstrap is excluded. The timed rewind then reads the entire log,
      // selects/decodes/restores its anchor, replays, and rewrites the log.
      host.send({ kind: 'switchRun', commandId: 'open', runId: run.id });
      await host.flush();
      if (!acknowledged.has('open') || host.currentTick() !== ticks) {
        throw new Error(`Bootstrap failed: ${failures.join('; ')}`);
      }
      const target = ticks - 1n;
      const start = performance.now();
      host.send({ kind: 'rewindToTick', commandId: 'rewind', tick: target });
      await host.flush();
      const rewindMs = performance.now() - start;
      if (!acknowledged.has('rewind') || failures.length || host.currentTick() !== target) {
        throw new Error(`Rewind failed: ${failures.join('; ')}`);
      }
      host.send({ kind: 'save', commandId: 'verify', slot: 'benchmark-verify' });
      await host.flush();
      const verification = await storage.read('saves/benchmark-verify.save');
      if (
        !acknowledged.has('verify') ||
        verification === null ||
        digest(verification) !== expectedRewindDigest
      ) {
        throw new Error(`Replayed state differs for cadence ${run.cadence}`);
      }
      const periodic = run.samples.filter((s) => s.tick > 0n);
      const mean = (key: keyof Omit<SnapshotSample, 'tick'>): number =>
        periodic.reduce((total, s) => total + s[key], 0) / periodic.length;
      emit({
        kind: 'summary',
        cadence: run.cadence,
        periodicSamples: periodic.length,
        captureEncodeWriteMeanMs: mean('captureEncodeWriteMs'),
        readDecodeRestoreMeanMs: mean('readDecodeRestoreMs'),
        bytesPerSnapshotMean: mean('bytes'),
        snapshotCaptureEncodeWriteTotalMs: run.samples.reduce(
          (sum, s) => sum + s.captureEncodeWriteMs,
          0,
        ),
        logFlushMs: run.logFlushMs,
        rewindTarget: target,
        replayTicks: target % run.cadence,
        rewindMs,
        replayStateVerified: true,
      });
    }
  } finally {
    if (!values.keep) await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
