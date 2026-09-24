// Diagnostic fixture generator. Loaded only by the opt-in Playwright probe.
import { NodeHost } from '../../host/node.js';
import { OPFSStorage } from '../../host/storage-opfs.js';
import { deserializeSnapshot } from '../../host/snapshot-codec.js';
import { restore } from '../../sim/state.js';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const measurements: Array<{ operation: string; key: string; bytes: number; ms: number }> = [];
class MeasuredStorage extends OPFSStorage {
  override async read(key: string): Promise<Uint8Array | null> {
    const start = performance.now();
    const data = await super.read(key);
    measurements.push({
      operation: 'read',
      key,
      bytes: data?.length ?? 0,
      ms: performance.now() - start,
    });
    return data;
  }
  override async write(key: string, data: Uint8Array): Promise<void> {
    const start = performance.now();
    await super.write(key, data);
    measurements.push({
      operation: 'write',
      key,
      bytes: data.length,
      ms: performance.now() - start,
    });
  }
  override async append(key: string, data: Uint8Array): Promise<void> {
    const start = performance.now();
    await super.append(key, data);
    measurements.push({
      operation: 'append',
      key,
      bytes: data.length,
      ms: performance.now() - start,
    });
  }
}

async function run(ticks: number): Promise<void> {
  const storage = new MeasuredStorage({ root: 'bobivolve' });
  const host = new NodeHost({
    heartbeatHz: 0,
    persistence: { storage, runId: 'browser-benchmark' },
  });
  const errors: string[] = [];
  host.subscribe((e) => {
    if (e.kind === 'commandError') errors.push(e.message);
  });
  host.send({ kind: 'newRun', commandId: 'new', seed: 42n });
  const started = performance.now();
  const growth: Array<{ tick: number; logBytes: number; snapshotBytes: number }> = [];
  async function runBytes(): Promise<{ logBytes: number; snapshotBytes: number }> {
    let snapshotBytes = 0;
    for (const entry of await storage.listEntries('runs/browser-benchmark/snapshots')) {
      if (entry.kind === 'file')
        snapshotBytes +=
          (await storage.read(`runs/browser-benchmark/snapshots/${entry.name}`))?.length ?? 0;
    }
    return {
      logBytes: (await storage.read('runs/browser-benchmark/log.ndjson'))?.length ?? 0,
      snapshotBytes,
    };
  }
  while ((host.currentTick() ?? 0n) < BigInt(ticks - 1)) {
    const target = Math.min(Number(host.currentTick() ?? 0n) + 250, ticks - 1);
    host.runUntil(BigInt(target));
    if (target % 5000 === 0) {
      await host.flush();
      growth.push({ tick: target, ...(await runBytes()) });
      ctx.postMessage({ progress: target });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const captureStart = performance.now();
  host.send({ kind: 'save', commandId: 'reference', slot: 'benchmark-reference' });
  const captureMs = performance.now() - captureStart;
  await host.flush();
  const saveAndFlushMs = performance.now() - captureStart;
  const reference = await storage.read('saves/benchmark-reference.save');
  if (reference === null) throw new Error('reference save missing');
  const decodeStart = performance.now();
  const restored = restore(deserializeSnapshot(reference));
  const decodeRestoreMs = performance.now() - decodeStart;
  host.runUntil(BigInt(ticks));
  host.send({ kind: 'pause', commandId: 'endpoint' });
  await host.flush();
  growth.push({ tick: ticks, ...(await runBytes()) });
  await storage.write('runs/.active', new TextEncoder().encode('browser-benchmark'));
  if (errors.length) throw new Error(errors.join('; '));
  ctx.postMessage({
    result: {
      ticks,
      seed: '42',
      cadence: 30000,
      population: restored.probes.size,
      lineages: restored.lineages.size,
      forwardAndMeasurementMs: performance.now() - started,
      captureMs,
      saveAndFlushMs,
      decodeRestoreMs,
      referenceBytes: reference.length,
      growth,
      operations: measurements,
    },
  });
}
ctx.onmessage = (event: MessageEvent<{ ticks: number }>) => {
  void run(event.data.ticks).catch((error: unknown) => ctx.postMessage({ error: String(error) }));
};
